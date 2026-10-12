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
 *                                 Claude の形に寄せる(toolUseFromCall): exec の中身が exec_command だけなら name: 'Bash'、input: { command, script }。
 *                                 exec の中身が別の 1 つのツール(image_gen__imagegen など)なら name をそのツール名、input: { script }。
 *                                 function_call は arguments を JSON として読み、input をオブジェクトにする。
 *                                 解釈できない exec は、name: 'exec'、input: 元の文字列のまま(誤って解釈しない)。
 *   custom_tool_call_output / function_call_output
 *                               → role: user、content: [{ type: 'tool_result', tool_use_id: call_id, content }]
 *                                 exec の結果(先頭が 'Script completed|failed')は、殻を開いて output の本文だけの text にし、is_error を付ける(toolResultFromOutput)。
 * turn_context(ターンの先頭に 1 行ある)の model は、そのファイルの「いまのモデル」として覚え、続く assistant のイベントの
 *   直下の model に載せる(session-started などの model と同じ位置。message の中ではない)。覚える先は、呼び出し側が渡す
 *   ctx({ model })。ctx が無ければ(1 行だけを解釈する呼び出し)、載せない。起動の出力(thread.started)には、モデルが載らない。
 * ターンの失敗(event_msg の task_complete に error がある行)は、ライブの観測(ctx.emitErrors が true)のときだけ、エラーのイベント
 *   { message: {}, tools: [], error: 文字列 } にする(core が session-error の Webhook にする)。履歴を読むときは、イベントにしない
 *   (GET /messages に、role の無い要素を混ぜない)。error.message は JSON の文字列(例: {"type":"error","status":400,"error":{"message":"…"}})なので、
 *   中の error.message(人が読む文)を取り出す。JSON でなければ、そのまま。
 * 捨てる行: developer の指示、環境情報(<environment_context>)、session_meta、world_state、
 *   token_usage_record、event_msg、agent_message(エージェント間の連絡)、reasoning。event_msg の item_completed(UserMessage / AgentMessage)は、
 *   response_item と同じやり取りの二重の記録なので、response_item だけを正とする。
 * トークン数(token_usage_record)は、assistant の行より後の、別の行に出る。
 *   履歴を読む側(sessions.js の read)は、全行を読めるので、直前の assistant のイベントに、その応答の usage を足す(usageFromRecord)。
 *   ライブの観測(1 行ずつ。ctx.carryUsage が true)は、assistant のイベントを先に出すので、その応答の usage はまだ無い。
 *   代わりに、ctx に覚えた「直前に受け取った usage」(1 つ前の応答の値)を、assistant のイベントの message.usage に載せる。
 *   token_usage_record の行を読むたびに、覚えた値を、最新の応答の値に更新する(足し合わせない)。
 *   まだ 1 つも受け取っていなければ(新しいセッションの最初の応答)、イベントに holdForUsage: true を付ける。観測元(file-tail)が発火を保留し、
 *   次の token_usage_record の行で、その応答の値を入れて、holdForUsage を外す(上限を過ぎたら、値なしで発火する)。
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

/** JS のソースから、文字列リテラル("…" '…' `…`)の中身を空白に置き換える(構文の検査用。長さは変えない) */
function maskStrings(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const q = src[i];
    if (q !== '"' && q !== "'" && q !== '`') { out += q; continue; }
    let j = i + 1;
    while (j < src.length && src[j] !== q) j += src[j] === '\\' ? 2 : 1;
    out += q + ' '.repeat(Math.max(0, j - i - 1)) + (src[j] === q ? q : '');
    i = j;
  }
  return out;
}

/** src の at 番目から始まる JS の文字列リテラルを読む。{ value, end } か、読めなければ null(テンプレート式 ${} や不明な \ 記法を含むものは読まない) */
function readStringLiteral(src, at) {
  const q = src[at];
  if (q !== '"' && q !== "'") return null;
  let j = at + 1;
  while (j < src.length && src[j] !== q) j += src[j] === '\\' ? 2 : 1;
  if (src[j] !== q) return null;
  const body = src.slice(at + 1, j);
  try {
    // JSON の文字列として読める書き方(\n \" \\ \uXXXX)だけを受け入れる。\' など JSON に無い書き方は、読まない
    const value = JSON.parse(q === '"' ? `"${body}"` : `"${body.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`);
    return { value, end: j + 1 };
  } catch {
    return null;
  }
}

/**
 * script の中の tools.<tool>({ … }) の引数 arg の文字列リテラルを、呼び出しごとに 1 つずつ、出てくる順に読む。
 * 呼び出しの { … } の範囲の中だけを見る(cmd の無い呼び出しが、後ろの呼び出しの cmd を取り違えない)。1 つでも読めなければ null
 * @param {string} script - 元のスクリプト
 * @param {string} masked - maskStrings(script)(文字列の中身が空白。括弧や key の検索用)
 */
