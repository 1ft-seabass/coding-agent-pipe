/**
 * deliver.js - subscribers への HTTP POST 配信
 *
 * config.subscribers の配列を読み、レベルに応じて HTTP POST で配信する。
 * どのエンジンのイベントかは adapter(resolveProject / isSubagent / backendType)が教える。
 * プロトタイプ実装。
 */

import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { managedProcesses } from './process.js';
import { getOsInfo } from './platform.js';
import { getGitInfo } from './git-info.js';
import { packageJson, PIPE_APP } from '../package-info.js';

// エラー履歴管理（直近のエラーを記録して重複警告を防ぐ）
const errorHistory = new Map(); // key: `${label}:${url}`, value: timestamp
const ERROR_THROTTLE_MS = 5 * 60 * 1000; // 5分間同じエラーを抑制

// Git 情報のキャッシュ（プロジェクトパスをキーとして管理）
const gitInfoCache = new Map();

/**
 * プロジェクトパスから Git 情報を取得（キャッシュ付き）
 * @param {string} projectPath - プロジェクトのフルパス
 * @returns {object|null} - Git 情報オブジェクト、または null
 */
function getProjectGitInfo(projectPath) {
  if (!projectPath) {
    return null;
  }

  // キャッシュをチェック
  if (gitInfoCache.has(projectPath)) {
    return gitInfoCache.get(projectPath);
  }

  // Git 情報を取得
  const gitInfo = getGitInfo(projectPath);

  // キャッシュに保存
  gitInfoCache.set(projectPath, gitInfo);

  return gitInfo;
}

/**
 * subscribers の配信をセットアップ
 * @param {Array} subscribers - config.subscribers の配列
 * @param {EventEmitter} source - イベントの観測元(message イベントを発火する)
 * @param {EventEmitter} processEvents - sender の processEvents
 * @param {Object} config - 設定オブジェクト（projectTitle 取得用）
 * @param {Object} adapter - エンジンの adapter
 */
function setupSubscribers(subscribers, source, processEvents, config, adapter) {
  if (!subscribers || subscribers.length === 0) {
    console.log('[subscribers] No subscribers configured');
    return;
  }

  // サーバー情報を取得
  const cwdPath = process.cwd();
  const cwdName = path.basename(cwdPath);
  const projectTitle = config.projectTitle || null;
  const callbackUrl = config.callbackUrl || null;
  const mqttCommandTopic = config.mqtt?.commandTopic || null;

  // communicationMode を算出（起動時に一度だけ）
  const hasCallbackUrl = !!(callbackUrl && callbackUrl.trim());
  const subscriberCount = (subscribers || []).length;
  let communicationMode;
  if (subscriberCount === 0) {
    communicationMode = 'watch-only';
  } else if (hasCallbackUrl || mqttCommandTopic) {
    communicationMode = 'bidirectional';
  } else {
    communicationMode = 'webhook-only';
  }

  const serverInfo = { cwdPath, cwdName, projectTitle, callbackUrl, os: getOsInfo(), communicationMode, mqttCommandTopic, backendType: adapter.backendType, pipeApp: PIPE_APP, engine: adapter.id };

  // セッションごとの最終タイムスタンプ（応答時間計算用）
  const sessionTimestamps = new Map();

  // 観測元の message イベントを監視
  source.on('message', (event) => {
    for (const subscriber of subscribers) {
      handleSubscriberEvent(subscriber, event, sessionTimestamps, serverInfo, adapter);
    }
  });

  // processEvents のイベントを監視（キャンセルや終了など）
  if (processEvents) {
    processEvents.on('session-started', (event) => {
      for (const subscriber of subscribers) {
        handleProcessEvent(subscriber, 'session-started', event, serverInfo);
      }
    });

    processEvents.on('session-error', (event) => {
      for (const subscriber of subscribers) {
        handleProcessEvent(subscriber, 'session-error', event, serverInfo);
      }
    });

    processEvents.on('session-timeout', (event) => {
      for (const subscriber of subscribers) {
        handleProcessEvent(subscriber, 'session-timeout', event, serverInfo);
      }
    });

    processEvents.on('cancel-initiated', (event) => {
      for (const subscriber of subscribers) {
        handleProcessEvent(subscriber, 'cancel-initiated', event, serverInfo);
      }
    });

    processEvents.on('process-exit', (event) => {
      for (const subscriber of subscribers) {
        handleProcessEvent(subscriber, 'process-exit', event, serverInfo);
      }
    });
  }

  console.log(`[subscribers] Setup complete for ${subscribers.length} subscriber(s)`);
}

