/**
 * auth.js - エンジンのログイン状態の確認
 *
 * 各エンジンの CLI(claude auth status、codex login status)を実行して、ログインしているかを返す。
 * CLI の起動は重く、ネットワークに触れうるので、結果をエンジンごとに一定時間覚える。
 *
 * 返すのは、ログインしているか(loggedIn)と、その方法(method)だけ。CLI の出力には、メールアドレスや
 * 組織 ID などが含まれうるので、出力そのものは、レスポンスにも、ログにも出さない(adapter の parse が取り出す項目だけ)。
 * 失敗の理由(error)は、決まった短い文だけ。
 *
 * adapter は、auth: { command, args, parse(result) } を持つ。result は { code, stdout, stderr }。
 * parse は { loggedIn, method } を返す。出力を解釈できなければ null(unexpected output)。
 */

import { spawn } from 'node:child_process';

/** 確認の結果を覚えておく時間(ミリ秒) */
const DEFAULT_TTL_MS = 30 * 1000;
/** CLI の実行を待つ上限(ミリ秒) */
const RUN_TIMEOUT_MS = 10 * 1000;
/** 出力として読む上限(バイト)。これを超えた分は捨てる */
const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * 外部コマンドを実行して、終了コードと出力を返す(標準入力は閉じる)
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 *   起動できなければ code: 'ENOENT' などのエラーで、時間切れなら code: 'TIMEOUT' のエラーで reject する
 */
function runCommand(command, args, { timeoutMs = RUN_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    const out = { stdout: '', stderr: '' };
    const collect = (name) => (chunk) => {
      if (out[name].length < MAX_OUTPUT_BYTES) out[name] += chunk.toString('utf8').slice(0, MAX_OUTPUT_BYTES - out[name].length);
    };
    proc.stdout.on('data', collect('stdout'));
    proc.stderr.on('data', collect('stderr'));

    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      proc.kill('SIGKILL');
      reject(Object.assign(new Error('timed out'), { code: 'TIMEOUT' }));
    }, timeoutMs);
    timer.unref();

    proc.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    proc.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code, ...out });
    });
  });
}

/** 実行の失敗を、決まった短い文にする(CLI の出力や、エラーの詳細は含めない) */
function describeFailure(error) {
  if (error && error.code === 'ENOENT') return 'command not found';
  if (error && error.code === 'TIMEOUT') return 'timed out';
  return 'failed to run';
}

/**
 * @param {object} [options]
 * @param {Function} [options.run] - 外部コマンドの実行(試験で差し替える)
 * @param {number} [options.ttlMs] - 結果を覚えておく時間
 * @param {() => number} [options.now] - 現在時刻(ミリ秒。試験で差し替える)
 */
function createAuthChecker({ run = runCommand, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
  const cache = new Map();    // エンジンの id → { at, value }
  const inflight = new Map(); // エンジンの id → 実行中の Promise(同時に呼ばれたら、1 回の実行を共有する)

  async function execute(adapter) {
    const base = { engine: adapter.id, loggedIn: false, method: null };
    if (!adapter.auth) return { ...base, error: 'auth check is not supported' };

    let result;
    try {
      result = await run(adapter.auth.command, adapter.auth.args);
    } catch (error) {
      return { ...base, error: describeFailure(error) };
    }

    let parsed = null;
    try {
      parsed = adapter.auth.parse(result);
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed.loggedIn !== 'boolean') return { ...base, error: 'unexpected output' };
    return { engine: adapter.id, loggedIn: parsed.loggedIn, method: parsed.loggedIn && typeof parsed.method === 'string' ? parsed.method : null };
  }

  /**
   * エンジンのログイン状態を返す
   * @returns {Promise<{engine: string, loggedIn: boolean, method: string|null, error?: string}>}
   */
  async function check(adapter) {
    const hit = cache.get(adapter.id);
    if (hit && now() - hit.at < ttlMs) return { ...hit.value };
    if (inflight.has(adapter.id)) return { ...(await inflight.get(adapter.id)) };

    const promise = execute(adapter).then((value) => {
      cache.set(adapter.id, { at: now(), value });
      return value;
    }).finally(() => inflight.delete(adapter.id));
    inflight.set(adapter.id, promise);
    return { ...(await promise) };
  }

  return { check };
}

export { createAuthChecker, runCommand, DEFAULT_TTL_MS, RUN_TIMEOUT_MS };
