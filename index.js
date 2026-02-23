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
  <link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Baloo 2', system-ui, sans-serif; background: linear-gradient(135deg, #fce4ec 0%, #f8bbd0 50%, #f48fb1 100%); color: #4a1942; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    form { background: #fff0f5; padding: 2rem; border-radius: 20px; width: 340px; box-shadow: 0 8px 30px rgba(233, 30, 99, 0.15); border: 2px solid #f8bbd0; }
    h1 { color: #e91e63; margin-bottom: 1.5rem; font-size: 1.5rem; text-align: center; letter-spacing: 1px; }
    label { display: block; font-size: .9rem; color: #ad1457; margin-bottom: .25rem; font-weight: 500; }
    input { width: 100%; padding: .6rem; border: 2px solid #f8bbd0; border-radius: 12px; background: #fff; color: #4a1942; font-size: 1rem; margin-bottom: 1rem; font-family: inherit; }
    input:focus { outline: none; border-color: #e91e63; box-shadow: 0 0 0 3px rgba(233, 30, 99, 0.15); }
    button { width: 100%; background: linear-gradient(135deg, #ec407a, #e91e63); color: #fff; border: none; padding: .7rem; border-radius: 12px; cursor: pointer; font-weight: 700; font-size: 1rem; font-family: inherit; transition: transform 0.1s; }
    button:hover { transform: scale(1.03); background: linear-gradient(135deg, #f06292, #ec407a); }
    .error { color: #c62828; font-size: .85rem; text-align: center; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <form method="POST" action="/login">
    <h1>PV News ~</h1>
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
  <link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@400;500;700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Baloo 2', system-ui, sans-serif; background: linear-gradient(180deg, #fce4ec 0%, #fff0f5 100%); color: #4a1942; padding: 1.5rem; max-width: 960px; margin: 0 auto; min-height: 100vh; }
    h1 { margin-bottom: .5rem; color: #e91e63; font-size: 2rem; letter-spacing: 1px; }
    .meta { color: #ad1457; font-size: .9rem; margin-bottom: 1.5rem; opacity: 0.8; }
    button { background: linear-gradient(135deg, #ec407a, #e91e63); color: #fff; border: none; padding: .5rem 1.2rem; border-radius: 14px; cursor: pointer; font-weight: 700; font-family: inherit; font-size: .95rem; transition: transform 0.1s; }
    button:hover { transform: scale(1.04); background: linear-gradient(135deg, #f06292, #ec407a); }
    .card { background: #fff; border-radius: 14px; padding: .85rem 1rem; margin-bottom: .6rem; display: flex; gap: .75rem; align-items: flex-start; box-shadow: 0 2px 8px rgba(233, 30, 99, 0.08); border: 1px solid #f8bbd0; transition: transform 0.1s; }
    .card:hover { transform: translateY(-1px); box-shadow: 0 4px 14px rgba(233, 30, 99, 0.13); }
    .badge { font-size: .7rem; font-weight: 700; padding: .2rem .5rem; border-radius: 8px; white-space: nowrap; flex-shrink: 0; margin-top: .15rem; }
    .badge.reddit { background: #ff6f61; color: #fff; }
    .badge.reddit_comment { background: #f48fb1; color: #fff; }
    .badge.x { background: #ce93d8; color: #fff; }
    .card-body { min-width: 0; }
    .card a { color: #c2185b; text-decoration: none; font-weight: 500; }
    .card a:hover { text-decoration: underline; color: #e91e63; }
    .card .info { color: #ad1457; font-size: .8rem; margin-top: .3rem; opacity: 0.7; }
    .empty { color: #e91e63; font-style: italic; opacity: 0.6; }
    #status { color: #ad1457; font-size: .85rem; margin-left: .75rem; }
  </style>
</head>
<body>
  <h1>Puerto Vallarta News ~ #saveourbabes</h1>
  <p class="meta">scooping the latest from Reddit & X every ${POLL_INTERVAL_MINUTES} min</p>
  <button onclick="refresh()">Refresh Now</button><span id="status"></span>
  <a href="/logout" style="float:right;color:#ad1457;font-size:.85rem;margin-top:.3rem;display:inline-block;opacity:0.6">logout</a>

  <iframe id="bgmusic" width="0" height="0" style="position:absolute;top:-9999px" src="https://www.youtube.com/embed/8HBcV0MtAQg?autoplay=1&loop=1&playlist=8HBcV0MtAQg" allow="autoplay" frameborder="0"></iframe>

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
