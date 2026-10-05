/**
 * sources/index.js - adapter の observe に応じて、イベントの観測元を作る
 *
 * 観測元は 'message' イベントで正規化イベントを発火する。いまは file-tail のみ。
 */

import FileTailSource from './file-tail.js';

/**
 * @param {object} adapter - エンジンの adapter
 * @param {object} config - 設定オブジェクト(watchDir を使う)
 */
function createSource(adapter, config) {
  const { observe } = adapter;
  if (observe.kind === 'file-tail') {
    return new FileTailSource({
      watchDir: config.watchDir,
      extension: observe.extension,
      parse: adapter.parse,
      sessionIdFromPath: adapter.sessionIdFromPath
    });
  }
  throw new Error(`Unsupported observe kind: ${observe.kind}`);
}

export { createSource };
