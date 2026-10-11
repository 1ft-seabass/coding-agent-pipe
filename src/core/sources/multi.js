/**
 * multi.js - 複数の観測元を、1 つの観測元として扱う
 *
 * エンジンごとの観測元(file-tail など)を束ね、それぞれの 'message' イベントに、どのエンジンのものか
 * (event.engine)を付けて、1 つの 'message' イベントとして発火する。start() / stop() も全体を束ねる。
 * 受け手(core/deliver.js)は、event.engine で、そのエンジンの adapter を引く。
 */

import { EventEmitter } from 'node:events';

class MultiSource extends EventEmitter {
  /**
   * @param {Array<{engine: string, source: EventEmitter}>} entries - エンジンの id と、そのエンジンの観測元
   */
  constructor(entries) {
    super();
    this.entries = entries;
    for (const { engine, source } of entries) {
      source.on('message', (event) => {
        event.engine = engine;
        this.emit('message', event);
      });
    }
  }

  /** すべての観測元を始める。1 つが失敗しても、ほかは動かす(失敗はまとめて投げる) */
  async start() {
    const results = await Promise.allSettled(this.entries.map(({ source }) => source.start()));
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      throw new AggregateError(failed.map((r) => r.reason), `${failed.length} source(s) failed to start`);
    }
  }

  /** すべての観測元を止める */
  async stop() {
    await Promise.allSettled(this.entries.map(({ source }) => source.stop()));
  }
}

export default MultiSource;
