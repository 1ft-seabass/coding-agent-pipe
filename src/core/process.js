/**
 * process.js - エンジンの CLI プロセスの管理
 *
 * セッションを開始・再開するためのプロセス管理(管理マップ・タイムアウト・イベント発行・kill)。
 * エンジン固有の知識(引数の組み立て・起動方法・init の読み取り)は、呼び出し側が渡す driver
 * (adapter.spawn)が持つ。driver は次の3つを提供する:
 *   buildArgs(options) → 引数配列 / spawnProcess(args, cwd) → ChildProcess / parseInit(json) → init 情報 or null
 */

import EventEmitter from 'node:events';
import { StringDecoder } from 'node:string_decoder';

// sessionId → { proc, pid, startedAt } のマップ
const managedProcesses = new Map();

// EventEmitter のインスタンス
const processEvents = new EventEmitter();

// タイムアウト設定（デフォルト: 60秒）。起動を確認する(init を受け取る)までの待ち時間。config.send.startTimeoutMs で変えられる
const SESSION_START_TIMEOUT_MS = 60 * 1000;

// setTimeout に渡せる最大の値(これを超えると、1ms として扱われてしまう)
const MAX_TIMEOUT_MS = 2147483647;

// init が見つかるまでに、溜めておく文字数の上限(改行のない出力が続くときに、メモリを使い切らないため)
const MAX_INIT_BUFFER_CHARS = 8 * 1024 * 1024;

/**
 * config.send.startTimeoutMs を、起動のタイムアウト(ミリ秒)として読む
 * 未指定(undefined・null)なら、既定の 60 秒。指定するなら、1 以上 2147483647 以下の整数(それ以外は、黙って既定に戻さず、エラーにする)
 * @param {object} [send] - config.send
 * @returns {number}
 */
