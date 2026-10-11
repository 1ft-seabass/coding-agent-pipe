/**
 * adapters/index.js - 設定に応じて、動かすエンジンの adapter を読み込む
 *
 * 動かすエンジンは、起動時に設定で決まる。
 *   engines      動かすエンジンの配列(例: ["claude-code", "codex"])。指定しなければ claude-code だけ
 *   watchDirs    エンジンごとのセッションの置き場(例: { "codex": "/path" })。省略したらエンジンの既定の場所
 *   engine       旧来の、エンジン 1 つの指定(engines と一緒には書けない)
 *   watchDir     旧来の、置き場の指定(engines と一緒には書けない。engines では watchDirs を使う)
 * core は、どのエンジンかを知らず、エンジンの登録簿(core/engines.js)から引く。
 */

import fs from 'node:fs';

// config.engine は adapters/ 配下のディレクトリ名。パスを組み立てるので、使える文字を絞る
const ENGINE_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** 設定で engines を指定しなかったときに動かすエンジン。engine を指定しない新規起動の既定でもある */
const DEFAULT_ENGINE = 'claude-code';

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

const isBlank = (value) => value === undefined || value === null || value === '';

/**
 * 設定から、動かすエンジンと、それぞれの置き場を決める(adapter は読み込まない)
 * @param {object} config - 設定オブジェクト
 * @returns {{ engines: Array<{id: string, watchDir: string|undefined}>, defaultId: string }}
 *   watchDir が undefined のエンジンは、adapter の既定の場所になる。
 *   defaultId は、claude-code が動くなら claude-code、そうでなければ先頭のエンジン
 */
function resolveEngineConfigs(config) {
  const hasEngines = !isBlank(config.engines);
  const hasEngine = !isBlank(config.engine);
  const hasWatchDir = !isBlank(config.watchDir);

  let ids;
  if (hasEngines) {
    if (!Array.isArray(config.engines) || config.engines.length === 0) {
      throw new Error('config.engines must be a non-empty array of engine names');
    }
    if (hasEngine) {
      throw new Error('config.engine cannot be used together with config.engines; list the engine in config.engines');
    }
    if (hasWatchDir) {
      throw new Error('config.watchDir cannot be used together with config.engines; use config.watchDirs (one entry per engine)');
    }
    ids = config.engines;
  } else {
    ids = [hasEngine ? config.engine : DEFAULT_ENGINE];
  }

  const watchDirs = config.watchDirs ?? {};
  if (typeof watchDirs !== 'object' || Array.isArray(watchDirs)) {
    throw new Error('config.watchDirs must be an object whose keys are engine names');
  }
  for (const [id, dir] of Object.entries(watchDirs)) {
    if (!ids.includes(id)) {
      throw new Error(`config.watchDirs has "${id}", which is not among the engines: ${ids.join(', ')}`);
    }
    if (typeof dir !== 'string' || dir === '') {
      throw new Error(`config.watchDirs["${id}"] must be a non-empty string`);
    }
  }

  const engines = ids.map((id) => ({
    id,
    // 旧来の watchDir は、エンジン 1 つの設定(engines なし)のときだけ、そのエンジンの置き場になる
    watchDir: watchDirs[id] ?? (hasEngines || !hasWatchDir ? undefined : config.watchDir),
  }));
  return { engines, defaultId: ids.includes(DEFAULT_ENGINE) ? DEFAULT_ENGINE : ids[0] };
}

/**
 * 設定に従って、動かすエンジンの adapter をすべて読み込む
 * 各 adapter には、置き場が watchDir として付く(adapter の既定の場所を含む)。config は書き換えない。
 * @param {object} config - 設定オブジェクト
 * @returns {Promise<{ adapters: object[], defaultId: string }>}
 */
async function loadAdapters(config) {
  const { engines, defaultId } = resolveEngineConfigs(config);
  const adapters = [];
  for (const { id, watchDir } of engines) {
    // adapter ごとの設定のコピー(loadAdapter が、置き場の既定を入れる先)
    const engineConfig = { ...config, engine: id };
    delete engineConfig.engines;
    delete engineConfig.watchDirs;
    if (watchDir === undefined) delete engineConfig.watchDir; else engineConfig.watchDir = watchDir;
    const adapter = await loadAdapter(id, engineConfig);
    adapter.watchDir = engineConfig.watchDir;
    adapters.push(adapter);
  }
  return { adapters, defaultId };
}

export { loadAdapter, loadAdapters, resolveEngineConfigs, availableEngines, DEFAULT_ENGINE };
