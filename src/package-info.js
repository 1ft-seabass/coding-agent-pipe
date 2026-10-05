/**
 * package-info.js - package.json の内容を読み込む
 *
 * ESM では require('../package.json') が使えないので、ここで一度だけ読んで共有する。
 */

import fs from 'node:fs';

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * どのアプリから来たかを示す識別子(webhook と GET /info に載せる)。
 * claude-code-pipe はこの項目を送らないので、受け手は「項目が無ければ claude-code-pipe」とみなせる。
 * package.json の name とは独立した固定値にして、パッケージ名を変えても識別子が変わらないようにする。
 */
const PIPE_APP = 'coding-agent-pipe';

export { packageJson, PIPE_APP };
