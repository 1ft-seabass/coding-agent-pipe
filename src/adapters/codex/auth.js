/**
 * auth.js - Codex のログイン状態の確認(codex login status)
 *
 * 実物で確かめたこと(Codex 0.161.0): ログイン済みなら終了コード 0 で、`Logged in using ChatGPT` のような
 * 1 行を**標準エラー出力**に書く(標準出力は空)。出力は文章で、構造化された形式(JSON)は無い。
 * そのため、ログイン済みかは終了コードで決め、方法(method)は、文から読み取れたときだけ入れる
 * (CLI の更新で文言が変わっても、loggedIn は壊れない)。
 */

const command = 'codex';
const args = ['login', 'status'];

/** 文の「Logged in using <方法>」から、方法の名前を決める。読み取れなければ null */
function methodOf(text) {
  const match = /Logged in using (.+)/i.exec(text);
  if (!match) return null;
  const phrase = match[1].trim().toLowerCase();
  if (phrase.includes('chatgpt')) return 'chatgpt';
  if (phrase.includes('api key')) return 'api-key';
  return null;
}

/**
 * @param {{code: number|null, stdout: string, stderr: string}} result
 * @returns {{loggedIn: boolean, method: string|null}}
 */
function parse({ code, stdout, stderr }) {
  const loggedIn = code === 0;
  return { loggedIn, method: loggedIn ? methodOf(`${stdout}\n${stderr}`) : null };
}

export const auth = { command, args, parse };