function readArgLiterals(script, masked, tool, arg) {
  const values = [];
  const callRe = new RegExp(`tools\\.${tool}\\(\\s*\\{`, 'g');
  const keyRe = new RegExp(`(?:^|[,{\\s])${arg}\\s*:\\s*`);
  let m;
  while ((m = callRe.exec(masked)) !== null) {
    const open = callRe.lastIndex - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < masked.length; i++) {
      if (masked[i] === '{') depth++;
      else if (masked[i] === '}' && --depth === 0) { close = i; break; }
    }
    if (close < 0) return null;
    const keyM = keyRe.exec(masked.slice(open, close));
    if (!keyM) return null;
    const lit = readStringLiteral(script, open + keyM.index + keyM[0].length);
    if (!lit) return null;
    values.push(lit.value);
  }
  return values;
}

/**
 * exec(custom_tool_call)の JS スクリプトを、Claude の tool_use に寄せる。解釈できなければ null(呼び出し側が元の形のまま通す)
 *   exec_command だけ     → { name: 'Bash', input: { command(複数は改行でつなぐ), script } }
 *   別の 1 つのツールだけ  → { name: そのツール名, input: { script } }
 * 解釈する条件: tools.<名前>( の呼び出しが 1 種類だけであること。exec_command は、さらに制御構文(for/while/if/関数/=>)が無く、cmd が全部読めること
 */
function toolUseFromScript(script) {
  if (typeof script !== 'string') return null;
  const masked = maskStrings(script);
  const names = [...new Set([...masked.matchAll(/\btools\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]))];
  if (names.length !== 1) return null;
  const [tool] = names;
  if (tool === 'exec_command') {
    // cmd を取り出して Bash の command にするので、実行の流れが分かれる書き方(制御構文・関数)は、解釈しない
    if (/\b(for|while|if|switch|function|class|import|require|eval)\b|=>/.test(masked)) return null;
    const calls = (masked.match(/\btools\.exec_command\s*\(/g) || []).length;
    const cmds = readArgLiterals(script, masked, 'exec_command', 'cmd');
    if (!cmds || cmds.length !== calls || calls === 0) return null;
    return { name: 'Bash', input: { command: cmds.join('\n'), script } };
  }
  return { name: tool, input: { script } };
}

/** custom_tool_call / function_call の payload から、tool_use ブロックを作る */
function toolUseFromCall(payload) {
  const raw = payload.input ?? payload.arguments;
  let name = payload.name;
  let input = raw;
  if (payload.type === 'function_call') {
    // arguments は JSON の文字列。読めればオブジェクトにする(読めなければ文字列のまま)
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed;
    } catch { /* 文字列のまま */ }
  } else if (payload.name === 'exec') {
    const converted = toolUseFromScript(raw);
    if (converted) ({ name, input } = converted);
  }
  const block = { type: 'tool_use', id: payload.call_id, name, input };
  if (payload.namespace) block.namespace = payload.namespace;
  return block;
}

const EXEC_HEADER = /^Script (completed|failed)\nWall time [0-9.]+ seconds\nOutput:\n?/;

/**
 * exec の結果を、Claude の tool_result に寄せる。先頭が 'Script completed|failed' でなければ null(元の形のまま)
 *   殻(先頭の見出しと、{"exit_code":…,"output":"…"} の JSON)を開き、output の本文だけをつなげた text 1 つにする。
 *   is_error は、'Script failed'、または exit_code が 0 以外のとき true('Script error:' の行は本文の末尾に残る)
 */
function toolResultFromOutput(callId, texts) {
  const head = EXEC_HEADER.exec(texts[0] || '');
  if (!head) return null;
  const pieces = [texts[0].slice(head[0].length), ...texts.slice(1)].filter((t) => t !== '');
  let isError = head[1] === 'failed';
  let body = '';
  for (const piece of pieces) {
    let text = piece;
    if (piece.startsWith('{')) {
      try {
        const obj = JSON.parse(piece);
        if (obj && typeof obj === 'object' && typeof obj.output === 'string' && ('exit_code' in obj || 'chunk_id' in obj)) {
          text = obj.output;
          if (typeof obj.exit_code === 'number' && obj.exit_code !== 0) isError = true;
        }
      } catch { /* JSON でなければ、そのまま本文 */ }
    }
    if (body && !body.endsWith('\n')) body += '\n';
    body += text;
  }
  return { type: 'tool_result', tool_use_id: callId, content: body === '' ? [] : [{ type: 'text', text: body }], is_error: isError };
}

/**
 * task_complete の error から、人が読むエラー文を取り出す
 *   error.message が JSON の文字列なら、中の error.message(なければ message)。JSON でなければ、そのままの文字列。何も取れなければ固定の文
 */
function errorText(error) {
  const raw = typeof error === 'string' ? error : error && error.message;
  if (typeof raw !== 'string' || raw === '') return 'Turn failed (no error message)';
  try {
    const parsed = JSON.parse(raw);
    const inner = parsed && ((parsed.error && parsed.error.message) || parsed.message);
    if (typeof inner === 'string' && inner !== '') return inner;
  } catch { /* JSON でなければ、そのまま */ }
  return raw;
}

