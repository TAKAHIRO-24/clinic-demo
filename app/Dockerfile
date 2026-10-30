# --- 部品の用意（ここまでは共通） ---
FROM node:20-alpine AS base
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

# --- テスト用：ここで失敗するとイメージは作られません ---
FROM base AS test
COPY . .
RUN npm test

# --- 本番用：テストのファイルは含めません ---
FROM base AS runtime
ARG APP_VERSION=dev
ENV NODE_ENV=production APP_VERSION=${APP_VERSION}
COPY app.js db.js main.js ./
COPY public ./public
USER node
EXPOSE 3000
CMD ["node", "main.js"]
