/**
 * adapters/claude-code - Claude Code エンジンの adapter
 *
 * adapter ＝ そのエンジン固有の知識(どこを読むか・どう解釈するか・どう起動するか)を一束にしたもの。
 * core からは、次の同じ面だけが見える。
 *
 *   id               エンジンの識別子(config.engine / config.engines の値。webhook と GET /info の engine)
 *   observe          観測の方法({ kind: 'file-tail', extension })
 *   parse(line)      観測した1行を正規化イベントに変換する(解釈できなければ null)
 *   sessionIdFromPath(path)   sessionId が無い行の補完
 *   resolveProject(path)      セッションの出どころからプロジェクトのパスを割り出す
 *   isSubagent(path)          サブエージェントのセッションか
 *   isAgentSession(sessionId) エージェント自身が作るセッションか(一覧で既定は除外)
 *   sessions         { list, locate, read } REST の読み取り口が使うセッションデータへの入口
 *   spawn            { buildArgs, spawnProcess, parseInit } プロセスの起動方法
 *   mountRoutes(api) エンジン固有の REST ルートを登録する(任意)
 *   defaultWatchDir  置き場(watchDir)が設定に無いときの既定の場所。loadAdapter が設定に入れる
 *   auth             { command, args, parse } ログイン状態の確認(GET /engine/:id/auth)
 */

import { parseLine } from './parse.js';
import { extractProjectPath, isSubagent, isAgentSession, sessionIdFromPath } from './project.js';
import { createSessions } from './sessions.js';
import { buildArgs, spawnProcess, parseInit } from './spawn.js';
import { mountRoutes } from './routes.js';
import { auth } from './auth.js';

const defaultWatchDir = '~/.claude/projects';

/**
 * @param {object} config - 設定オブジェクト(watchDir を使う)
 */
export default function createAdapter(config) {
  return {
    id: 'claude-code',
    defaultWatchDir,
    observe: { kind: 'file-tail', extension: '.jsonl' },
    parse: parseLine,
    sessionIdFromPath,
    resolveProject: extractProjectPath,
    isSubagent,
    isAgentSession,
    sessions: createSessions(config.watchDir),
    spawn: { buildArgs, spawnProcess, parseInit },
    auth,
    mountRoutes
  };
}

export { defaultWatchDir };
