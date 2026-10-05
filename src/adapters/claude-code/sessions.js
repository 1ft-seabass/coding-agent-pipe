/**
 * sessions.js - Claude Code のセッション(JSONL ファイル)の一覧・検索・読み込み
 *
 * REST の読み取り口(GET /sessions など)が使う、セッションデータへの入口。
 * core はここから返る「正規化済みイベント」だけを見て、ファイルの配置は知らない。
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseLine } from './parse.js';
import { extractProjectPath } from './project.js';
import { expandHome } from '../../core/platform.js';

/**
 * @param {string} watchDir - セッションの置き場(~/.claude/projects など)
 */
function createSessions(watchDir) {
  const normalizedWatchDir = expandHome(watchDir);

  /**
   * セッションの一覧を取得
   * @returns {Promise<Array<{id: string, path: string, mtime: number}>>}
   */
  async function list() {
    const sessions = [];

    async function findJSONLFiles(dir) {
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await findJSONLFiles(fullPath);
          } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            const stats = await fs.promises.stat(fullPath);
            // ファイル名からセッションIDを抽出（拡張子を除く）
            const sessionId = path.basename(entry.name, '.jsonl');
            sessions.push({
              id: sessionId,
              path: fullPath,
              mtime: stats.mtime.getTime()
            });
          }
        }
      } catch (error) {
        // ディレクトリが存在しない等のエラーは無視
      }
    }

    await findJSONLFiles(normalizedWatchDir);
    return sessions;
  }

  /**
   * 指定セッションの場所(read に渡す値)を取得
   * @param {string} sessionId - セッション ID
   * @param {string} [projectPath] - プロジェクトパス（オプション）
   * @returns {Promise<string|null>}
   */
  async function locate(sessionId, projectPath) {
    const sessions = await list();

    // projectPath が指定されている場合、そのプロジェクト内のみ検索
    if (projectPath) {
      const normalizedProjectPath = path.normalize(projectPath);
      const session = sessions.find(s => {
        const sessionProjectPath = extractProjectPath(s.path);
        return s.id === sessionId && sessionProjectPath && path.normalize(sessionProjectPath) === normalizedProjectPath;
      });
      return session ? session.path : null;
    }

    // projectPath が指定されていない場合は従来通り
    const session = sessions.find(s => s.id === sessionId);
    return session ? session.path : null;
  }

  /**
   * セッションを全行パースして、正規化済みイベントの配列を返す
   * @param {string} location - list / locate が返した場所
   */
  async function read(location) {
    const content = await fs.promises.readFile(location, 'utf8');
    const lines = content.split('\n');
    const events = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      const event = parseLine(line);
      if (event) {
        events.push(event);
      }
    }

    return events;
  }

  return { list, locate, read };
}

export { createSessions };
