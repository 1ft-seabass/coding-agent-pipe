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

import { parseLine } from './parse.js';
import { extractProjectPath, isSubagent, isAgentSession, sessionIdFromPath } from './project.js';
import { createSessions } from './sessions.js';
import { buildArgs, spawnProcess, parseInit } from './spawn.js';

const defaultWatchDir = '~/.codex/sessions';

/**
 * @param {object} config - 設定オブジェクト(watchDir を使う)
 */
export default function createAdapter(config) {
  return {
    id: 'codex',
    backendType: 'codex',
    observe: { kind: 'file-tail', extension: '.jsonl' },
    defaultWatchDir,
    parse: parseLine,
    sessionIdFromPath,
    resolveProject: extractProjectPath,
    isSubagent,
    isAgentSession,
    sessions: createSessions(config.watchDir),
    spawn: { buildArgs, spawnProcess, parseInit }
  };
}

export { defaultWatchDir };
