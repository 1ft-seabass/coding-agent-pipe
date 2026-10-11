/**
 * project.js - Codex のセッションファイルから、sessionId・プロジェクト・サブエージェントかどうかを割り出す
 *
 * Codex は ~/.codex/sessions/YYYY/MM/DD/rollout-<日時>-<UUID>.jsonl にセッションを保存する。
 * ディレクトリは日付なので、プロジェクトはパスから分からない。プロジェクト(作業ディレクトリ)と、
 * サブエージェントかどうかは、ファイルの1行目(type: session_meta)にある。
 *   payload.cwd           作業ディレクトリ
 *   payload.thread_source サブエージェントのとき 'subagent'(通常は 'user')
 *   payload.source        サブエージェントのとき { subagent: { thread_spawn: { parent_thread_id, ... } } }
 *                         (通常は 'exec' などの文字列)
 */

import fs from 'node:fs';

const ROLLOUT_NAME = /rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// 1行目は大きい(指示の本文を含み、実測で約 22KB)。改行が見つかるまで読むが、読む量には上限を置く
const READ_CHUNK = 64 * 1024;
const MAX_FIRST_LINE = 1024 * 1024;

// 読めた1行目の情報(ファイルごと。1行目は変わらない)。読めなかったものは入れない
const metaCache = new Map();
// サブエージェントのセッションの id。isAgentSession(id) が、id だけで答えるための控え
const subagentIds = new Set();

/** ファイル名の UUID を sessionId として返す */
function sessionIdFromPath(filePath) {
  const match = ROLLOUT_NAME.exec(String(filePath));
  return match ? match[1] : null;
}

/** ファイルの1行目を返す。改行まで読めなかった(書き込みの途中の)ときは null */
function readFirstLine(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const chunks = [];
    let total = 0;
    let position = 0;
    while (total < MAX_FIRST_LINE) {
      const buffer = Buffer.alloc(READ_CHUNK);
      const bytesRead = fs.readSync(fd, buffer, 0, READ_CHUNK, position);
      if (bytesRead === 0) return null;
      const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
      if (newline !== -1) {
        chunks.push(buffer.subarray(0, newline));
        return Buffer.concat(chunks).toString('utf8');
      }
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
      position += bytesRead;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** payload が、サブエージェントのセッションのものか */
function isSubagentPayload(payload) {
  if (payload.thread_source === 'subagent') return true;
  return !!payload.source && typeof payload.source === 'object' && 'subagent' in payload.source;
}

/**
 * 1行目(session_meta)から、プロジェクトのパスとサブエージェントかどうかを読む。
 * 読めなかった(ファイルが無い・書き込みの途中・session_meta でない・壊れている)ときは null で、キャッシュしない。
 */
function readSessionMeta(filePath) {
  if (metaCache.has(filePath)) {
    return metaCache.get(filePath);
  }
  try {
    const line = readFirstLine(filePath);
    if (!line) return null;
    const first = JSON.parse(line);
    if (first.type !== 'session_meta' || !first.payload) return null;
    const meta = {
      cwd: typeof first.payload.cwd === 'string' && first.payload.cwd ? first.payload.cwd : null,
      subagent: isSubagentPayload(first.payload)
    };
    metaCache.set(filePath, meta);
    if (meta.subagent) {
      const id = sessionIdFromPath(filePath);
      if (id) subagentIds.add(id);
    }
    return meta;
  } catch (e) {
    // ファイルが無い・読めない・壊れている: 割り出せない(次の呼び出しで、もう一度試す)
    return null;
  }
}

/**
 * セッションファイルからプロジェクトのパス(cwd)を割り出す
 * @param {string} filePath - rollout-*.jsonl のフルパス
 * @returns {string|null} プロジェクトのパス。割り出せなければ null
 */
function extractProjectPath(filePath) {
  const meta = readSessionMeta(filePath);
  return meta ? meta.cwd : null;
}

/** サブエージェントのセッションか(読めなかったときは false) */
function isSubagent(filePath) {
  const meta = readSessionMeta(filePath);
  return meta ? meta.subagent : false;
}

/**
 * サブエージェントのセッションか(id だけで答える)。
 * ファイルを読んだことがあるセッションだけが分かる(一覧を作ると、すべて読まれる)。
 */
function isAgentSession(sessionId) {
  return subagentIds.has(sessionId);
}

export { extractProjectPath, isSubagent, isAgentSession, sessionIdFromPath };
