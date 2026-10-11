/**
 * sessions.js - Codex のセッション(rollout-*.jsonl)の一覧・検索・読み込み
 *
 * REST の読み取り口(GET /sessions など)が使う、セッションデータへの入口。
 * core はここから返る「正規化済みイベント」だけを見て、ファイルの配置は知らない。
 * セッションの id は、ファイル名の UUID(claude-code のように、拡張子を除いたファイル名ではない)。
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseLine, usageFromRecord } from './parse.js';
import { extractProjectPath, isSubagent, sessionIdFromPath } from './project.js';
import { expandHome } from '../../core/platform.js';

/**
 * token_usage_record の行を、assistant のイベントの message.usage に足す(同じ直前のイベントに複数あれば合計する)
 * 壊れた行は無視する。
 */
function addUsage(assistantEvent, line) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch (error) {
    return;
  }
  if (!raw || raw.type !== 'token_usage_record') return;
  const add = usageFromRecord(raw);
  const current = assistantEvent.message.usage;
  if (!current) {
    assistantEvent.message.usage = add;
    return;
  }
  for (const key of Object.keys(add)) current[key] += add[key];
}

/**
 * @param {string} watchDir - セッションの置き場(~/.codex/sessions など)
 */
function createSessions(watchDir) {
  const normalizedWatchDir = expandHome(watchDir);

  /**
   * セッションの一覧を取得
   * @returns {Promise<Array<{id: string, path: string, mtime: number}>>}
   */
  async function list() {
    const sessions = [];

    async function findRollouts(dir) {
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await findRollouts(fullPath);
          } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            const sessionId = sessionIdFromPath(entry.name);
            if (!sessionId) continue; // rollout-<日時>-<UUID>.jsonl 以外は、セッションでない
            const stats = await fs.promises.stat(fullPath);
            // サブエージェントのセッションを見分けて登録する(一覧の既定の除外は、id だけで判定されるため)
            isSubagent(fullPath);
            sessions.push({ id: sessionId, path: fullPath, mtime: stats.mtime.getTime() });
          }
        }
      } catch (error) {
        // ディレクトリが存在しない等のエラーは無視
      }
    }

    await findRollouts(normalizedWatchDir);
    return sessions;
  }

  /**
   * 指定セッションの場所(read に渡す値)を取得
   * @param {string} sessionId - セッション ID
   * @param {string} [projectPath] - プロジェクトパス(指定すると、そのプロジェクトのセッションに絞る)
   * @returns {Promise<string|null>}
   */
  async function locate(sessionId, projectPath) {
    const sessions = await list();

    if (projectPath) {
      const normalizedProjectPath = path.normalize(projectPath);
      const session = sessions.find((s) => {
        if (s.id !== sessionId) return false;
        const sessionProjectPath = extractProjectPath(s.path);
        return sessionProjectPath && path.normalize(sessionProjectPath) === normalizedProjectPath;
      });
      return session ? session.path : null;
    }

    const session = sessions.find((s) => s.id === sessionId);
    return session ? session.path : null;
  }

  /**
   * セッションを全行パースして、正規化済みイベントの配列を返す
   * @param {string} location - list / locate が返した場所
   */
  async function read(location) {
    const content = await fs.promises.readFile(location, 'utf8');
    const events = [];
    let lastAssistant = null; // 直前の assistant のイベント。token_usage_record のトークン数を足す先

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const event = parseLine(line);
      if (event) {
        events.push(event);
        if (event.message.role === 'assistant') lastAssistant = event;
      } else if (lastAssistant && line.includes('"token_usage_record"')) {
        addUsage(lastAssistant, line);
      }
    }

    return events;
  }

  return { list, locate, read };
}

export { createSessions };
