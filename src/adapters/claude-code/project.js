/**
 * project.js - Claude Code のセッションファイルからプロジェクトを割り出す
 *
 * Claude Code は ~/.claude/projects/<エンコードされたプロジェクトパス>/<sessionId>.jsonl に
 * セッションを保存する。このエンコード規則は Claude Code 固有の知識なので、adapter に置く。
 */

import fs from 'node:fs';
import path from 'node:path';
import { isWindowsNonWSL } from '../../core/platform.js';

// プロジェクトパスのキャッシュ（パフォーマンス最適化）
const projectPathCache = new Map();

/**
 * JSONL ファイルパスからプロジェクトパスを抽出
 * @param {string} jsonlFilePath - JSONL ファイルのフルパス
 * @returns {string|null} - プロジェクトのフルパス、または null
 *
 * Unix の例: ~/.claude/projects/-home-user-workspace-repos-my-app/session-id.jsonl
 * → /home/user/workspace/repos/my-app
 *
 * Windows の例: ~/.claude/projects/C--Users-user-workspace-my-app/session-id.jsonl
 * → C:\Users\user\workspace\my-app
 *
 * 注: Claude はパス区切り文字を "-" に変換してエンコードするため、元のパスに "-" が
 * 含まれる場合は正確に復元できない。そのため、実際に存在するパスを探す。
 * 一度解決したパスはキャッシュして再利用する。
 */
function extractProjectPath(jsonlFilePath) {
  try {
    const dir = path.dirname(jsonlFilePath);
    const projectDirName = path.basename(dir);
    const isWindows = isWindowsNonWSL();

    // ディレクトリ名がエンコードされたパスかどうかを判定
    // Unix: "-home-user-project" のように "-" で始まる
    // Windows: "C--Users-user-project" のようにドライブレター + "--" で始まる
    if (isWindows) {
      if (!/^[A-Za-z]--/.test(projectDirName)) {
        return null;
      }
    } else {
      if (!projectDirName.startsWith('-')) {
        return null;
      }
    }

    // キャッシュをチェック
    if (projectPathCache.has(projectDirName)) {
      return projectPathCache.get(projectDirName);
    }

    // JSONL ファイルの先頭から cwd フィールドを探す（最も信頼性が高い方法、OS非依存）
    // ハイフンを含むパスでも正確に復元できる
    try {
      const fd = fs.openSync(jsonlFilePath, 'r');
      try {
        const buffer = Buffer.alloc(2048);
        const bytesRead = fs.readSync(fd, buffer, 0, 2048, 0);
        const content = buffer.slice(0, bytesRead).toString('utf8');
        const lines = content.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.cwd) {
              projectPathCache.set(projectDirName, parsed.cwd);
              return parsed.cwd;
            }
          } catch (e) {
            // JSON パース失敗は無視して次の行へ
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      // ファイル読み取り失敗は無視して既存ロジックにフォールバック
    }

    if (isWindows) {
      // ドライブレター1文字 + "--" (":" と "\" のエンコード) を除去
      const driveLetter = projectDirName[0];
      const encoded = projectDirName.substring(3);

      const commonDepths = [3, 4, 5, 2, 6];

      for (const depth of commonDepths) {
        const parts = encoded.split('-');
        if (parts.length >= depth) {
          const candidatePath = `${driveLetter}:\\` + parts.slice(0, depth).join('\\') +
                               (parts.length > depth ? '-' + parts.slice(depth).join('-') : '');

          try {
            if (fs.existsSync(candidatePath)) {
              projectPathCache.set(projectDirName, candidatePath);
              return candidatePath;
            }
          } catch (e) {
            // 無視
          }
        }
      }

      // 見つからない場合は、残り全ての "-" を "\" に変換したパスを試す
      const fullPath = `${driveLetter}:\\` + encoded.replace(/-/g, '\\');
      projectPathCache.set(projectDirName, fullPath);
      return fullPath;
    }

    // 先頭の "-" を削除
    const encoded = projectDirName.substring(1);

    // まず、最も一般的なパターン（深さ3-5のパス）を試す
    // 例: /home/user/project, /home/user/workspace/project など
    const commonDepths = [3, 4, 5, 2, 6];

    for (const depth of commonDepths) {
      const parts = encoded.split('-');
      if (parts.length >= depth) {
        const candidatePath = '/' + parts.slice(0, depth).join('/') +
                             (parts.length > depth ? '-' + parts.slice(depth).join('-') : '');

        try {
          if (fs.existsSync(candidatePath)) {
            projectPathCache.set(projectDirName, candidatePath);
            return candidatePath;
          }
        } catch (e) {
          // 無視
        }
      }
    }

    // 見つからない場合は、全ての "-" を "/" に変換したパスを試す
    const fullPath = '/' + encoded.replace(/-/g, '/');
    projectPathCache.set(projectDirName, fullPath);
    return fullPath;

  } catch (error) {
    console.error('[subscribers] Failed to extract project path:', error.message);
    return null;
  }
}

/**
 * サブエージェントのセッションファイルかどうか（<session>/subagents/ 配下）
 * @param {string} sourcePath - JSONL ファイルのフルパス
 */
function isSubagent(sourcePath) {
  return !!(sourcePath && sourcePath.includes('/subagents/'));
}

/**
 * エージェント自身が作るセッション(agent-*)かどうか。一覧では既定で除外する
 * @param {string} sessionId
 */
function isAgentSession(sessionId) {
  return sessionId.startsWith('agent-');
}

/**
 * ファイルパスからセッション ID を推定（JSONL の行に sessionId が無いときの補完用）
 * ~/.claude/projects/<hash>/sessions/<session-id>/ の構造を想定
 */
function sessionIdFromPath(filePath) {
  const match = filePath.match(/sessions[/\\]([^/\\]+)[/\\]/);
  return match ? match[1] : null;
}

export { extractProjectPath, isSubagent, isAgentSession, sessionIdFromPath };
