/**
 * mqtt-receiver.js - MQTT コマンド受信チャネル
 *
 * config.mqtt が設定されている場合、broker に接続して commandTopic を購読し、
 * 受信したコマンドを startNewSession / sendToSession にディスパッチする。
 * イベント配信（pipe → viewer）は引き続き HTTP webhook が担当し、ここでは
 * コマンド受信（viewer → pipe）のみを扱う。
 */

import mqtt from 'mqtt';
import { startNewSession, sendToSession } from './process.js';
import { isWindowsNonWSL } from './platform.js';

/**
 * MQTT コマンド受信を開始する
 * @param {object} config - アプリケーション設定
 * @param {object} engines - エンジンの登録簿(core/engines.js。コマンドの engine、または sessionId から引いたエンジンの adapter.spawn でプロセスを起動する)
 * @returns {import('mqtt').MqttClient|null} 接続した MQTT クライアント（未設定・非対応環境ではnull）
 */
function setupMqttReceiver(config, engines) {
  const mqttConfig = config.mqtt;
  if (!mqttConfig || !mqttConfig.url || !mqttConfig.commandTopic) {
    return null;
  }

  if (isWindowsNonWSL()) {
    console.warn('[mqtt] Windows native does not support spawning the engine CLI; MQTT command channel disabled');
    return null;
  }

  const client = mqtt.connect(mqttConfig.url, {
    username: mqttConfig.username,
    password: mqttConfig.password
  });

  client.on('connect', () => {
    console.log(`[mqtt] Connected to ${mqttConfig.url}`);
    client.subscribe(mqttConfig.commandTopic, { qos: 0 }, (error) => {
      if (error) {
        console.error('[mqtt] Failed to subscribe:', error.message);
      } else {
        console.log(`[mqtt] Subscribed to ${mqttConfig.commandTopic} (QoS 0)`);
      }
    });
  });

  client.on('reconnect', () => {
    console.log('[mqtt] Reconnecting...');
  });

  client.on('error', (error) => {
    console.error('[mqtt] Connection error:', error.message);
  });

  client.on('message', async (topic, payload) => {
    if (topic !== mqttConfig.commandTopic) return;

    let command;
    try {
      command = JSON.parse(payload.toString());
    } catch (error) {
      console.error('[mqtt] Invalid JSON payload:', error.message);
      return;
    }

    const { prompt, projectPath, sessionId, model, engine } = command;
    if (!prompt) {
      console.error('[mqtt] Command missing required field: prompt');
      return;
    }

    const allowedTools = config.send?.defaultAllowedTools || [];
    const callbacks = {
      onData: (data) => console.log('[mqtt] stdout:', data),
      onError: (data) => console.error('[mqtt] stderr:', data),
      onExit: (code, signal) => console.log(`[mqtt] Process exited: code=${code}, signal=${signal}`)
    };

    try {
      if (sessionId) {
        // セッション ID から、どのエンジンのセッションかを引く(engine を指定すれば、そのエンジンだけで探す)
        const found = await engines.findSession(sessionId, undefined, engine);
        if (found.status === 'unknown-engine') {
          console.error(`[mqtt] Unknown engine: ${JSON.stringify(found.engine)} (available: ${engines.ids().join(', ')})`);
          return;
        }
        if (found.status === 'conflict') {
          console.error(`[mqtt] Session ${sessionId} found in multiple engines (${found.engines.join(', ')}); specify "engine" in the command`);
          return;
        }
        // 見つからないときは、これまでどおり、暗黙の既定のエンジンで再開を試みる(無ければ、起動を止める)
        const adapter = found.status === 'found' ? found.adapter : engines.implicitDefault;
        if (!adapter) {
          console.error(`[mqtt] Session ${sessionId} not found, and no default engine is available; specify "engine" in the command`);
          return;
        }
        const result = await sendToSession(adapter.spawn, sessionId, prompt, { engine: adapter.id, cwd: projectPath, projectPath, allowedTools, model, ...callbacks });
        console.log(`[mqtt] Sent to existing session: sessionId=${result.sessionId}`);
      } else {
        // 新規起動: engine の指定が無ければ、暗黙の既定のエンジン
        const target = engine === undefined || engine === null || engine === '' ? engines.implicitDefault : engines.get(engine);
        if (!target) {
          const reason = engine === undefined || engine === null || engine === '' ? 'engine is required (no default engine is available)' : `Unknown engine: ${JSON.stringify(engine)}`;
          console.error(`[mqtt] ${reason} (available: ${engines.ids().join(', ')})`);
          return;
        }
        const result = await startNewSession(target.spawn, prompt, { engine: target.id, cwd: projectPath, projectPath, allowedTools, model, ...callbacks });
        console.log(`[mqtt] Started new session: sessionId=${result.sessionId}`);
      }
    } catch (error) {
      console.error('[mqtt] Error dispatching command:', error.message);
    }
  });

  return client;
}

export {
  setupMqttReceiver
};
