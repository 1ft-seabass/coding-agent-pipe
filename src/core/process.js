/**
 * process.js - エンジンの CLI プロセスの管理
 *
 * セッションを開始・再開するためのプロセス管理(管理マップ・タイムアウト・イベント発行・kill)。
 * エンジン固有の知識(引数の組み立て・起動方法・init の読み取り)は、呼び出し側が渡す driver
 * (adapter.spawn)が持つ。driver は次の3つを提供する:
 *   buildArgs(options) → 引数配列 / spawnProcess(args, cwd) → ChildProcess / parseInit(json) → init 情報 or null
 */

import EventEmitter from 'node:events';

// sessionId → { proc, pid, startedAt } のマップ
const managedProcesses = new Map();

// EventEmitter のインスタンス
const processEvents = new EventEmitter();

// タイムアウト設定（デフォルト: 60秒）
const SESSION_START_TIMEOUT_MS = 60 * 1000;

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
  const { cwd, allowedTools, disallowedTools, model, dangerouslySkipPermissions, projectPath, onData, onError, onExit } = options;
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
      projectPath: projectPath || null
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
          projectPath: projectPath || null
        });

        proc.kill();
        managedProcesses.delete(tempSessionId);
        reject(timeoutError);
      }
    }, SESSION_START_TIMEOUT_MS);

    // stdout をコールバックに流す
    proc.stdout.on('data', (data) => {
      const dataStr = data.toString();

      // 最初の行からセッションIDを抽出
      if (!firstLineReceived) {
        try {
          const lines = dataStr.split('\n');
          for (const line of lines) {
            if (line.trim()) {
              const json = JSON.parse(line);
              const init = driver.parseInit(json);
              if (init && init.sessionId) {
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
                  model: initInfo.model
                });

                resolve({ pid, sessionId: actualSessionId, ...initInfo });
                break;
              }
            }
          }
        } catch (err) {
          // JSONパースエラーは無視（次の行で再試行）
        }
      }

      if (onData) {
        onData(dataStr);
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
      const sessionId = actualSessionId || tempSessionId;
      console.log(`[process] Process exited: sessionId=${sessionId}, pid=${pid}, code=${code}, signal=${signal}`);

      // イベント発行
      processEvents.emit('process-exit', {
        sessionId,
        pid,
        code,
        signal,
        timestamp: new Date().toISOString(),
        projectPath: projectPath || null
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
        projectPath: projectPath || null
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
  const { cwd, allowedTools, disallowedTools, model, dangerouslySkipPermissions, projectPath, onData, onError, onExit } = options;
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
      projectPath: projectPath || null
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
          projectPath: projectPath || null
        });

        proc.kill();
        managedProcesses.delete(sessionId);
        reject(timeoutError);
      }
    }, SESSION_START_TIMEOUT_MS);

    // stdout をコールバックに流す
    proc.stdout.on('data', (data) => {
      const dataStr = data.toString();

      // 最初の行から init イベントのモデルを抽出
      if (!firstLineReceived) {
        try {
          const lines = dataStr.split('\n');
          for (const line of lines) {
            if (line.trim()) {
              const json = JSON.parse(line);
              const init = driver.parseInit(json);
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
                  model: initInfo.model
                });

                resolve({ pid, sessionId, ...initInfo });
                break;
              }
            }
          }
        } catch (err) {
          // JSONパースエラーは無視
        }
      }

      if (onData) {
        onData(dataStr);
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
      console.log(`[process] Process exited: sessionId=${sessionId}, pid=${pid}, code=${code}, signal=${signal}`);

      // イベント発行
      processEvents.emit('process-exit', {
        sessionId,
        pid,
        code,
        signal,
        timestamp: new Date().toISOString(),
        projectPath: projectPath || null
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

      // session-error イベント発行
      processEvents.emit('session-error', {
        sessionId,
        pid,
        timestamp: new Date().toISOString(),
        error: err.message,
        projectPath: projectPath || null
      });

      managedProcesses.delete(sessionId);
      reject(err);
    });
  });
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
      alive: !info.proc.killed
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
    if (!info.proc.killed) {
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
      if (!info.proc.killed) {
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
  getManagedProcesses,
  getManagedProcess,
  killProcess,
  killAllProcesses,
  processEvents,
  managedProcesses  // セッション判定用に公開
};
