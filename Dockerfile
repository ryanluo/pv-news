FROM node:22-slim
RUN apt-get update && apt-get install -y curl python3 && \
    curl -sSL https://sdk.cloud.google.com | bash -s -- --disable-prompts --install-dir=/opt && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
ENV PATH="/opt/google-cloud-sdk/bin:${PATH}"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.js .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "index.js"]
