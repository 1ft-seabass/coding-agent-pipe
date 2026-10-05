/**
 * api.js - REST API ルート定義
 *
 * Hono のサブアプリ。Watch 系のエンドポイントを提供。
 * セッションデータの読み取りとプロセスの起動は adapter 経由で行い、ここはエンジンの違いを知らない。
 */

import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startNewSession, sendToSession, getManagedProcesses, killProcess, killAllProcesses } from './process.js';
import { getOsInfo } from './platform.js';
import { getGitStatus, getGitLog, isPathGitIgnored } from './git-info.js';

import { packageJson, PIPE_APP } from '../package-info.js';
import { query } from './http-utils.js';

// /attachments の保存先
const ATTACHMENTS_TMP_DIR = '/tmp/coding-agent-pipe';

// /attachments に保存されたファイルのうち、maxAgeDays より古いものを削除する
// （config.upload.maxAgeDays 未設定時は 7 日）
function cleanupOldAttachments(config) {
  const maxAgeDays = config.upload?.maxAgeDays || 7;
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  let entries;
  try {
    entries = fs.readdirSync(ATTACHMENTS_TMP_DIR, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    console.error('[api] Error reading attachments dir for cleanup:', error);
    return;
  }

  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(ATTACHMENTS_TMP_DIR, entry.name);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
        console.log(`[api] Cleaned up old attachment: ${entry.name}`);
      }
    } catch (error) {
      console.error(`[api] Error cleaning up attachment ${entry.name}:`, error);
    }
  }
}

// /projects/file のデフォルト拒否拡張子（バイナリ・非表示対象。画像は別枠でbase64許可するため含まない）
const DEFAULT_VIEWER_DENIED_EXTENSIONS = [
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.app',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.avi', '.wav', '.ogg', '.webm',
  '.db', '.sqlite', '.sqlite3', '.class', '.jar', '.wasm', '.pyc', '.o'
];

// /projects/file でbase64許可する画像拡張子（見て検討する用途。テキストと違いbase64+encoding付きで返す）
const DEFAULT_VIEWER_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.ico', '.svg'];

const IMAGE_MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

/**
 * API ルーターを作成
 * @param {object} config - 設定オブジェクト
 * @param {object} adapter - エンジンの adapter
 * @returns {Hono}
 */