function resolveStartTimeoutMs(send) {
  const value = send?.startTimeoutMs;
  if (value === undefined || value === null) return SESSION_START_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new Error(`config.send.startTimeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS} (milliseconds), got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * 標準出力から、init の行を探す部品
 * 標準出力は、PTY(script)を通るので、1 行(init)が、2 回以上のデータに分かれて届くことがある(init が大きいとき)。
 * そのため、データを溜めて、改行で行に分けてから、1 行ずつ読む。
 *   - 複数バイトの文字が、データの区切りをまたいでも壊れないよう、StringDecoder で文字に直す
 *   - JSON でない行(警告など)が混ざっても、その行だけを飛ばす
 *   - 改行で終わっていない最後の部分も、JSON として完結していれば(「}」で終わり、読める)、1 行として読む
 *   - init が見つかったら、以後は何も溜めない。見つからないまま溜めた文字数が上限を超えたら、あきらめる(以後は何も溜めない)
 * @param {(json: object) => (object|null)} readInit - 1 つの JSON を、init 情報に直す(init でなければ null)
 * @returns {{ feed: (chunk: (Buffer|string)) => (object|null) }} feed は、init が見つかったときだけ、その情報を返す
 */
function createInitReader(readInit) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let finished = false;

  const readLine = (line) => {
    const text = line.trim();
    if (!text) return null;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return null; // JSON でない行は、飛ばす
    }
    return readInit(json);
  };

  return {
    feed(chunk) {
      if (finished) return null;
      pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        const init = readLine(line);
        if (init) { finished = true; pending = ''; return init; }
      }
      // 改行で終わっていない最後の部分が、JSON として完結していれば、1 行として読む
      if (pending.trimEnd().endsWith('}')) {
        const init = readLine(pending);
        if (init) { finished = true; pending = ''; return init; }
      }
      if (pending.length > MAX_INIT_BUFFER_CHARS) { finished = true; pending = ''; }
      return null;
    }
  };
}

/**
 * 新しいセッションを開始
 * @param {object} driver - エンジンの起動方法(adapter.spawn)
 * @param {string} prompt - プロンプトテキスト
 * @param {object} options - オプション
 * @param {string} options.cwd - 作業ディレクトリ
 * @param {Array<string>} options.allowedTools - 許可ツールのリスト
 * @param {Array<string>} options.disallowedTools - 禁止ツールのリスト
 * @param {string} options.model - 使用モデル (例: "sonnet", "opus", "claude-sonnet-4-6")
 * @param {boolean} options.dangerouslySkipPermissions - 権限確認をスキップ（危険）
 * @param {string} options.projectPath - プロジェクトパス（Webhook用）
 * @param {Function} options.onData - stdout データのコールバック
 * @param {Function} options.onError - stderr データのコールバック
 * @param {Function} options.onExit - プロセス終了時のコールバック
 * @returns {Promise<object>} { pid, sessionId } (sessionIdは実際のUUID)
 */
function startNewSession(driver, prompt, options = {}) {
  const { cwd, allowedTools, disallowedTools, model, dangerouslySkipPermissions, projectPath, engine, onData, onError, onExit, startTimeoutMs } = options;
  return new Promise((resolve, reject) => {
    const proc = driver.spawnProcess(
      driver.buildArgs({ prompt, allowedTools, disallowedTools, model, dangerouslySkipPermissions }),
      cwd
    );

    const pid = proc.pid;
    const tempSessionId = `temp-${Date.now()}-${pid}`; // 一時的なセッションID
    let actualSessionId = null; // 実際のUUID形式のセッションID
    let firstLineReceived = false;
    let sessionStartTimeout = null;

    // 一時的にマップに登録（後でactualSessionIdに置き換える）
    managedProcesses.set(tempSessionId, {
      proc,
      pid,
      startedAt: new Date(),
      projectPath: projectPath || null,
      ...(engine && { engine })
    });

    // タイムアウト設定
    sessionStartTimeout = setTimeout(() => {
      if (!firstLineReceived) {
        const timeoutError = new Error('Session start timeout: Failed to retrieve session ID');
        console.error(`[process] ${timeoutError.message}: pid=${pid}`);

        // session-timeout イベント発行
        processEvents.emit('session-timeout', {
          sessionId: tempSessionId,
          pid,
          timestamp: new Date().toISOString(),
          error: timeoutError.message,
          projectPath: projectPath || null,
          ...(engine && { engine })
        });

        proc.kill();
        managedProcesses.delete(tempSessionId);
        reject(timeoutError);
      }
    }, startTimeoutMs ?? SESSION_START_TIMEOUT_MS);

    // stdout をコールバックに流す。最初の行(init)からセッションIDを抽出する
    // (データは、行の途中で分かれて届くことがあるので、溜めてから行ごとに読む)
    const initReader = createInitReader((json) => {
      const init = driver.parseInit(json);
      return init && init.sessionId ? init : null;
    });
    proc.stdout.on('data', (data) => {
      if (!firstLineReceived) {
        const init = initReader.feed(data);
        if (init) {
          const { sessionId: initSessionId, ...initInfo } = init;
          actualSessionId = initSessionId;
          firstLineReceived = true;

          // 一時IDから実際のセッションIDに移行
          const tempInfo = managedProcesses.get(tempSessionId);
          managedProcesses.delete(tempSessionId);
          managedProcesses.set(actualSessionId, tempInfo);

          // タイムアウトをクリア
          if (sessionStartTimeout) {
            clearTimeout(sessionStartTimeout);
            sessionStartTimeout = null;
          }

          console.log(`[process] Started new session: sessionId=${actualSessionId}, pid=${pid}, model=${initInfo.model}`);

          // session-started イベント発行
          processEvents.emit('session-started', {
            sessionId: actualSessionId,
            pid,
            timestamp: new Date().toISOString(),
            projectPath: projectPath || null,
            model: initInfo.model,
            ...(engine && { engine })
          });

          resolve({ pid, sessionId: actualSessionId, ...initInfo });
        }
      }

      if (onData) {
        onData(data.toString());
      }
    });

    // stderr をコールバックに流す
    proc.stderr.on('data', (data) => {
      if (onError) {
        onError(data.toString());
      }
    });

    // プロセス終了時の処理
    proc.on('exit', (code, signal) => {
      // 終わったプロセスについて、あとから session-timeout が出ないよう、起動タイムアウトを止める
      if (sessionStartTimeout) {
        clearTimeout(sessionStartTimeout);
        sessionStartTimeout = null;
      }

      const sessionId = actualSessionId || tempSessionId;
      console.log(`[process] Process exited: sessionId=${sessionId}, pid=${pid}, code=${code}, signal=${signal}`);

      // イベント発行
      processEvents.emit('process-exit', {
        sessionId,
        pid,
        code,
        signal,
        timestamp: new Date().toISOString(),
        projectPath: projectPath || null,
        ...(engine && { engine })
      });

      managedProcesses.delete(sessionId);
      if (onExit) {
        onExit(code, signal);
      }

      // セッションIDが取得できないまま終了した場合
      if (!firstLineReceived) {
        reject(new Error('Failed to retrieve session ID from the engine command'));
      }
    });

    // プロセス起動エラー
    proc.on('error', (err) => {
      console.error(`[process] Failed to start process: ${err.message}`);

      // タイムアウトをクリア
      if (sessionStartTimeout) {
        clearTimeout(sessionStartTimeout);
        sessionStartTimeout = null;
      }

      // session-error イベント発行
      const sessionId = actualSessionId || tempSessionId;
      processEvents.emit('session-error', {
        sessionId,
        pid,
        timestamp: new Date().toISOString(),
        error: err.message,
        projectPath: projectPath || null,
        ...(engine && { engine })
      });

      managedProcesses.delete(tempSessionId);
      reject(err);
    });
  });
}

/**
 * 既存セッションに送信
 * @param {object} driver - エンジンの起動方法(adapter.spawn)
 * @param {string} sessionId - セッションID (UUID形式)
 * @param {string} prompt - プロンプトテキスト
 * @param {object} options - オプション
 * @param {string} options.cwd - 作業ディレクトリ
 * @param {Array<string>} options.allowedTools - 許可ツールのリスト
 * @param {Array<string>} options.disallowedTools - 禁止ツールのリスト
 * @param {string} options.model - 使用モデル (例: "sonnet", "opus", "claude-sonnet-4-6")
 * @param {boolean} options.dangerouslySkipPermissions - 権限確認をスキップ（危険）
 * @param {string} options.projectPath - プロジェクトパス（Webhook用）
 * @param {Function} options.onData - stdout データのコールバック
 * @param {Function} options.onError - stderr データのコールバック
 * @param {Function} options.onExit - プロセス終了時のコールバック
 * @returns {object} { pid, sessionId }
 */
function sendToSession(driver, sessionId, prompt, options = {}) {
  const { cwd, allowedTools, disallowedTools, model, dangerouslySkipPermissions, projectPath, engine, onData, onError, onExit, startTimeoutMs } = options;
  return new Promise((resolve, reject) => {
    const proc = driver.spawnProcess(
      driver.buildArgs({ prompt, resumeId: sessionId, allowedTools, disallowedTools, model, dangerouslySkipPermissions }),
      cwd
    );

    const pid = proc.pid;
    let firstLineReceived = false;
    let sendTimeout = null;

    // 既存のセッションIDを上書き（同一セッションIDで新しいプロセス）
    managedProcesses.set(sessionId, {
      proc,
      pid,
      startedAt: new Date(),
      projectPath: projectPath || null,
      ...(engine && { engine })
    });

    // タイムアウト設定
    sendTimeout = setTimeout(() => {
      if (!firstLineReceived) {
        const timeoutError = new Error('Session send timeout: Failed to retrieve init event');
        console.error(`[process] ${timeoutError.message}: sessionId=${sessionId}, pid=${pid}`);

        processEvents.emit('session-timeout', {
          sessionId,
          pid,
          timestamp: new Date().toISOString(),
          error: timeoutError.message,
          projectPath: projectPath || null,
          ...(engine && { engine })
        });

        proc.kill();
        managedProcesses.delete(sessionId);
        reject(timeoutError);
      }
    }, startTimeoutMs ?? SESSION_START_TIMEOUT_MS);

    // stdout をコールバックに流す。最初の行(init)から、モデルなどを抽出する
    // (データは、行の途中で分かれて届くことがあるので、溜めてから行ごとに読む)
    const initReader = createInitReader((json) => driver.parseInit(json));
    proc.stdout.on('data', (data) => {
      if (!firstLineReceived) {
        const init = initReader.feed(data);
        if (init) {
          const { sessionId: _initSessionId, ...initInfo } = init;
          firstLineReceived = true;
          if (sendTimeout) {
            clearTimeout(sendTimeout);
            sendTimeout = null;
          }
          console.log(`[process] Sent to existing session: sessionId=${sessionId}, pid=${pid}, model=${initInfo.model}`);

          // session-started イベント発行（既存セッション再開、init 後に model を含めて発行）
          processEvents.emit('session-started', {
            sessionId,
            pid,
            timestamp: new Date().toISOString(),
            resumed: true,
            projectPath: projectPath || null,
            model: initInfo.model,
            ...(engine && { engine })
          });

          resolve({ pid, sessionId, ...initInfo });
        }
      }

      if (onData) {
        onData(data.toString());
      }
    });

    // stderr をコールバックに流す
    proc.stderr.on('data', (data) => {
      if (onError) {
        onError(data.toString());
      }
    });

    // プロセス終了時の処理
    proc.on('exit', (code, signal) => {
      // 終わったプロセスについて、あとから session-timeout が出ないよう、起動タイムアウトを止める
      if (sendTimeout) {
        clearTimeout(sendTimeout);
        sendTimeout = null;
      }

      console.log(`[process] Process exited: sessionId=${sessionId}, pid=${pid}, code=${code}, signal=${signal}`);

      // イベント発行
      processEvents.emit('process-exit', {
        sessionId,
        pid,
        code,
        signal,
        timestamp: new Date().toISOString(),
        projectPath: projectPath || null,
        ...(engine && { engine })
      });

      managedProcesses.delete(sessionId);
      if (onExit) {
        onExit(code, signal);
      }

      if (!firstLineReceived) {
        reject(new Error('Failed to retrieve init event from the engine command'));
      }
    });

    // プロセス起動エラー
    proc.on('error', (err) => {
      console.error(`[process] Failed to send to session: ${err.message}`);

      // 起動エラーのあとに session-timeout が出ないよう、起動タイムアウトを止める
      if (sendTimeout) {
        clearTimeout(sendTimeout);
        sendTimeout = null;
      }

      // session-error イベント発行
      processEvents.emit('session-error', {
        sessionId,
        pid,
        timestamp: new Date().toISOString(),
        error: err.message,
        projectPath: projectPath || null,
        ...(engine && { engine })
      });

      managedProcesses.delete(sessionId);
      reject(err);
    });
  });
}

/**
 * プロセスが、まだ動いているか
 * (ChildProcess の `killed` は、kill() で信号を送れたことを表し、終了したことは表さない。
 *  SIGINT を送ったあとも真になるので、「動いているか」の判定には使えない)
 * @param {import('child_process').ChildProcess} proc
 * @returns {boolean}
 */
function isRunning(proc) {
  return proc.exitCode === null && proc.signalCode === null;
}

/**
 * 管理中のプロセス一覧を取得
 * @returns {Array}
 */
function getManagedProcesses() {
  const list = [];
  for (const [sessionId, info] of managedProcesses.entries()) {
    list.push({
      sessionId,
      pid: info.pid,
      startedAt: info.startedAt,
      alive: isRunning(info.proc),
      ...(info.engine && { engine: info.engine })
    });
  }
  return list;
}

/**
 * 指定セッションのプロセス情報を取得
 * @param {string} sessionId
 * @returns {object|null}
 */
function getManagedProcess(sessionId) {
  return managedProcesses.get(sessionId) || null;
}

/**
 * 指定セッションのプロセスを強制終了
 * @param {string} sessionId - セッションID
 * @returns {object|null} { sessionId, pid, killed: boolean } または null (存在しない場合)
 */
function killProcess(sessionId) {
  const info = managedProcesses.get(sessionId);
  if (!info) {
    return null; // セッションが存在しない
  }

  try {
    if (isRunning(info.proc)) {
      info.proc.kill('SIGTERM');
      console.log(`[process] Killed process: sessionId=${sessionId}, pid=${info.pid}`);
      managedProcesses.delete(sessionId);
      return {
        sessionId,
        pid: info.pid,
        killed: true
      };
    } else {
      // 既に終了済み
      managedProcesses.delete(sessionId);
      return {
        sessionId,
        pid: info.pid,
        killed: false // 既に終了していた
      };
    }
  } catch (error) {
    console.error(`[process] Failed to kill process: sessionId=${sessionId}, error=${error.message}`);
    throw error;
  }
}

/**
 * 全プロセスを強制終了（緊急用）
 * @returns {object} { killed: number, sessions: Array<string> }
 */
function killAllProcesses() {
  const killedSessions = [];
  let killedCount = 0;

  for (const [sessionId, info] of managedProcesses.entries()) {
    try {
      if (isRunning(info.proc)) {
        info.proc.kill('SIGTERM');
        killedCount++;
        killedSessions.push(sessionId);
        console.log(`[process] Killed process: sessionId=${sessionId}, pid=${info.pid}`);
      }
    } catch (error) {
      console.error(`[process] Failed to kill process: sessionId=${sessionId}, error=${error.message}`);
    }
  }

  // マップをクリア
  managedProcesses.clear();

  return {
    killed: killedCount,
    sessions: killedSessions
  };
}

export {
  startNewSession,
  sendToSession,
  createInitReader,
  resolveStartTimeoutMs,
  getManagedProcesses,
  getManagedProcess,
  killProcess,
  killAllProcesses,
  isRunning,
  processEvents,
  managedProcesses  // セッション判定用に公開
};
