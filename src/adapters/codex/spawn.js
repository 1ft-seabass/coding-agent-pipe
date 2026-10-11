/**
 * spawn.js - codex exec の起動に関する、Codex 固有の知識
 *
 * 引数の組み立て・起動・thread.started の読み取り。
 * プロセスの管理(タイムアウト、イベント発行、kill)は core/process.js が担当する。
 *
 * 実物で確かめたこと(Codex 0.161.0、Linux):
 *   - codex exec は、標準入力が閉じられるまで待って止まる(プロンプトを引数で渡していても)。
 *     そのため標準入力を閉じて起動する('ignore')
 *   - 標準出力は、PTY を使わずパイプで受けても、1 行ずつ出る。標準エラーは別の流れなので、
 *     標準出力の JSON に混ざらない(claude のように script で PTY を作る必要が無い)
 *   - exec resume には -C(作業ディレクトリ)と -s(サンドボックス)が無い。作業ディレクトリは、
 *     子プロセスの cwd で渡す
 */

import { spawn } from 'node:child_process';

/**
 * codex コマンドの引数を組み立てる
 * @param {object} options
 * @param {string} options.prompt - プロンプトテキスト
 * @param {string} [options.resumeId] - 再開するセッション ID(省略すると新規セッション)
 * @param {Array<string>} [options.allowedTools] - 無視する(Codex に対応するフラグが無い)
 * @param {Array<string>} [options.disallowedTools] - 無視する(同上)
 * @param {string} [options.model] - 使用モデル (例: "gpt-5.6-terra")
 * @param {boolean} [options.dangerouslySkipPermissions] - 承認とサンドボックスを無効にする(危険)
 * @returns {Array<string>}
 */
function buildArgs({ prompt, resumeId, model, dangerouslySkipPermissions }) {
  const args = resumeId
    ? ['exec', 'resume', '--json', '--skip-git-repo-check']
    : ['exec', '--json', '--skip-git-repo-check'];

  if (model) {
    args.push('-m', model);
  }

  if (dangerouslySkipPermissions) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }

  // "--" の後は位置引数。- で始まるプロンプトが、フラグとして解釈されないようにする
  args.push('--');
  if (resumeId) {
    args.push(resumeId);
  }
  args.push(prompt);

  return args;
}

/**
 * codex プロセスを起動する
 * @param {Array<string>} args - codex コマンドの引数配列
 * @param {string} cwd - 作業ディレクトリ
 * @returns {import('child_process').ChildProcess}
 */
function spawnProcess(args, cwd) {
  // 配列渡し・shell 不要のためエスケープ処理は不要。標準入力は閉じる(閉じないと codex exec が止まる)
  return spawn('codex', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * stdout の1行(JSON)が thread.started なら、その情報を返す。そうでなければ null
 * thread.started に載るのは thread_id だけ(モデルや cwd は載らない)なので、他の項目は null にする。
 * @param {object} json - --json の1行をパースしたもの
 * @returns {object|null} { sessionId, model, cwd, permissionMode, codingAgentVersion, apiKeySource, tools }
 */
function parseInit(json) {
  if (!(json && json.type === 'thread.started' && json.thread_id)) {
    return null;
  }
  return {
    sessionId: json.thread_id,
    model: null,
    cwd: null,
    permissionMode: null,
    codingAgentVersion: null,
    apiKeySource: null,
    tools: [],
  };
}

export { buildArgs, spawnProcess, parseInit };