function createApiRouter(config, adapter) {
  const api = new Hono();
  // セッションデータの入口(一覧・検索・読み込み)は adapter が持つ
  const store = adapter.sessions;

  // デフォルト値を取得
  const defaultDangerouslySkipPermissions = config?.send?.defaultDangerouslySkipPermissions || false;

  // セッションメタデータのインメモリキャッシュ
  const sessionMetadataCache = new Map();

  /**
   * セッションのメタデータを取得（キャッシュ付き）
   */
  async function getSessionMetadata(sessionId, filePath, mtime) {
    // キャッシュがあり、mtimeが同じなら返す
    const cached = sessionMetadataCache.get(sessionId);
    if (cached && cached.mtime === mtime) {
      return cached.metadata;
    }

    // キャッシュがないか古い場合は再パース
    const events = await store.read(filePath);

    // メッセージを role でフィルタ
    const userMessages = events.filter(e => e.message && e.message.role === 'user');
    const assistantMessages = events.filter(e => e.message && e.message.role === 'assistant');

    // トークン使用量を集計
    const totalTokens = assistantMessages.reduce((sum, msg) => {
      if (msg.message && msg.message.usage) {
        return sum + (msg.message.usage.input_tokens || 0) + (msg.message.usage.output_tokens || 0);
      }
      return sum;
    }, 0);

    // メッセージ内容を抽出するヘルパー
    const extractContent = (message) => {
      if (!message || !message.message || !message.message.content) return null;
      const content = message.message.content;
      if (Array.isArray(content)) {
        // content が配列の場合、text タイプのものを連結
        const textParts = content.filter(item => item.type === 'text').map(item => item.text);
        return textParts.join('\n') || null;
      }
      return content;
    };

    // プロジェクト情報を抽出
    const projectPath = adapter.resolveProject(filePath);
    const projectName = projectPath ? path.basename(projectPath) : null;

    const metadata = {
      id: sessionId,
      createdAt: events.length > 0 ? events[0].timestamp : null,
      lastModifiedAt: events.length > 0 ? events[events.length - 1].timestamp : null,
      messageCount: userMessages.length + assistantMessages.length,
      userMessageCount: userMessages.length,
      assistantMessageCount: assistantMessages.length,
      totalTokens,
      projectPath,
      projectName,
      firstUserMessage: userMessages.length > 0 ? extractContent(userMessages[0]) : null,
      lastUserMessage: userMessages.length > 0 ? extractContent(userMessages[userMessages.length - 1]) : null,
      firstAssistantMessage: assistantMessages.length > 0 ? extractContent(assistantMessages[0]) : null,
      lastAssistantMessage: assistantMessages.length > 0 ? extractContent(assistantMessages[assistantMessages.length - 1]) : null,
    };

    // キャッシュに保存
    sessionMetadataCache.set(sessionId, {
      mtime,
      metadata
    });

    return metadata;
  }

  // GET /version - バージョン情報
  api.get('/version', async (c) => {
    return c.json({
      name: packageJson.name,
      version: packageJson.version,
      description: packageJson.description
    });
  });

  // GET /info - pipe の現在の設定状態
  api.get('/info', async (c) => {
    const hasCallbackUrl = !!(config.callbackUrl && config.callbackUrl.trim());
    const mqttCommandTopic = config.mqtt?.commandTopic || null;
    const subscriberCount = (config.subscribers || []).length;

    let communicationMode;
    if (subscriberCount === 0) {
      communicationMode = 'watch-only';
    } else if (hasCallbackUrl || mqttCommandTopic) {
      communicationMode = 'bidirectional';
    } else {
      communicationMode = 'webhook-only';
    }

    return c.json({
      version: packageJson.version,
      os: getOsInfo(),
      communicationMode,
      backendType: adapter.backendType,
      pipeApp: PIPE_APP,
      engine: adapter.id,
      callbackUrl: config.callbackUrl || null,
      mqttCommandTopic,
      subscriberCount,
      projectTitle: config.projectTitle || null,
      watchDir: config.watchDir
    });
  });

  // GET /projects - プロジェクト一覧
  api.get('/projects', async (c) => {
    try {
      const sessions = await store.list();

      // クエリパラメータからフィルタ条件を取得（デフォルト: agent セッションと空セッションを除外）
      const excludeAgents = query(c, 'excludeAgents') !== 'false'; // デフォルト true
      const excludeEmpty = query(c, 'excludeEmpty') !== 'false';   // デフォルト true

      // プロジェクトごとにグルーピング
      const projectsMap = new Map();

      for (const session of sessions) {
        // agent-* セッションを除外（オプション）
        if (excludeAgents && adapter.isAgentSession(session.id)) {
          continue;
        }

        const projectPath = adapter.resolveProject(session.path);
        const projectName = projectPath ? path.basename(projectPath) : null;

        if (!projectPath) continue;

        if (!projectsMap.has(projectPath)) {
          projectsMap.set(projectPath, {
            projectPath,
            projectName,
            sessionCount: 0,
            sessions: []
          });
        }

        const project = projectsMap.get(projectPath);
        project.sessionCount++;
        project.sessions.push({
          id: session.id,
          mtime: session.mtime
        });
      }

      // excludeEmpty が有効な場合、空セッションを除外
      if (excludeEmpty) {
        for (const [projectPath, project] of projectsMap.entries()) {
          // 各セッションのメタデータを取得してフィルタ
          const filteredSessions = [];
          for (const session of project.sessions) {
            const sessionFiles = await store.list();
            const sessionFile = sessionFiles.find(s => s.id === session.id);
            if (sessionFile) {
              const metadata = await getSessionMetadata(session.id, sessionFile.path, sessionFile.mtime);
              if (metadata.messageCount > 0) {
                filteredSessions.push(session);
              }
            }
          }
          project.sessions = filteredSessions;
          project.sessionCount = filteredSessions.length;
        }

        // セッション数が0のプロジェクトを削除
        for (const [projectPath, project] of projectsMap.entries()) {
          if (project.sessionCount === 0) {
            projectsMap.delete(projectPath);
          }
        }
      }

      // Map を配列に変換
      const projects = Array.from(projectsMap.values());

      // セッション数の多い順にソート
      projects.sort((a, b) => b.sessionCount - a.sessionCount);

      return c.json({ projects });
    } catch (error) {
      console.error('[api] Error getting projects:', error);
      return c.json({ error: 'Failed to get projects' }, 500);
    }
  });

  // GET /sessions - セッション一覧
  api.get('/sessions', async (c) => {
    try {
      const sessions = await store.list();
      const detail = query(c, 'detail') === 'true';

      // クエリパラメータからフィルタ条件を取得（デフォルト: agent セッションと空セッションを除外）
      const excludeAgents = query(c, 'excludeAgents') !== 'false'; // デフォルト true
      const excludeEmpty = query(c, 'excludeEmpty') !== 'false';   // デフォルト true

      // フィルタリング適用
      let filteredSessions = sessions;

      // agent-* セッションを除外（オプション）
      if (excludeAgents) {
        filteredSessions = filteredSessions.filter(s => !adapter.isAgentSession(s.id));
      }

      if (!detail) {
        // シンプル版: メタデータのみ
        let metadataList = await Promise.all(
          filteredSessions.map(s => getSessionMetadata(s.id, s.path, s.mtime))
        );

        // 空セッションを除外（オプション）
        if (excludeEmpty) {
          metadataList = metadataList.filter(m => m.messageCount > 0);
        }

        return c.json({ sessions: metadataList });
      }

      // 詳細版: メッセージオブジェクト全体を含む
      const detailedList = await Promise.all(
        filteredSessions.map(async (s) => {
          const events = await store.read(s.path);
          const userMessages = events.filter(e => e.message && e.message.role === 'user');
          const assistantMessages = events.filter(e => e.message && e.message.role === 'assistant');

          const extractContent = (message) => {
            if (!message || !message.message || !message.message.content) return null;
            const content = message.message.content;
            if (Array.isArray(content)) {
              const textParts = content.filter(item => item.type === 'text').map(item => item.text);
              return textParts.join('\n') || null;
            }
            return content;
          };

          const totalTokens = assistantMessages.reduce((sum, msg) => {
            if (msg.message && msg.message.usage) {
              return sum + (msg.message.usage.input_tokens || 0) + (msg.message.usage.output_tokens || 0);
            }
            return sum;
          }, 0);

          // プロジェクト情報を抽出
          const projectPath = adapter.resolveProject(s.path);
          const projectName = projectPath ? path.basename(projectPath) : null;

          return {
            id: s.id,
            createdAt: events.length > 0 ? events[0].timestamp : null,
            lastModifiedAt: events.length > 0 ? events[events.length - 1].timestamp : null,
            messageCount: userMessages.length + assistantMessages.length,
            userMessageCount: userMessages.length,
            assistantMessageCount: assistantMessages.length,
            totalTokens,
            projectPath,
            projectName,
            firstUserMessage: userMessages.length > 0 ? {
              content: extractContent(userMessages[0]),
              timestamp: userMessages[0].timestamp
            } : null,
            lastUserMessage: userMessages.length > 0 ? {
              content: extractContent(userMessages[userMessages.length - 1]),
              timestamp: userMessages[userMessages.length - 1].timestamp
            } : null,
            firstAssistantMessage: assistantMessages.length > 0 ? {
              content: extractContent(assistantMessages[0]),
              timestamp: assistantMessages[0].timestamp,
              usage: assistantMessages[0].message.usage || null
            } : null,
            lastAssistantMessage: assistantMessages.length > 0 ? {
              content: extractContent(assistantMessages[assistantMessages.length - 1]),
              timestamp: assistantMessages[assistantMessages.length - 1].timestamp,
              usage: assistantMessages[assistantMessages.length - 1].message.usage || null
            } : null,
          };
        })
      );

      // 空セッションを除外（オプション）
      const finalList = excludeEmpty
        ? detailedList.filter(s => s.messageCount > 0)
        : detailedList;

      return c.json({ sessions: finalList });
    } catch (error) {
      console.error('[api] Error getting sessions:', error);
      return c.json({ error: 'Failed to get sessions' }, 500);
    }
  });

  // tool_use/tool_result/isMeta を除いた「本文だけのターン」に整形する
  // 本文が空になるターン（tool_use/tool_resultのみ等）は自然に除外される
  function extractTextTurn(event) {
    if (event.isMeta) return null;
    const msg = event.message;
    if (!msg || !msg.role) return null;

    const text = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.filter(item => item.type === 'text').map(item => item.text).join('')
        : '';

    if (!text.trim()) return null;
    return { role: msg.role, timestamp: event.timestamp, text };
  }

  // content（string または content block 配列）から text ブロックのUTF-8バイト数を算出
  // thinking/tool_use/tool_result は含めない
  function getTextBytes(content) {
    if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
    if (!Array.isArray(content)) return 0;
    const text = content.filter(item => item.type === 'text').map(item => item.text || '').join('');
    return Buffer.byteLength(text, 'utf8');
  }

  // イベント列を「シグナル」(メッセージ本文を含まない型・時刻・所要時間の配列)に変換する
  // - user/assistant: その行のtimestampを start=end とする1時点のマーカー（durationMs は常に0）
  // - tool-use: assistant行のtool_useブロックと、後続user行の対応するtool_resultブロックを
  //   tool_use_id で対応付け、両者のtimestamp差分をdurationMsとする
  // - tool_resultのみのuser行は単独シグナルを出さない（対応するtool-useのendとして吸収される）
  // - isMetaの行は除外（extractTextTurnと同じ扱い）
  function buildSignals(events) {
    const signals = [];
    const pendingToolUses = new Map(); // tool_use_id -> signal

    for (const event of events) {
      if (event.isMeta) continue;
      const role = event.message?.role;
      if (role !== 'user' && role !== 'assistant') continue;

      const content = event.message.content;
      const blocks = Array.isArray(content) ? content : [];

      // tool_result を先に処理して、対応するtool-useシグナルを完結させる
      const toolResults = blocks.filter(item => item.type === 'tool_result');
      for (const toolResult of toolResults) {
        const pending = pendingToolUses.get(toolResult.tool_use_id);
        if (pending) {
          pending.end = event.timestamp;
          pending.durationMs = new Date(event.timestamp).getTime() - new Date(pending.start).getTime();
          pendingToolUses.delete(toolResult.tool_use_id);
        }
      }

      if (role === 'assistant') {
        const toolUses = blocks.filter(item => item.type === 'tool_use');
        for (const toolUse of toolUses) {
          const signal = { type: 'tool-use', toolName: toolUse.name, start: event.timestamp, end: null, durationMs: null };
          signals.push(signal);
          pendingToolUses.set(toolUse.id, signal);
        }

        const textBytes = getTextBytes(content);
        if (textBytes > 0) {
          signals.push({ type: 'assistant', start: event.timestamp, end: event.timestamp, durationMs: 0, textBytes });
        }
      } else {
        // role === 'user': tool_resultのみの行は単独シグナルを出さない
        const isToolResultOnly = toolResults.length > 0 && blocks.every(item => item.type === 'tool_result');
        if (!isToolResultOnly) {
          const textBytes = getTextBytes(content);
          signals.push({ type: 'user', start: event.timestamp, end: event.timestamp, durationMs: 0, textBytes });
        }
      }
    }

    return signals;
  }

  // GET /sessions/:id/signals - メッセージ本文を含まない「シグナル」配列
  // (type, 時刻, 所要時間, テキストバイト数)。サブエージェントは別ファイル・別sessionIdのため自然に除外される
  api.get('/sessions/:id/signals', async (c) => {
    try {
      const sessionId = c.req.param('id');
      const projectPath = query(c, 'projectPath');
      const sessionLocation = await store.locate(sessionId, projectPath);

      if (!sessionLocation) {
        return c.json({ error: 'Session not found' }, 404);
      }

      const events = await store.read(sessionLocation);
      const signals = buildSignals(events);

      return c.json({
        sessionId,
        signals
      });
    } catch (error) {
      console.error('[api] Error getting session signals:', error);
      return c.json({ error: 'Failed to get session signals' }, 500);
    }
  });

  // GET /sessions/:id/messages - 全メッセージ一覧
  // ?textOnly=true でtool_use/tool_result/isMetaを除いた本文だけの配列に整形
  // ?limit=N で（整形後の）配列の末尾N件に絞る
  api.get('/sessions/:id/messages', async (c) => {
    try {
      const sessionId = c.req.param('id');
      const projectPath = query(c, 'projectPath');
      const sessionLocation = await store.locate(sessionId, projectPath);

      if (!sessionLocation) {
        return c.json({ error: 'Session not found' }, 404);
      }

      let events = await store.read(sessionLocation);

      if (query(c, 'textOnly') === 'true') {
        events = events.map(extractTextTurn).filter(Boolean);
      }

      const limit = parseInt(query(c, 'limit'), 10);
      if (Number.isInteger(limit) && limit > 0) {
        events = events.slice(-limit);
      }

      return c.json({
        sessionId,
        events
      });
    } catch (error) {
      console.error('[api] Error getting session messages:', error);
      return c.json({ error: 'Failed to get session messages' }, 500);
    }
  });

  // GET /sessions/:id/messages/user/first - 最初のユーザーメッセージ
  api.get('/sessions/:id/messages/user/first', async (c) => {
    try {
      const sessionId = c.req.param('id');
      const projectPath = query(c, 'projectPath');
      const sessionLocation = await store.locate(sessionId, projectPath);

      if (!sessionLocation) {
        return c.json({ error: 'Session not found' }, 404);
      }

      const events = await store.read(sessionLocation);
      const userMessages = events.filter(e => e.message && e.message.role === 'user');

      if (userMessages.length === 0) {
        return c.json({ error: 'No user messages found' }, 404);
      }

      return c.json({
        sessionId,
        message: userMessages[0]
      });
    } catch (error) {
      console.error('[api] Error getting first user message:', error);
      return c.json({ error: 'Failed to get first user message' }, 500);
    }
  });

  // GET /sessions/:id/messages/user/latest - 最後のユーザーメッセージ
  api.get('/sessions/:id/messages/user/latest', async (c) => {
    try {
      const sessionId = c.req.param('id');
      const projectPath = query(c, 'projectPath');
      const sessionLocation = await store.locate(sessionId, projectPath);

      if (!sessionLocation) {
        return c.json({ error: 'Session not found' }, 404);
      }

      const events = await store.read(sessionLocation);
      const userMessages = events.filter(e => e.message && e.message.role === 'user');

      if (userMessages.length === 0) {
        return c.json({ error: 'No user messages found' }, 404);
      }

      return c.json({
        sessionId,
        message: userMessages[userMessages.length - 1]
      });
    } catch (error) {
      console.error('[api] Error getting latest user message:', error);
      return c.json({ error: 'Failed to get latest user message' }, 500);
    }
  });

  // GET /sessions/:id/messages/assistant/first - 最初のアシスタントメッセージ
  api.get('/sessions/:id/messages/assistant/first', async (c) => {
    try {
      const sessionId = c.req.param('id');
      const projectPath = query(c, 'projectPath');
      const sessionLocation = await store.locate(sessionId, projectPath);

      if (!sessionLocation) {
        return c.json({ error: 'Session not found' }, 404);
      }

      const events = await store.read(sessionLocation);
      const assistantMessages = events.filter(e => e.message && e.message.role === 'assistant');

      if (assistantMessages.length === 0) {
        return c.json({ error: 'No assistant messages found' }, 404);
      }

      return c.json({
        sessionId,
        message: assistantMessages[0]
      });
    } catch (error) {
      console.error('[api] Error getting first assistant message:', error);
      return c.json({ error: 'Failed to get first assistant message' }, 500);
    }
  });

  // GET /sessions/:id/messages/assistant/latest - 最後のアシスタントメッセージ
  api.get('/sessions/:id/messages/assistant/latest', async (c) => {
    try {
      const sessionId = c.req.param('id');
      const projectPath = query(c, 'projectPath');
      const sessionLocation = await store.locate(sessionId, projectPath);

      if (!sessionLocation) {
        return c.json({ error: 'Session not found' }, 404);
      }

      const events = await store.read(sessionLocation);
      const assistantMessages = events.filter(e => e.message && e.message.role === 'assistant');

      if (assistantMessages.length === 0) {
        return c.json({ error: 'No assistant messages found' }, 404);
      }

      return c.json({
        sessionId,
        message: assistantMessages[assistantMessages.length - 1]
      });
    } catch (error) {
      console.error('[api] Error getting latest assistant message:', error);
      return c.json({ error: 'Failed to get latest assistant message' }, 500);
    }
  });

  // チャットメッセージ判定ヘルパー（ツール操作を除外した純粋な会話メッセージ）
  function isUserChat(event) {
    const msg = event.message;
    if (!msg || msg.role !== 'user') return false;
    if (typeof msg.content === 'string') return true;
    if (Array.isArray(msg.content)) {
      return !msg.content.some(item => item.type === 'tool_result');
    }
    return true;
  }

  function isAssistantChat(event) {
    const msg = event.message;
    if (!msg || msg.role !== 'assistant') return false;
    if (!Array.isArray(msg.content)) return false;
    const hasText = msg.content.some(item => item.type === 'text');
    const hasToolUse = msg.content.some(item => item.type === 'tool_use');
    return hasText && !hasToolUse;
  }

  // GET /sessions/:id/messages/chat/user/first - 最初のユーザーチャットメッセージ
  api.get('/sessions/:id/messages/chat/user/first', async (c) => {
    try {
      const sessionId = c.req.param('id');
      const projectPath = query(c, 'projectPath');
      const sessionLocation = await store.locate(sessionId, projectPath);

      if (!sessionLocation) {
        return c.json({ error: 'Session not found' }, 404);
      }

      const events = await store.read(sessionLocation);
      const chatMessages = events.filter(isUserChat);

      if (chatMessages.length === 0) {
        return c.json({ error: 'No user chat messages found' }, 404);
      }

      return c.json({ sessionId, message: chatMessages[0] });
    } catch (error) {
      console.error('[api] Error getting first user chat message:', error);
      return c.json({ error: 'Failed to get first user chat message' }, 500);
    }
  });

  // GET /sessions/:id/messages/chat/user/latest - 最後のユーザーチャットメッセージ
  api.get('/sessions/:id/messages/chat/user/latest', async (c) => {
    try {
      const sessionId = c.req.param('id');
      const projectPath = query(c, 'projectPath');
      const sessionLocation = await store.locate(sessionId, projectPath);

      if (!sessionLocation) {
        return c.json({ error: 'Session not found' }, 404);
      }

      const events = await store.read(sessionLocation);
      const chatMessages = events.filter(isUserChat);

      if (chatMessages.length === 0) {
        return c.json({ error: 'No user chat messages found' }, 404);
      }

      return c.json({ sessionId, message: chatMessages[chatMessages.length - 1] });
    } catch (error) {
      console.error('[api] Error getting latest user chat message:', error);
      return c.json({ error: 'Failed to get latest user chat message' }, 500);
    }
  });

  // GET /sessions/:id/messages/chat/assistant/first - 最初のアシスタントチャットメッセージ
  api.get('/sessions/:id/messages/chat/assistant/first', async (c) => {
    try {
      const sessionId = c.req.param('id');
      const projectPath = query(c, 'projectPath');
      const sessionLocation = await store.locate(sessionId, projectPath);

      if (!sessionLocation) {
        return c.json({ error: 'Session not found' }, 404);
      }

      const events = await store.read(sessionLocation);
      const chatMessages = events.filter(isAssistantChat);

      if (chatMessages.length === 0) {
        return c.json({ error: 'No assistant chat messages found' }, 404);
      }

      return c.json({ sessionId, message: chatMessages[0] });
    } catch (error) {
      console.error('[api] Error getting first assistant chat message:', error);
      return c.json({ error: 'Failed to get first assistant chat message' }, 500);
    }
  });

  // GET /sessions/:id/messages/chat/assistant/latest - 最後のアシスタントチャットメッセージ
  api.get('/sessions/:id/messages/chat/assistant/latest', async (c) => {
    try {
      const sessionId = c.req.param('id');
      const projectPath = query(c, 'projectPath');
      const sessionLocation = await store.locate(sessionId, projectPath);

      if (!sessionLocation) {
        return c.json({ error: 'Session not found' }, 404);
      }

      const events = await store.read(sessionLocation);
      const chatMessages = events.filter(isAssistantChat);

      if (chatMessages.length === 0) {
        return c.json({ error: 'No assistant chat messages found' }, 404);
      }

      return c.json({ sessionId, message: chatMessages[chatMessages.length - 1] });
    } catch (error) {
      console.error('[api] Error getting latest assistant chat message:', error);
      return c.json({ error: 'Failed to get latest assistant chat message' }, 500);
    }
  });

  // POST /sessions/new - 新規セッション作成
  api.post('/sessions/new', async (c) => {
    try {
      const { prompt, projectPath, cwd, allowedTools, disallowedTools, model, dangerouslySkipPermissions } = c.get('body');

      // 必須パラメータのチェック
      if (!prompt) {
        return c.json({ error: 'prompt is required' }, 400);
      }

      // projectPath または cwd の指定をチェック (projectPath を優先)
      const workingDirectory = projectPath || cwd;
      if (!workingDirectory) {
        return c.json({
          error: 'projectPath is required',
          message: 'Please specify projectPath (or cwd for backward compatibility) to set the working directory for the session'
        }, 400);
      }
      if (!fs.existsSync(workingDirectory)) {
        return c.json({
          error: 'projectPath does not exist',
          message: `The specified working directory does not exist: ${workingDirectory}`
        }, 400);
      }

      // dangerouslySkipPermissions のデフォルト値を config から取得
      const skipPermissions = dangerouslySkipPermissions !== undefined
        ? dangerouslySkipPermissions
        : defaultDangerouslySkipPermissions;

      // startNewSession を呼び出し
      const result = await startNewSession(adapter.spawn, prompt, {
        cwd: workingDirectory,
        allowedTools: allowedTools || [],
        disallowedTools: disallowedTools || [],
        model: model || undefined,
        dangerouslySkipPermissions: skipPermissions,
        projectPath: workingDirectory
      });

      return c.json({
        message: 'Session started',
        sessionId: result.sessionId,
        pid: result.pid,
        model: result.model,
        cwd: result.cwd,
        permissionMode: result.permissionMode,
        claudeCodeVersion: result.claudeCodeVersion,
        apiKeySource: result.apiKeySource,
        tools: result.tools
      });
    } catch (error) {
      console.error('[api] Error starting new session:', error);
      return c.json({ error: 'Failed to start new session' }, 500);
    }
  });

  // GET /processes - 管理中のプロセス一覧
  api.get('/processes', async (c) => {
    try {
      const processes = getManagedProcesses();
      return c.json({ processes });
    } catch (error) {
      console.error('[api] Error getting managed processes:', error);
      return c.json({ error: 'Failed to get managed processes' }, 500);
    }
  });

  // DELETE /processes/:sessionId - 指定プロセス強制終了
  api.delete('/processes/:sessionId', async (c) => {
    try {
      const sessionId = c.req.param('sessionId');
      const result = killProcess(sessionId);

      if (!result) {
        return c.json({
          error: 'Process not found',
          sessionId
        }, 404);
      }

      return c.json({
        message: 'Process terminated',
        ...result
      });
    } catch (error) {
      console.error('[api] Error killing process:', error);
      return c.json({ error: 'Failed to kill process' }, 500);
    }
  });

  // DELETE /processes - 全プロセス強制終了（緊急用）
  api.delete('/processes', async (c) => {
    try {
      const result = killAllProcesses();
      return c.json({
        message: 'All processes terminated',
        ...result
      });
    } catch (error) {
      console.error('[api] Error killing all processes:', error);
      return c.json({ error: 'Failed to kill all processes' }, 500);
    }
  });

  // POST /sessions/:id/send - 既存セッションにメッセージを送信
  api.post('/sessions/:id/send', async (c) => {
    try {
      const sessionId = c.req.param('id');
      const { prompt, projectPath, cwd, allowedTools, disallowedTools, model, dangerouslySkipPermissions } = c.get('body');

      // 必須パラメータのチェック
      if (!prompt) {
        return c.json({ error: 'prompt is required' }, 400);
      }

      // projectPath または cwd の指定をチェック (projectPath を優先)
      const workingDirectory = projectPath || cwd;
      if (!workingDirectory) {
        return c.json({
          error: 'projectPath is required',
          message: 'Please specify projectPath (or cwd for backward compatibility) to set the working directory for the session'
        }, 400);
      }
      if (!fs.existsSync(workingDirectory)) {
        return c.json({
          error: 'projectPath does not exist',
          message: `The specified working directory does not exist: ${workingDirectory}`
        }, 400);
      }

      // セッションが存在するか確認
      const sessionLocation = await store.locate(sessionId);
      if (!sessionLocation) {
        return c.json({ error: 'Session not found' }, 404);
      }

      // dangerouslySkipPermissions のデフォルト値を config から取得
      const skipPermissions = dangerouslySkipPermissions !== undefined
        ? dangerouslySkipPermissions
        : defaultDangerouslySkipPermissions;

      // sendToSession を呼び出し
      const result = await sendToSession(adapter.spawn, sessionId, prompt, {
        cwd: workingDirectory,
        allowedTools: allowedTools || [],
        disallowedTools: disallowedTools || [],
        model: model || undefined,
        dangerouslySkipPermissions: skipPermissions,
        projectPath: workingDirectory
      });

      return c.json({
        success: true,
        sessionId: result.sessionId,
        pid: result.pid,
        model: result.model,
        cwd: result.cwd,
        permissionMode: result.permissionMode,
        claudeCodeVersion: result.claudeCodeVersion,
        apiKeySource: result.apiKeySource,
        message: 'Message sent successfully'
      });
    } catch (error) {
      console.error('[api] Error sending message:', error);
      return c.json({ error: 'Failed to send message' }, 500);
    }
  });

  // GET /attachments-config - アップロード設定を返す
  api.get('/attachments-config', async (c) => {
    return c.json({
      maxBodySize: config.upload?.maxBodySize || '10mb',
      allowedExtensions: config.upload?.allowedExtensions || ['.jpg', '.jpeg', '.png', '.pdf', '.txt', '.md', '.docx', '.xlsx', '.csv']
    });
  });

  // POST /attachments - ファイルを /tmp/coding-agent-pipe/ に保存
  // body: { data: base64文字列, filename: "photo.png" }
  api.post('/attachments', async (c) => {
    const { data, filename } = c.get('body');
    if (!data || !filename) {
      return c.json({ error: 'data and filename are required' }, 400);
    }

    const ext = path.extname(filename).toLowerCase();
    const allowed = config.upload?.allowedExtensions || ['.jpg', '.jpeg', '.png', '.pdf', '.txt', '.md', '.docx', '.xlsx', '.csv'];
    if (!allowed.includes(ext)) {
      return c.json({ error: `File type not allowed. Allowed: ${allowed.join(', ')}` }, 400);
    }

    const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const tmpDir = ATTACHMENTS_TMP_DIR;
    fs.mkdirSync(tmpDir, { recursive: true });

    const uuid = crypto.randomUUID();
    const savedFilename = `${uuid}-${safeName}`;
    const filePath = path.join(tmpDir, savedFilename);

    try {
      const buffer = Buffer.from(data, 'base64');
      fs.writeFileSync(filePath, buffer);
      return c.json({ path: filePath, filename: savedFilename });
    } catch (error) {
      console.error('[api] Error saving attachment:', error);
      return c.json({ error: 'Failed to save file' }, 500);
    }
  });

  // POST /projects/file - projectPath 配下のテキストファイルの内容を返す
  // body: { projectPath: string, filePath: string(相対パス) }
  api.post('/projects/file', async (c) => {
    const { projectPath, filePath } = c.get('body');
    if (!projectPath || !filePath) {
      return c.json({ error: 'projectPath and filePath are required' }, 400);
    }

    if (!fs.existsSync(projectPath)) {
      return c.json({ error: 'projectPath does not exist' }, 400);
    }

    let baseDir;
    try {
      baseDir = fs.realpathSync(path.resolve(projectPath));
    } catch (error) {
      return c.json({ error: 'projectPath does not exist' }, 400);
    }

    // symlink 解決前の字面上のパスでまず簡易チェック（無駄な fs アクセスを避ける）
    const lexicalResolved = path.resolve(baseDir, filePath);
    if (lexicalResolved !== baseDir && !lexicalResolved.startsWith(baseDir + path.sep)) {
      return c.json({ error: 'filePath must resolve within projectPath' }, 400);
    }

    if (!fs.existsSync(lexicalResolved)) {
      return c.json({ error: 'File not found' }, 404);
    }

    let realPath;
    try {
      realPath = fs.realpathSync(lexicalResolved);
    } catch (error) {
      return c.json({ error: 'File not found' }, 404);
    }

    // symlink 経由での projectPath 脱出を防ぐ
    if (realPath !== baseDir && !realPath.startsWith(baseDir + path.sep)) {
      return c.json({ error: 'filePath must resolve within projectPath' }, 400);
    }

    const relPath = path.relative(baseDir, realPath);

    // ドットファイル・ドットディレクトリ（.env, .git, .ssh 等）は常にブロック
    // secrets 系はここで拾う。中身を見たい場合は code-server 等を利用する
    if (relPath.split(path.sep).some(segment => segment.startsWith('.'))) {
      return c.json({ error: 'Hidden files/directories are not viewable via this API. Use code-server instead.' }, 400);
    }

    const ext = path.extname(realPath).toLowerCase();
    const imageExtensions = config.viewer?.imageExtensions || DEFAULT_VIEWER_IMAGE_EXTENSIONS;
    const isImage = imageExtensions.includes(ext);

    if (!isImage) {
      const deniedExtensions = config.viewer?.deniedExtensions || DEFAULT_VIEWER_DENIED_EXTENSIONS;
      if (deniedExtensions.includes(ext)) {
        return c.json({ error: `File type not viewable via this API: ${ext || '(no extension)'}. Use code-server instead.` }, 400);
      }
    }

    // .gitignore 対象は判定できる場合のみブロック（git リポジトリでない場合はベストエフォート）
    if (isPathGitIgnored(baseDir, relPath) === true) {
      return c.json({ error: 'File is git-ignored and not viewable via this API. Use code-server instead.' }, 400);
    }

    let stat;
    try {
      stat = fs.statSync(realPath);
    } catch (error) {
      return c.json({ error: 'File not found' }, 404);
    }

    if (!stat.isFile()) {
      return c.json({ error: 'filePath must point to a regular file' }, 400);
    }

    const maxSize = isImage
      ? (config.viewer?.maxImageFileSize || 5 * 1024 * 1024) // 5MB
      : (config.viewer?.maxFileSize || 1024 * 1024); // 1MB
    if (stat.size > maxSize) {
      return c.json({ error: `File too large. Max size: ${maxSize} bytes` }, 413);
    }

    try {
      if (isImage) {
        const content = fs.readFileSync(realPath).toString('base64');
        return c.json({
          content,
          mtime: stat.mtime.toISOString(),
          size: stat.size,
          encoding: 'base64',
          mimeType: IMAGE_MIME_TYPES[ext] || 'application/octet-stream'
        });
      } else {
        const content = fs.readFileSync(realPath, 'utf8');
        return c.json({
          content,
          mtime: stat.mtime.toISOString(),
          size: stat.size,
          encoding: 'utf8'
        });
      }
    } catch (error) {
      console.error('[api] Error reading project file:', error);
      return c.json({ error: 'Failed to read file' }, 500);
    }
  });

  // GET /git/status?projectPath=...&files=true - Git ステータス
  // デフォルトはカウントのみ、?files=true でファイル一覧を含む
  api.get('/git/status', async (c) => {
    const projectPath = query(c, 'projectPath');
    if (!projectPath) {
      return c.json({ error: 'projectPath is required' }, 400);
    }
    const result = getGitStatus(projectPath);
    if (!result) {
      return c.json({ error: 'Not a git repository' }, 404);
    }
    if (query(c, 'files') === 'true') {
      return c.json(result);
    }
    return c.json({
      branch: result.branch,
      ahead: result.ahead,
      behind: result.behind,
      stagedCount: result.staged.length,
      unstagedCount: result.unstaged.length,
      untrackedCount: result.untracked.length,
      isClean: result.isClean
    });
  });

  // GET /git/log?projectPath=...&limit=20 - Git ログ（未プッシュ含む）
  api.get('/git/log', async (c) => {
    const projectPath = query(c, 'projectPath');
    if (!projectPath) {
      return c.json({ error: 'projectPath is required' }, 400);
    }
    const limit = Math.min(parseInt(query(c, 'limit'), 10) || 20, 100);
    const result = getGitLog(projectPath, limit);
    if (!result) {
      return c.json({ error: 'Not a git repository' }, 404);
    }
    return c.json(result);
  });

  // エンジン固有のルート(例: claude-code の GET /claude-version)
  if (adapter.mountRoutes) adapter.mountRoutes(api);

  return api;
}

export {
  createApiRouter,
  cleanupOldAttachments
};
