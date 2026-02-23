FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.js .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "index.js"]