/**
 * プロセスイベントを処理（キャンセル、終了など）
 */
function handleProcessEvent(subscriber, eventType, event, serverInfo) {
  const { url, label, authorization } = subscriber;

  // projectPath から projectName を計算
  const projectPath = event.projectPath || null;
  const projectName = projectPath ? path.basename(projectPath) : null;

  const payload = {
    type: eventType,
    version: packageJson.version,
    sessionId: event.sessionId,
    pid: event.pid,
    timestamp: event.timestamp,
    cwdPath: serverInfo.cwdPath,
    cwdName: serverInfo.cwdName,
    callbackUrl: serverInfo.callbackUrl,
    os: serverInfo.os,
    communicationMode: serverInfo.communicationMode,
    backendType: serverInfo.backendType,
    pipeApp: serverInfo.pipeApp,
    engine: serverInfo.engine,
    ...(serverInfo.mqttCommandTopic && { mqttCommandTopic: serverInfo.mqttCommandTopic }),
    ...(projectPath && { projectPath }),
    ...(projectName && { projectName }),
    ...(serverInfo.projectTitle && { projectTitle: serverInfo.projectTitle }),
    ...(event.code !== undefined && { code: event.code }),
    ...(event.signal !== undefined && { signal: event.signal }),
    ...(event.error !== undefined && { error: event.error }),
    ...(event.resumed !== undefined && { resumed: event.resumed }),
    ...(event.model !== undefined && { model: event.model })
  };
  deliverToSubscriber(url, payload, authorization, label);
}

/**
 * subscriber ごとにイベントを処理
 */
