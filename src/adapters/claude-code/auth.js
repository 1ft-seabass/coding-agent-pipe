/**
 * auth.js - Claude Code のログイン状態の確認(claude auth status --json)
 *
 * CLI の出力(JSON)には、メールアドレス・組織 ID・組織名などが含まれるが、取り出すのは
 * loggedIn と authMethod だけ。ほかの項目は読み捨てる。
 */

const command = 'claude';
const args = ['auth', 'status', '--json'];

/**
 * @param {{code: number|null, stdout: string, stderr: string}} result
 * @returns {{loggedIn: boolean, method: string|null}|null} 解釈できなければ null
 */
function parse({ stdout }) {
  let json;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || typeof json.loggedIn !== 'boolean') return null;
  const method = json.loggedIn && typeof json.authMethod === 'string' && json.authMethod !== '' ? json.authMethod : null;
  return { loggedIn: json.loggedIn, method };
}

export const auth = { command, args, parse };
