/**
 * adapters/codex - Codex(OpenAI の Codex CLI)エンジンの adapter
 *
 * 面は claude-code adapter と同じ(詳細は adapters/claude-code/index.js)。
 *
 *   observe    ~/.codex/sessions/YYYY/MM/DD/rollout-<日時>-<UUID>.jsonl を追いかける(file-tail)
 *   parse      response_item の行だけを、claude-code と同じ正規化イベントに写す
 *   spawn      codex exec を起動する(標準入力を閉じる。PTY は使わない)
 *
 * defaultWatchDir: config.watchDir が無いときの置き場。loadAdapter が config に入れる。
 */

import fs from 'node:fs';
import { parseLine, usageFromRecord } from './parse.js';
import { extractProjectPath, isSubagent, isAgentSession, sessionIdFromPath } from './project.js';
import { createSessions } from './sessions.js';
import { buildArgs, spawnProcess, parseInit } from './spawn.js';
import { auth } from './auth.js';

const defaultWatchDir = '~/.codex/sessions';

/**
 * ファイルの中で、いちばん後ろの token_usage_record の usage を返す(無い・読めないときは null)。
 * ライブの観測が、そのファイルを最初に見たときの、「直前に受け取った usage」の初期値に使う(再開したセッションの最初の応答に、前の値を載せるため)。
 */
function lastUsageInFile(filePath) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"token_usage_record"')) continue;
      try {
        const raw = JSON.parse(lines[i]);
        if (raw && raw.type === 'token_usage_record') return usageFromRecord(raw);
      } catch { /* 壊れた行は飛ばして、1 つ前を探す */ }
    }
  } catch { /* 読めなければ、初期値なし */ }
  return null;
}

/**
 * ファイルごとに「いまのモデル」と「直前に受け取った usage」を覚える parse を作る
 * (turn_context の行で model、token_usage_record の行で usage を覚え、続く assistant のイベントに載せる)。
 * ライブの観測なので、ターンの失敗(task_complete の error)も、エラーのイベントにする(emitErrors)。
 * 複数のセッションの行が混ざるので、覚える先はファイルのパスごとに分ける。
 */
function createParse() {
  const ctxByFile = new Map();
  return (line, filePath) => {
    let ctx;
    if (filePath) {
      ctx = ctxByFile.get(filePath);
      if (!ctx) { ctx = { model: null, carryUsage: true, emitErrors: true, usage: lastUsageInFile(filePath) }; ctxByFile.set(filePath, ctx); }
    }
    return parseLine(line, ctx);
  };
}

/**
 * @param {object} config - 設定オブジェクト(watchDir を使う)
 */
export default function createAdapter(config) {
  return {
    id: 'codex',
    observe: { kind: 'file-tail', extension: '.jsonl' },
    defaultWatchDir,
    parse: createParse(),
    sessionIdFromPath,
    resolveProject: extractProjectPath,
    isSubagent,
    isAgentSession,
    sessions: createSessions(config.watchDir),
    spawn: { buildArgs, spawnProcess, parseInit },
    auth
  };
}

export { defaultWatchDir };