function handleSubscriberEvent(subscriber, event, sessionTimestamps, serverInfo, adapter) {
  const { url, label, authorization } = subscriber;

  // サブエージェントのセッションかどうかを判定
  const isSubagent = adapter.isSubagent(event.sourcePath);

  // user メッセージの場合
  if (event.message && event.message.role === 'user') {
    // source を判定（API経由かどうか）
    const source = managedProcesses.has(event.sessionId) ? 'api' : 'cli';

    // プロジェクト情報を抽出
    const projectPath = event.sourcePath ? adapter.resolveProject(event.sourcePath) : null;
    const projectName = projectPath ? path.basename(projectPath) : null;

    // Git 情報を取得（キャッシュ付き）
    const gitInfo = getProjectGitInfo(projectPath);

    // タイムスタンプを記録（応答時間計算の起点）
    sessionTimestamps.set(event.sessionId, event.timestamp);

    const payload = {
      type: 'user-message-received',
      version: packageJson.version,
      sessionId: event.sessionId,
      timestamp: event.timestamp,
      cwdPath: serverInfo.cwdPath,
      cwdName: serverInfo.cwdName,
      callbackUrl: serverInfo.callbackUrl,
      os: serverInfo.os,
      communicationMode: serverInfo.communicationMode,
      backendType: serverInfo.backendType,
      pipeApp: serverInfo.pipeApp,
      engine: serverInfo.engine,
      ...(serverInfo.mqttCommandTopic && { mqttCommandTopic: serverInfo.mqttCommandTopic }),
      ...(projectPath && { projectPath }),
      ...(projectName && { projectName }),
      ...(serverInfo.projectTitle && { projectTitle: serverInfo.projectTitle }),
      source: source,
      isSubagent: isSubagent,
      isMeta: event.isMeta || false,
      git: gitInfo,
      message: event.message
    };

    deliverToSubscriber(url, payload, authorization, label);
    return;
  }

  // assistant メッセージの場合
  if (event.message && event.message.role === 'assistant') {
    // 応答時間を計算
    let responseTime = null;
    const lastTimestamp = sessionTimestamps.get(event.sessionId);
    if (lastTimestamp && event.timestamp) {
      const diff = new Date(event.timestamp) - new Date(lastTimestamp);
      responseTime = parseFloat((diff / 1000).toFixed(2)); // 秒単位（数値型）
    }
    sessionTimestamps.set(event.sessionId, event.timestamp);

    // source を判定（API経由かどうか）
    const source = managedProcesses.has(event.sessionId) ? 'api' : 'cli';

    // プロジェクト情報を抽出
    const projectPath = event.sourcePath ? adapter.resolveProject(event.sourcePath) : null;
    const projectName = projectPath ? path.basename(projectPath) : null;

    // Git 情報を取得（キャッシュ付き）
    const gitInfo = getProjectGitInfo(projectPath);

    const payload = {
      type: 'assistant-response-completed',
      version: packageJson.version,
      sessionId: event.sessionId,
      timestamp: event.timestamp,
      cwdPath: serverInfo.cwdPath,
      cwdName: serverInfo.cwdName,
      callbackUrl: serverInfo.callbackUrl,
      os: serverInfo.os,
      communicationMode: serverInfo.communicationMode,
      backendType: serverInfo.backendType,
      pipeApp: serverInfo.pipeApp,
      engine: serverInfo.engine,
      ...(serverInfo.mqttCommandTopic && { mqttCommandTopic: serverInfo.mqttCommandTopic }),
      ...(projectPath && { projectPath }),
      ...(projectName && { projectName }),
      ...(serverInfo.projectTitle && { projectTitle: serverInfo.projectTitle }),
      source: source,
      tools: event.tools || [],
      responseTime: responseTime,
      isSubagent: isSubagent,
      isMeta: event.isMeta || false,
      git: gitInfo,
      message: event.message
    };

    deliverToSubscriber(url, payload, authorization, label);
  }
}


/**
 * HTTP POST でデータを送信
 */
function deliverToSubscriber(urlString, payload, authorization, label) {
  try {
    const parsedUrl = new URL(urlString);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const postData = JSON.stringify(payload);

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    if (authorization) {
      options.headers['Authorization'] = authorization;
    }

    const req = client.request(options, (res) => {
      if (res.statusCode >= 400) {
        logErrorIfNeeded(
          `Failed to post to ${label} (${urlString}): HTTP ${res.statusCode}`,
          label,
          urlString
        );
      }
    });

    req.on('error', (error) => {
      logErrorIfNeeded(
        `Error posting to ${label} (${urlString}): ${error.message}`,
        label,
        urlString
      );
    });

    req.write(postData);
    req.end();

  } catch (error) {
    logErrorIfNeeded(
      `Invalid URL for ${label}: ${urlString} - ${error.message}`,
      label,
      urlString
    );
  }
}

/**
 * エラーログを出力（直近に同じエラーが出ていなければ）
 */
function logErrorIfNeeded(message, label, url) {
  const key = `${label}:${url}`;
  const now = Date.now();
  const lastErrorTime = errorHistory.get(key);

  // 直近5分以内に同じエラーが出ていたらスキップ
  if (lastErrorTime && (now - lastErrorTime) < ERROR_THROTTLE_MS) {
    return;
  }

  // エラーログを出力
  console.error(`[subscribers] ${message}`);

  // エラー履歴を更新
  errorHistory.set(key, now);
}

export {
  setupSubscribers
};
