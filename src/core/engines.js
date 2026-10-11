/**
 * engines.js - エンジンの登録簿
 *
 * サーバーが扱う adapter を束ね、「どのエンジンか」を引く場所を 1 か所にする。
 * core の各モジュール(api / deliver / mqtt-receiver)は、adapter を直接持たず、この登録簿を受け取る。
 *
 *   get(id)             id の adapter。載っていなければ undefined
 *   list()              載っている adapter の配列(登録順)
 *   ids()               載っているエンジンの id の配列(登録順)
 *   default             既定のエンジンの adapter(GET /info の engine・watchDir に使う)
 *   implicitDefault     engine を指定しない新規起動で使うエンジンの adapter。決められないときは undefined
 *   target(engineId)    読み取りの対象にする adapter の配列(engineId が無ければ全エンジン)
 *   findSession(...)    セッション ID から、どのエンジンのセッションかを引く
 */

/**
 * @param {Array<object>} adapters - 動かすエンジンの adapter(1 つ以上)
 * @param {string} [defaultId] - 既定のエンジンの id(省略時は先頭)
 * @param {string} [implicitDefaultId] - engine を指定しない新規起動で使うエンジンの id(通常は claude-code)。
 *   動かしていなければ、動かしているエンジンが 1 つだけのときはそれ(迷わない)。2 つ以上なら無し(engine の指定が必要)
 */
function createEngines(adapters, defaultId, implicitDefaultId) {
  if (!Array.isArray(adapters) || adapters.length === 0) {
    throw new Error('At least one engine is required');
  }
  const byId = new Map();
  for (const adapter of adapters) {
    if (byId.has(adapter.id)) {
      throw new Error(`Duplicate engine: "${adapter.id}"`);
    }
    byId.set(adapter.id, adapter);
  }
  const resolvedDefaultId = defaultId ?? adapters[0].id;
  const defaultAdapter = byId.get(resolvedDefaultId);
  if (!defaultAdapter) {
    throw new Error(`Default engine "${resolvedDefaultId}" is not among the engines: ${[...byId.keys()].join(', ')}`);
  }
  const implicitDefault = byId.get(implicitDefaultId) ?? (adapters.length === 1 ? adapters[0] : undefined);

  const isUnset = (id) => id === undefined || id === null || id === '';

  /**
   * 読み取りの対象にする adapter を決める
   * @returns {{adapters: object[]}|{unknown: true, engine: *}} engineId が無ければ全エンジン。未知(動かしていない)なら unknown
   */
  function target(engineId) {
    if (isUnset(engineId)) return { adapters: [...byId.values()] };
    const adapter = typeof engineId === 'string' ? byId.get(engineId) : undefined;
    return adapter ? { adapters: [adapter] } : { unknown: true, engine: engineId };
  }

  /**
   * セッション ID から、どのエンジンのセッションかを引く
   * @returns {Promise<
   *   {status: 'found', adapter: object, location: string} |
   *   {status: 'not-found'} |
   *   {status: 'conflict', engines: string[]} |
   *   {status: 'unknown-engine', engine: *}>}
   */
  async function findSession(sessionId, projectPath, engineId) {
    const t = target(engineId);
    if (t.unknown) return { status: 'unknown-engine', engine: t.engine };
    const matches = [];
    for (const adapter of t.adapters) {
      const location = await adapter.sessions.locate(sessionId, projectPath);
      if (location) matches.push({ adapter, location });
    }
    if (matches.length === 0) return { status: 'not-found' };
    if (matches.length > 1) return { status: 'conflict', engines: matches.map((m) => m.adapter.id) };
    return { status: 'found', ...matches[0] };
  }

  return {
    get: (id) => byId.get(id),
    list: () => [...byId.values()],
    ids: () => [...byId.keys()],
    default: defaultAdapter,
    implicitDefault,
    target,
    findSession
  };
}

export { createEngines };
