import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import cron from "node-cron";
import Database from "better-sqlite3";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3001;
const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN;
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "pvnews";

// ─── Session Auth ───────────────────────────────────────────────────────────

/** @type {Set<string>} */
const sessions = new Set();

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const pair of header.split(";")) {
    const [k, ...v] = pair.split("=");
    cookies[k.trim()] = v.join("=").trim();
  }
  return cookies;
}

function requireAuth(req, res, next) {
  const token = parseCookies(req.headers.cookie).session;
  if (token && sessions.has(token)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "unauthorized" });
  res.redirect("/login");
}

app.get("/login", (_req, res) => {
  res.type("html").send(/* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PV News - Login</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    form { background: #1e293b; padding: 2rem; border-radius: 8px; width: 320px; }
    h1 { color: #38bdf8; margin-bottom: 1.5rem; font-size: 1.25rem; text-align: center; }
    label { display: block; font-size: .85rem; color: #94a3b8; margin-bottom: .25rem; }
    input { width: 100%; padding: .5rem; border: 1px solid #334155; border-radius: 4px; background: #0f172a; color: #e2e8f0; font-size: 1rem; margin-bottom: 1rem; }
    button { width: 100%; background: #38bdf8; color: #0f172a; border: none; padding: .6rem; border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 1rem; }
    button:hover { background: #7dd3fc; }
    .error { color: #f87171; font-size: .85rem; text-align: center; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <form method="POST" action="/login">
    <h1>PV News</h1>
    ${`<p class="error" id="err"></p>`}
    <label for="password">Password</label>
    <input type="password" name="password" id="password" autofocus required>
    <button type="submit">Log in</button>
  </form>
  <script>
    if (location.search.includes("error=1")) document.getElementById("err").textContent = "Wrong password.";
  </script>
</body>
</html>`);
});

app.post("/login", (req, res) => {
  if (req.body.password !== AUTH_PASSWORD) {
    return res.redirect("/login?error=1");
  }
  const token = crypto.randomBytes(32).toString("hex");
  sessions.add(token);
  res.setHeader("Set-Cookie", `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`);
  res.redirect("/");
});

app.get("/logout", (req, res) => {
  const token = parseCookies(req.headers.cookie).session;
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", "session=; HttpOnly; Path=/; Max-Age=0");
  res.redirect("/login");
});

// All routes below require auth
app.use(requireAuth);
const POLL_INTERVAL_MINUTES = parseInt(process.env.POLL_INTERVAL_MINUTES || "15", 10);
const REDDIT_SUBREDDITS = (process.env.REDDIT_SUBREDDITS || "puertovallarta,mexico,travel").split(",");
const REDDIT_PRIMARY_SUB = "puertovallarta"; // direct polling (no search), also poll all comments

// ─── SQLite Setup ───────────────────────────────────────────────────────────

const db = new Database(process.env.DB_PATH || "pv-news.db");
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,        -- 'reddit' or 'x'
    title TEXT,
    body TEXT,
    url TEXT,
    author TEXT,
    score INTEGER DEFAULT 0,
    subreddit TEXT,
    permalink TEXT,
    metrics TEXT,                -- JSON string for X metrics
    created_at TEXT NOT NULL,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_source ON posts(source)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC)`);

const insertPost = db.prepare(`
  INSERT OR IGNORE INTO posts (id, source, title, body, url, author, score, subreddit, permalink, metrics, created_at)
  VALUES (@id, @source, @title, @body, @url, @author, @score, @subreddit, @permalink, @metrics, @created_at)
`);

const selectBySource = db.prepare(`SELECT * FROM posts WHERE source = ? ORDER BY created_at DESC LIMIT 200`);
const selectAll = db.prepare(`SELECT * FROM posts ORDER BY created_at DESC LIMIT 400`);
const countBySource = db.prepare(`SELECT source, COUNT(*) as count FROM posts GROUP BY source`);

// ─── Reddit Poller ──────────────────────────────────────────────────────────

async function pollReddit() {
  console.log("[reddit] polling...");
  let inserted = 0;

  const fetchHeaders = { "User-Agent": "pv-news-aggregator/1.0" };

  // 1. Primary subreddit: fetch /new directly (no search lag)
  try {
    const url = `https://www.reddit.com/r/${REDDIT_PRIMARY_SUB}/new.json?limit=25`;
    const res = await fetch(url, { headers: fetchHeaders });
    if (res.ok) {
      const data = await res.json();
      for (const child of data?.data?.children ?? []) {
        const d = child.data;
        const result = insertPost.run({
          id: `reddit_${d.id}`,
          source: "reddit",
          title: d.title,
          body: d.selftext || null,
          url: d.url,
          author: d.author,
          score: d.score,
          subreddit: d.subreddit,
          permalink: `https://www.reddit.com${d.permalink}`,
          metrics: null,
          created_at: new Date(d.created_utc * 1000).toISOString(),
        });
        if (result.changes > 0) inserted++;
      }
    }
  } catch (err) {
    console.error(`[reddit] error fetching r/${REDDIT_PRIMARY_SUB}/new:`, err.message);
  }

  // 2. Other subreddits: search for "puerto vallarta"
  const searchSubs = REDDIT_SUBREDDITS.filter((s) => s !== REDDIT_PRIMARY_SUB);
  for (const subreddit of searchSubs) {
    const url = `https://www.reddit.com/r/${subreddit}/search.json?q=puerto+vallarta&sort=new&restrict_sr=on&limit=25`;
    try {
      const res = await fetch(url, { headers: fetchHeaders });
      if (!res.ok) {
        console.error(`[reddit] r/${subreddit} returned ${res.status}`);
        continue;
      }
      const data = await res.json();
      for (const child of data?.data?.children ?? []) {
        const d = child.data;
        const result = insertPost.run({
          id: `reddit_${d.id}`,
          source: "reddit",
          title: d.title,
          body: d.selftext || null,
          url: d.url,
          author: d.author,
          score: d.score,
          subreddit: d.subreddit,
          permalink: `https://www.reddit.com${d.permalink}`,
          metrics: null,
          created_at: new Date(d.created_utc * 1000).toISOString(),
        });
        if (result.changes > 0) inserted++;
      }
    } catch (err) {
      console.error(`[reddit] error fetching r/${subreddit}:`, err.message);
    }
  }

  console.log(`[reddit] done — ${inserted} new posts inserted`);

  // 3. Fetch all new comments from the primary subreddit
  await pollSubredditComments();
}

async function pollSubredditComments() {
  // r/subreddit/comments.json returns the latest comments across ALL posts in the sub
  const url = `https://www.reddit.com/r/${REDDIT_PRIMARY_SUB}/comments.json?limit=100`;
  let inserted = 0;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "pv-news-aggregator/1.0" },
    });
    if (!res.ok) {
      console.error(`[reddit] r/${REDDIT_PRIMARY_SUB}/comments returned ${res.status}`);
      return;
    }
    const data = await res.json();
    for (const child of data?.data?.children ?? []) {
      if (child.kind !== "t1") continue;
      const c = child.data;
      if (!c.body || c.body === "[deleted]" || c.body === "[removed]") continue;
      const result = insertPost.run({
        id: `reddit_comment_${c.id}`,
        source: "reddit_comment",
        title: null,
        body: c.body,
        url: null,
        author: c.author,
        score: c.score,
        subreddit: c.subreddit,
        permalink: `https://www.reddit.com${c.permalink}`,
        metrics: JSON.stringify({ link_id: c.link_id, link_title: c.link_title }),
        created_at: new Date(c.created_utc * 1000).toISOString(),
      });
      if (result.changes > 0) inserted++;
    }
  } catch (err) {
    console.error(`[reddit] error fetching comments:`, err.message);
  }

  console.log(`[reddit] ${inserted} new comments from r/${REDDIT_PRIMARY_SUB}`);
}

// ─── X (Twitter) Poller ─────────────────────────────────────────────────────

async function pollX() {
  if (!X_BEARER_TOKEN) {
    console.warn("[x] skipping — no X_BEARER_TOKEN set");
    return;
  }

  console.log("[x] polling...");
  let inserted = 0;

  const query = encodeURIComponent("puerto vallarta");
  const url = `https://api.x.com/2/tweets/search/recent?query=${query}&sort_order=relevancy&max_results=100&tweet.fields=created_at,public_metrics,author_id`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` },
    });
    if (!res.ok) {
      console.error(`[x] returned ${res.status}: ${await res.text()}`);
      return;
    }
    const data = await res.json();
    for (const tweet of data?.data ?? []) {
      const result = insertPost.run({
        id: `x_${tweet.id}`,
        source: "x",
        title: null,
        body: tweet.text,
        url: `https://x.com/i/status/${tweet.id}`,
        author: tweet.author_id,
        score: 0,
        subreddit: null,
        permalink: null,
        metrics: JSON.stringify(tweet.public_metrics || {}),
        created_at: new Date(tweet.created_at).toISOString(),
      });
      if (result.changes > 0) inserted++;
    }
  } catch (err) {
    console.error("[x] error:", err.message);
  }

  console.log(`[x] done — ${inserted} new posts inserted`);
}

// ─── Combined poll ──────────────────────────────────────────────────────────

async function pollAll() {
  await Promise.allSettled([pollReddit(), pollX()]);
}

// ─── Express Routes ─────────────────────────────────────────────────────────

/** Format a DB row for JSON output */
function formatPost(row) {
  return {
    ...row,
    metrics: row.metrics ? JSON.parse(row.metrics) : null,
  };
}

app.get("/api/reddit", (_req, res) => {
  const posts = selectBySource.all("reddit").map(formatPost);
  res.json({ count: posts.length, posts });
});

app.get("/api/x", (_req, res) => {
  const posts = selectBySource.all("x").map(formatPost);
  res.json({ count: posts.length, posts });
});

app.get("/api/all", (_req, res) => {
  const posts = selectAll.all().map(formatPost);
  res.json({ count: posts.length, posts });
});

app.post("/api/refresh", async (_req, res) => {
  await pollAll();
  const counts = Object.fromEntries(countBySource.all().map((r) => [r.source, r.count]));
  res.json({ ok: true, ...counts });
});

// ─── HTML Dashboard ─────────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.type("html").send(/* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PV News</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 1rem; max-width: 960px; margin: 0 auto; }
    h1 { margin-bottom: .5rem; color: #38bdf8; }
    .meta { color: #94a3b8; font-size: .85rem; margin-bottom: 1.5rem; }
    button { background: #38bdf8; color: #0f172a; border: none; padding: .5rem 1rem; border-radius: 4px; cursor: pointer; font-weight: 600; }
    button:hover { background: #7dd3fc; }
    .card { background: #1e293b; border-radius: 6px; padding: .75rem 1rem; margin-bottom: .5rem; display: flex; gap: .75rem; align-items: flex-start; }
    .badge { font-size: .7rem; font-weight: 700; padding: .15rem .4rem; border-radius: 3px; white-space: nowrap; flex-shrink: 0; margin-top: .1rem; }
    .badge.reddit { background: #ff4500; color: #fff; }
    .badge.reddit_comment { background: #ff6634; color: #fff; }
    .badge.x { background: #1d9bf0; color: #fff; }
    .card-body { min-width: 0; }
    .card a { color: #38bdf8; text-decoration: none; }
    .card a:hover { text-decoration: underline; }
    .card .info { color: #94a3b8; font-size: .8rem; margin-top: .25rem; }
    .empty { color: #64748b; font-style: italic; }
    #status { color: #94a3b8; font-size: .85rem; margin-left: .75rem; }
  </style>
</head>
<body>
  <h1>Puerto Vallarta News</h1>
  <p class="meta">Aggregating from Reddit & X &mdash; polls every ${POLL_INTERVAL_MINUTES} min</p>
  <button onclick="refresh()">Refresh Now</button><span id="status"></span>
  <a href="/logout" style="float:right;color:#94a3b8;font-size:.85rem;margin-top:.3rem;display:inline-block">Logout</a>

  <div id="feed" style="margin-top:1.5rem"><p class="empty">Loading...</p></div>

  <script>
    async function load() {
      const { posts } = await fetch("/api/all").then(r => r.json());
      renderFeed(posts);
    }

    function renderFeed(posts) {
      const el = document.getElementById("feed");
      if (!posts.length) { el.innerHTML = '<p class="empty">No posts yet.</p>'; return; }
      el.innerHTML = posts.map(p => {
        if (p.source === "reddit") return renderRedditCard(p);
        if (p.source === "reddit_comment") return renderCommentCard(p);
        return renderXCard(p);
      }).join("");
    }

    function renderRedditCard(p) {
      return \`<div class="card">
        <span class="badge reddit">Reddit</span>
        <div class="card-body">
          <a href="\${p.permalink}" target="_blank">\${esc(p.title)}</a>
          <div class="info">r/\${p.subreddit} &middot; u/\${p.author} &middot; score \${p.score} &middot; \${ago(p.created_at)}</div>
        </div>
      </div>\`;
    }

    function renderCommentCard(p) {
      return \`<div class="card">
        <span class="badge reddit_comment">Comment</span>
        <div class="card-body">
          <a href="\${p.permalink}" target="_blank">\${esc(p.body?.slice(0, 300))}\${(p.body?.length ?? 0) > 300 ? "..." : ""}</a>
          <div class="info">r/\${p.subreddit} &middot; u/\${p.author} &middot; score \${p.score} &middot; \${ago(p.created_at)}</div>
        </div>
      </div>\`;
    }

    function renderXCard(p) {
      return \`<div class="card">
        <span class="badge x">X</span>
        <div class="card-body">
          <a href="\${p.url}" target="_blank">\${esc(p.body)}</a>
          <div class="info">\${ago(p.created_at)} &middot; \${p.metrics?.like_count ?? 0} likes &middot; \${p.metrics?.retweet_count ?? 0} RTs</div>
        </div>
      </div>\`;
    }

    function esc(s) { const d = document.createElement("div"); d.textContent = s || ""; return d.innerHTML; }
    function ago(d) {
      const s = Math.floor((Date.now() - new Date(d)) / 1000);
      if (s < 60) return s + "s ago";
      if (s < 3600) return Math.floor(s/60) + "m ago";
      if (s < 86400) return Math.floor(s/3600) + "h ago";
      return Math.floor(s/86400) + "d ago";
    }

    async function refresh() {
      const st = document.getElementById("status");
      st.textContent = "refreshing...";
      await fetch("/api/refresh", { method: "POST" });
      await load();
      st.textContent = "done!";
      setTimeout(() => st.textContent = "", 2000);
    }

    load();
  </script>
</body>
</html>`);
});

// ─── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`PV News running at http://localhost:${PORT}`);
  pollAll();
  cron.schedule(`*/${POLL_INTERVAL_MINUTES} * * * *`, pollAll);
});
