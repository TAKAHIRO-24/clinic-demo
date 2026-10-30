'use strict';
// 起動の入口。設定は環境変数から受け取ります（Kubernetes の ConfigMap / Secret から渡されます）。
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('./app');
const { createRepo } = require('./db');

const env = process.env;
const repo = createRepo({
  host: env.DB_HOST || 'localhost',
  port: Number(env.DB_PORT) || 5432,
  database: env.DB_NAME || 'clinic',
  user: env.DB_USER || 'clinic',
  password: env.DB_PASSWORD || '',
});
const version = env.APP_VERSION || 'dev';
const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const server = createServer({ repo, version, indexHtml });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function migrateWithRetry() {
  // DBが先に起動していなくても、アプリは落ちずに待ちます（起動順を気にしなくてよい）。
  for (;;) {
    try {
      await repo.migrate();
      console.log('DBの準備ができました');
      return;
    } catch (e) {
      console.error('DBに接続できないため、3秒後に再試行します:', e.message);
      await sleep(3000);
    }
  }
}

server.listen(Number(env.PORT) || 3000, () => {
  console.log(`起動しました version=${version}`);
  migrateWithRetry();
});

// Kubernetes が Pod を止めるときに届く SIGTERM を受け取り、処理中のリクエストを終えてから終了します。
function shutdown() {
  console.log('SIGTERM を受信。終了処理を開始します');
  server.close(async () => {
    await repo.close().catch(() => {});
    process.exit(0);
  });
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
