/**
 * sources/index.js - 動かすエンジンの observe に応じて、イベントの観測元を作る
 *
 * エンジンごとに観測元を作り、1 つにまとめる(MultiSource)。観測元は 'message' イベントで正規化イベントを
 * 発火し、各イベントには、どのエンジンのものか(event.engine)が付く。いまは file-tail のみ。
 */

import FileTailSource from './file-tail.js';
import MultiSource from './multi.js';

/**
 * @param {object} adapter - エンジンの adapter(adapter.watchDir を使う)
 */
function createEngineSource(adapter) {
  const { observe } = adapter;
  if (observe.kind === 'file-tail') {
    return new FileTailSource({
      watchDir: adapter.watchDir,
      extension: observe.extension,
      parse: adapter.parse,
      sessionIdFromPath: adapter.sessionIdFromPath
    });
  }
  throw new Error(`Unsupported observe kind: ${observe.kind}`);
}

/**
 * @param {object} engines - エンジンの登録簿(core/engines.js)
 */
function createSource(engines) {
  return new MultiSource(engines.list().map((adapter) => ({ engine: adapter.id, source: createEngineSource(adapter) })));
}

export { createSource };
