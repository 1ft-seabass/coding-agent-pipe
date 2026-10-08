/**
 * index.js - エントリポイント
 *
 * Hono サーバーを起動し、各モジュールを組み立てる。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serve } from '@hono/node-server';
import { packageJson } from './package-info.js';
import { loadAdapter } from './adapters/index.js';
import { createSource } from './core/sources/index.js';
import { createApiRouter, cleanupOldAttachments } from './core/api.js';
import { setupSubscribers } from './core/deliver.js';
import { getManagedProcesses, processEvents } from './core/process.js';
import { cancel } from './core/canceller.js';
import { setupMqttReceiver } from './core/mqtt-receiver.js';
import { parseSize, jsonBodyParser, BadRequestError, safeEqual } from './core/http-utils.js';

// 設定を読み込む
let config;
try {
  config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
} catch (error) {
  console.error(`[index] Failed to load config.json: ${error.message}`);
  console.error('[index] config.example.json をコピーして config.json を作成してください');
  process.exit(1);
}

// エンジンの adapter を読み込む(1プロセス = 1エンジン。未指定は claude-code)
let adapter;
try {
  adapter = await loadAdapter(config.engine || 'claude-code', config);
} catch (error) {
  console.error(`[index] ${error.message}`);
  process.exit(1);
}

// Hono アプリケーションを作成（末尾スラッシュは区別しない。Express の既定に合わせる）
const app = new Hono({ strict: false });

// リクエストボディの上限（超過は 413）。JSON ボディは c.get('body') に入る
const maxBodySize = parseSize(config.upload?.maxBodySize || '10mb') ?? 10 * 1024 * 1024;
app.use('*', bodyLimit({
  maxSize: maxBodySize,
  onError: (c) => c.json({ error: 'Payload Too Large' }, 413)
}));
app.use('*', jsonBodyParser());

// API トークン認証ミドルウェア
async function authMiddleware(c, next) {
  const apiToken = config.apiToken;

  // トークンが設定されていない、または空文字列の場合は認証をスキップ
  if (!apiToken || apiToken === '') {
    return next();
  }

  const authHeader = c.req.header('authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized: Missing or invalid authorization header' }, 401);
  }

  const token = authHeader.substring(7); // "Bearer " を除去

  if (!safeEqual(token, apiToken)) {
    return c.json({ error: 'Unauthorized: Invalid token' }, 401);
  }

  return next();
}

// 全エンドポイントに認証を適用
app.use('*', authMiddleware);

// ログディレクトリを作成
const logsDir = fileURLToPath(new URL('../logs', import.meta.url));
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// ログストリームを作成（追記モード）
const logFilePath = path.join(logsDir, 'server.log');
const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

// ログ書き込み関数
function writeLog(category, data) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    category,
    data
  };
  logStream.write(JSON.stringify(logEntry) + '\n');
}

console.log(`[index] Logging to: ${logFilePath}`);

// イベントの観測元を作成(adapter の observe に従う)
const source = createSource(adapter, config);

// Watch 系 API ルーターをマウント
app.route('/', createApiRouter(config, adapter));

// subscribers をセットアップ
setupSubscribers(config.subscribers, source, processEvents, config, adapter);

// 観測元の message イベントは生のセッション内容（実行コマンド全文など）を含むため、
// server.log には記録しない（subscribers への配信はこれとは別経路）

// processEvents のイベントをログに記録
processEvents.on('session-started', (event) => {
  writeLog('session-started', event);
});

processEvents.on('session-error', (event) => {
  writeLog('session-error', event);
});

processEvents.on('session-timeout', (event) => {
  writeLog('session-timeout', event);
});

processEvents.on('cancel-initiated', (event) => {
  writeLog('cancel-initiated', event);
});

processEvents.on('process-exit', (event) => {
  writeLog('process-exit', event);
});

// Cancel 系 API エンドポイント
// POST /sessions/:id/cancel - プロセスをキャンセル
app.post('/sessions/:id/cancel', (c) => {
  const sessionId = c.req.param('id');
  const cancelTimeoutMs = config.send.cancelTimeoutMs || 3000;

  const result = cancel(sessionId, cancelTimeoutMs);

  if (!result) {
    return c.json({ error: 'Session not found or not managed' }, 404);
  }

  return c.json(result);
});

// 管理 API
// GET /managed - 管理中のプロセス一覧
app.get('/managed', (c) => {
  const processes = getManagedProcesses();
  return c.json(processes);
});

// GET /health - ヘルスチェック
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    version: packageJson.version,
    uptime: process.uptime()
  });
});

// 該当するルートが無いとき
app.notFound((c) => c.json({ error: 'Not Found' }, 404));

// ボディが不正なら 400、それ以外の想定外のエラーは 500
app.onError((error, c) => {
  if (error instanceof BadRequestError) {
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }
  console.error('[index] Unhandled error:', error);
  return c.json({ error: 'Internal Server Error' }, 500);
});

// サーバー起動
const port = config.port || 3100;

let mqttClient = null;

const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`coding-agent-pipe v${packageJson.version} listening on port ${port}`);

  // ウォッチャーを起動
  source.start().catch((error) => {
    console.error('[index] Failed to start source:', error);
  });

  // 古い添付ファイルの掃除（起動時 + 1時間ごと）
  cleanupOldAttachments(config);
  setInterval(() => cleanupOldAttachments(config), 60 * 60 * 1000);

  // MQTT コマンド受信チャネル（config.mqtt 未設定時は何もしない）
  mqttClient = setupMqttReceiver(config, adapter);
});

// Graceful shutdown
async function shutdown() {
  console.log('\n[index] Shutting down...');
  await source.stop();
  if (mqttClient) mqttClient.end();
  logStream.end();
  server.close(() => {
    console.log('[index] Server closed');
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
