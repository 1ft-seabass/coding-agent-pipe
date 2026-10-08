/**
 * http-utils.js - Hono 用の小さな補助関数
 *
 * claude-code-pipe(Express)が黙ってやってくれていたことを、ここで同じに揃える。
 *  - query:           同じキーが重複したときに配列になる(qs の挙動)
 *  - parseSize:       '10mb' のようなサイズ表記をバイト数にする(bytes の挙動)
 *  - jsonBodyParser:  express.json() 相当(JSON 以外・空ボディは {}、不正な JSON は 400)
 *  - BadRequestError: ボディが不正なときに投げる(app.onError で 400 にする)
 *  - safeEqual:       文字列を、定数時間で比べる(API トークンの比較用。長さの違いも、時間に出さない)
 */

import crypto from 'node:crypto';

/** 2 つの文字列が等しいかを、定数時間で比べる(SHA-256 にそろえてから、timingSafeEqual) */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** クエリの値を返す。重複キーは配列、無ければ undefined(Express の req.query と同じ) */
function query(c, name) {
  const values = c.req.queries(name);
  if (values === undefined) return undefined;
  return values.length === 1 ? values[0] : values;
}

/** '10mb' / '1kb' / '512' などをバイト数にする。解釈できなければ null */
function parseSize(value) {
  if (typeof value === 'number') return value;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?\s*$/i.exec(String(value));
  if (!m) return null;
  const units = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
  return Math.floor(parseFloat(m[1]) * units[(m[2] || 'b').toLowerCase()]);
}

class BadRequestError extends Error {}

/**
 * express.json() 相当のミドルウェア。パース結果を c.get('body') に入れる。
 *  - Content-Type が application/json 以外: {}
 *  - 空ボディ(長さ 0): {}
 *  - 最初の文字が { か [ 以外(null・文字列・BOM など)、または不正な JSON: BadRequestError
 */
function jsonBodyParser() {
  return async (c, next) => {
    let body = {};
    const type = (c.req.header('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type === 'application/json') {
      const text = await c.req.text();
      if (text.length !== 0) {
        if (!/^[\x20\x09\x0a\x0d]*[{[]/.test(text)) throw new BadRequestError('Unexpected token in JSON');
        try {
          body = JSON.parse(text);
        } catch (error) {
          throw new BadRequestError(error.message);
        }
      }
    }
    c.set('body', body);
    await next();
  };
}

export { query, parseSize, jsonBodyParser, BadRequestError, safeEqual };
