/**
 * adapters/index.js - config.engine に応じて adapter を読み込む
 *
 * 1プロセス = 1エンジン。起動時に adapter を1つ選び、以降の core は自分がどのエンジンかを知らない。
 * 分岐はこの起動時の1回だけで、実行中に「このイベントはどのエンジン?」と判断する箇所は無い。
 */

import fs from 'node:fs';

// config.engine は adapters/ 配下のディレクトリ名。パスを組み立てるので、使える文字を絞る
const ENGINE_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** adapters/ 配下にあるエンジンの一覧 */
function availableEngines() {
  return fs.readdirSync(new URL('.', import.meta.url), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * @param {string} engine - エンジン名(例: 'claude-code')
 * @param {object} config - 設定オブジェクト(config.watchDir が無く、adapter が defaultWatchDir を持つときは、それを入れる)
 * @returns {Promise<object>} adapter
 */
async function loadAdapter(engine, config) {
  if (typeof engine !== 'string' || !ENGINE_NAME.test(engine)) {
    throw new Error(`Invalid engine name: ${JSON.stringify(engine)}. Available: ${availableEngines().join(', ')}`);
  }
  if (!availableEngines().includes(engine)) {
    throw new Error(`Unknown engine: "${engine}". Available: ${availableEngines().join(', ')}`);
  }
  const mod = await import(`./${engine}/index.js`);
  // 観測元・REST・adapter が同じ置き場を見るよう、adapter を作る前に config へ入れる
  if (!config.watchDir && mod.defaultWatchDir) {
    config.watchDir = mod.defaultWatchDir;
  }
  return mod.default(config);
}

export { loadAdapter, availableEngines };