function buildEvent(raw, payload, role, content, tools, model) {
  const event = {
    parentUuid: null,
    sessionId: null,
    uuid: payload.id || null,
    timestamp: raw.timestamp || null,
    isMeta: false,
    message: { role, content },
    tools
  };
  // モデルは、イベント直下の model に載せる(session-started などの model と同じ位置)。message の中ではない。
  // 分かっているときだけ載せる(分からなければ、項目ごと付けない)。model を渡すのは assistant のイベントだけ
  if (model) event.model = model;
  return event;
}

/**
 * ライブの観測(ctx.carryUsage)のとき、assistant のイベントに usage を載せる。履歴を読むときは、呼び出し側が応答ごとの値を足す
 *   直前に受け取った値があれば、そのコピー(1 つ前の応答の値)を載せる。
 *   まだ 1 つも受け取っていなければ(新しいセッションの最初の応答)、holdForUsage を付けて、ctx.pending に覚える。
 *   観測元(file-tail)がそのイベントの発火を保留し、次の token_usage_record の行で、その応答の値が入って、holdForUsage が外れる。
 */
function withUsage(event, ctx) {
  if (!ctx || !ctx.carryUsage) return event;
  if (ctx.usage) {
    event.message.usage = { ...ctx.usage };
  } else {
    event.holdForUsage = true;
    (ctx.pending || (ctx.pending = [])).push(event);
  }
  return event;
}

/**
 * セッションファイルの1行をパースして、正規化イベントに変換する
 * @param {string} jsonString - 1行(JSON文字列)
 * @param {{model: (string|null), carryUsage: (boolean|undefined), usage: (object|null|undefined), emitErrors: (boolean|undefined)}} [ctx] - そのファイルの「いまのモデル」などの置き場(ファイルごとに 1 つ)。
 *   turn_context の行で model を更新し、assistant のイベントに載せる。carryUsage が true のときだけ、token_usage_record の行で usage を更新し、assistant のイベントに載せる
 * @returns {object|null} 正規化イベント。拾わない行・解釈できない行は null
 */
function parseLine(jsonString, ctx) {
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

  if (raw && raw.type === 'turn_context' && raw.payload) {
    // イベントは出さない。このファイルの、いまのモデルを覚える
    if (ctx && typeof raw.payload.model === 'string' && raw.payload.model) ctx.model = raw.payload.model;
    return null;
  }

  if (raw && raw.type === 'token_usage_record') {
    // イベントは出さない。ライブの観測のときだけ、直前に受け取った usage を覚える(履歴を読むときは、呼び出し側が足す)
    if (ctx && ctx.carryUsage) {
      ctx.usage = usageFromRecord(raw);
      // 保留中のイベント(最初の応答)に、この応答の値を入れて、保留を解く
      for (const event of ctx.pending || []) {
        event.message.usage = { ...ctx.usage };
        delete event.holdForUsage;
      }
      ctx.pending = [];
    }
    return null;
  }

  if (raw && raw.type === 'event_msg' && raw.payload && raw.payload.type === 'task_complete' && raw.payload.error) {
    // ターンの失敗。ライブの観測のときだけ、エラーのイベントにする(履歴を読むときは、イベントにしない)
    if (!(ctx && ctx.emitErrors)) return null;
    return {
      parentUuid: null,
      sessionId: null,
      uuid: null,
      timestamp: raw.timestamp || null,
      isMeta: false,
      message: {},
      tools: [],
      error: errorText(raw.payload.error)
    };
  }

  if (!raw || raw.type !== 'response_item' || !raw.payload) {
    return null;
  }
  const payload = raw.payload;
  const model = ctx ? ctx.model : null;

  if (payload.type === 'message') {
    if (payload.role === 'assistant') {
      const blocks = textBlocks(payload.content, ['output_text']);
      return blocks.length > 0 ? withUsage(buildEvent(raw, payload, 'assistant', blocks, [], model), ctx) : null;
    }
    if (payload.role === 'user') {
      const blocks = textBlocks(payload.content, ['input_text']);
      return blocks.length > 0 && isUserText(payload, blocks) ? buildEvent(raw, payload, 'user', blocks, []) : null;
    }
    return null;
  }

  if (payload.type === 'custom_tool_call' || payload.type === 'function_call') {
    // custom_tool_call は input、function_call は arguments(どちらも文字列)に、呼び出しの内容がある
    const block = toolUseFromCall(payload);
    return withUsage(buildEvent(raw, payload, 'assistant', [block], [block.name], model), ctx);
  }

  if (payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output') {
    const content = typeof payload.output === 'string'
      ? [{ type: 'text', text: payload.output }]
      : textBlocks(payload.output, ['input_text', 'output_text', 'text']);
    const block = toolResultFromOutput(payload.call_id, content.map((b) => b.text))
      || { type: 'tool_result', tool_use_id: payload.call_id, content };
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
