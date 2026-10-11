/**
 * parse.js - Codex のセッションファイル(rollout-*.jsonl)の1行を、正規化イベントに変換する
 *
 * 正規化イベントの形は claude-code adapter と同じ(core はその形だけを見る)。
 *   { parentUuid, sessionId, uuid, timestamp, isMeta, message: { role, content }, tools }
 * sessionId は行に無いので null のまま返し、観測元がファイル名(sessionIdFromPath)から補完する。
 *
 * 拾う行(response_item のうち):
 *   message(user)               → role: user、content: [{ type: 'text' }]
 *   message(assistant)          → role: assistant、content: [{ type: 'text' }]
 *   custom_tool_call / function_call
 *                               → role: assistant、content: [{ type: 'tool_use', id: call_id, name, input }]
 *   custom_tool_call_output / function_call_output
 *                               → role: user、content: [{ type: 'tool_result', tool_use_id: call_id, content }]
 * 捨てる行: developer の指示、環境情報(<environment_context>)、session_meta、turn_context、world_state、
 *   token_usage_record、event_msg、agent_message(エージェント間の連絡)、reasoning。event_msg の item_completed(UserMessage / AgentMessage)は、
 *   response_item と同じやり取りの二重の記録なので、response_item だけを正とする。
 * トークン数(token_usage_record)は、assistant の行と別の行に出る。この行ごとの変換には載せず、
 * セッションを読む側(sessions.js の read)が、直前の assistant のイベントに足す(usageFromRecord)。
 *   Webhook は usage を使わない。
 */

const ENV_CONTEXT_PREFIX = '<environment_context>';

/** content の中の指定した type のテキストを、{ type: 'text', text } の配列にする */
function textBlocks(content, types) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c) => c && types.includes(c.type) && typeof c.text === 'string')
    .map((c) => ({ type: 'text', text: c.text }));
}

/** 本物のユーザー発言か(環境情報などの、システムが user として入れる行でないか) */
function isUserText(payload, blocks) {
  const kinds = payload.internal_chat_message_metadata_passthrough?.content_item_kinds;
  if (Array.isArray(kinds)) return kinds.includes('user.text');
  // メタデータが無い場合の代わり: 環境情報で始まる行は、ユーザー発言でない
  return blocks.length > 0 && !blocks[0].text.startsWith(ENV_CONTEXT_PREFIX);
}

function buildEvent(raw, payload, role, content, tools) {
  return {
    parentUuid: null,
    sessionId: null,
    uuid: payload.id || null,
    timestamp: raw.timestamp || null,
    isMeta: false,
    message: { role, content },
    tools
  };
}

/**
 * セッションファイルの1行をパースして、正規化イベントに変換する
 * @param {string} jsonString - 1行(JSON文字列)
 * @returns {object|null} 正規化イベント。拾わない行・解釈できない行は null
 */
function parseLine(jsonString) {
  if (!jsonString || !jsonString.trim()) {
    return null;
  }

  let raw;
  try {
    raw = JSON.parse(jsonString);
  } catch (error) {
    console.error('[parser] Failed to parse JSONL line:', error.message);
    return null;
  }

  if (!raw || raw.type !== 'response_item' || !raw.payload) {
    return null;
  }
  const payload = raw.payload;

  if (payload.type === 'message') {
    if (payload.role === 'assistant') {
      const blocks = textBlocks(payload.content, ['output_text']);
      return blocks.length > 0 ? buildEvent(raw, payload, 'assistant', blocks, []) : null;
    }
    if (payload.role === 'user') {
      const blocks = textBlocks(payload.content, ['input_text']);
      return blocks.length > 0 && isUserText(payload, blocks) ? buildEvent(raw, payload, 'user', blocks, []) : null;
    }
    return null;
  }

  if (payload.type === 'custom_tool_call' || payload.type === 'function_call') {
    // custom_tool_call は input、function_call は arguments(どちらも文字列)に、呼び出しの内容がある
    const block = { type: 'tool_use', id: payload.call_id, name: payload.name, input: payload.input ?? payload.arguments };
    if (payload.namespace) block.namespace = payload.namespace;
    return buildEvent(raw, payload, 'assistant', [block], [payload.name]);
  }

  if (payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output') {
    const content = typeof payload.output === 'string'
      ? [{ type: 'text', text: payload.output }]
      : textBlocks(payload.output, ['input_text', 'output_text', 'text']);
    const block = { type: 'tool_result', tool_use_id: payload.call_id, content };
    return buildEvent(raw, payload, 'user', [block], []);
  }

  return null;
}

/**
 * token_usage_record の行から、Claude と同じ形の message.usage を作る
 *   - 1 つのレスポンス分の usage だけを使う(turn_token_usage・thread_token_usage は累計なので使わない)
 *   - Codex の input_tokens は、キャッシュから読んだ分(cached_input_tokens)を含む。Claude の input_tokens は
 *     キャッシュ分を含まないので、引いて揃える(キャッシュ分は cache_read_input_tokens に入れる)
 * @param {object} raw - JSON.parse した token_usage_record の行
 * @returns {object} { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }
 */
function usageFromRecord(raw) {
  const u = (raw && raw.payload && raw.payload.usage) || {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const cached = num(u.cached_input_tokens);
  return {
    input_tokens: Math.max(0, num(u.input_tokens) - cached),
    output_tokens: num(u.output_tokens),
    cache_creation_input_tokens: num(u.cache_write_input_tokens),
    cache_read_input_tokens: cached
  };
}

export { parseLine, usageFromRecord };
