/**
 * spawn.js - claude -p の起動に関する、Claude Code 固有の知識
 *
 * 引数の組み立て・PTY を使った起動・system/init の読み取り。
 * プロセスの管理(タイムアウト、イベント発行、kill)は core/process.js が担当する。
 */

import { spawn } from 'node:child_process';
import { isWindowsNonWSL } from '../../core/platform.js';

/**
 * claude コマンドの引数を組み立てる
 * @param {object} options
 * @param {string} options.prompt - プロンプトテキスト
 * @param {string} [options.resumeId] - 再開するセッション ID(省略すると新規セッション)
 * @param {Array<string>} [options.allowedTools] - 許可ツールのリスト
 * @param {Array<string>} [options.disallowedTools] - 禁止ツールのリスト
 * @param {string} [options.model] - 使用モデル (例: "sonnet", "opus", "claude-sonnet-4-6")
 * @param {boolean} [options.dangerouslySkipPermissions] - 権限確認をスキップ（危険）
 * @returns {Array<string>}
 */
function buildArgs({ prompt, resumeId, allowedTools, disallowedTools, model, dangerouslySkipPermissions }) {
  const claudeArgs = resumeId
    ? ['-p', prompt, '--resume', resumeId, '--output-format', 'stream-json', '--verbose']
    : ['-p', prompt, '--output-format', 'stream-json', '--verbose'];

  if (allowedTools && allowedTools.length > 0) {
    claudeArgs.push('--allowedTools', allowedTools.join(' '));
  }

  if (disallowedTools && disallowedTools.length > 0) {
    claudeArgs.push('--disallowedTools', disallowedTools.join(' '));
  }

  if (model) {
    claudeArgs.push('--model', model);
  }

  if (dangerouslySkipPermissions) {
    claudeArgs.push('--dangerously-skip-permissions');
  }

  return claudeArgs;
}

/**
 * claude プロセスを起動する（起動方法のみプラットフォームで分岐）
 * @param {Array<string>} claudeArgs - claude コマンドの引数配列
 * @param {string} cwd - 作業ディレクトリ
 * @returns {import('child_process').ChildProcess}
 */
function spawnProcess(claudeArgs, cwd) {
  if (isWindowsNonWSL()) {
    // 配列渡し・shell不要のためエスケープ処理は不要
    // (Windows ネイティブでの動作は、実機で確認している)
    return spawn('claude', claudeArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  // script コマンドで PTY を提供してバッファリングを回避
  // シェル展開を防ぐため全引数をダブルクォートで囲み \ " ` $ をエスケープする
  const claudeCommand = `claude ${claudeArgs.map(arg =>
    `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$')}"`
  ).join(' ')}`;

  return spawn('script', ['-q', '-c', claudeCommand, '/dev/null'], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

/**
 * stdout の1行(JSON)が system/init なら、その情報を返す。そうでなければ null
 * @param {object} json - stream-json の1行をパースしたもの
 * @returns {object|null} { sessionId, model, cwd, permissionMode, claudeCodeVersion, codingAgentVersion, apiKeySource, tools }
 */
function parseInit(json) {
  if (!(json.type === 'system' && json.subtype === 'init')) {
    return null;
  }
  return {
    sessionId: json.session_id || null,
    model: json.model || null,
    cwd: json.cwd || null,
    permissionMode: json.permissionMode || null,
    claudeCodeVersion: json.claude_code_version || null,
    codingAgentVersion: json.claude_code_version || null,
    apiKeySource: json.apiKeySource || null,
    tools: json.tools || [],
  };
}

export { buildArgs, spawnProcess, parseInit };
