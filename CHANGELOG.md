# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-10-12

> **Breaking change for receivers (Codex):** tool calls now take the form Claude Code uses (see Changed). A receiver that read Codex tool calls as `name: "exec"` with a string `input` needs to be updated.

### Added
- Codex: a failed turn (for example, a model the account cannot use) is now emitted as a `session-error` Webhook with the reason in `error` (a human-readable sentence taken from Codex's record). It is read by watching the session files, so a failure of a session run directly in a terminal is also emitted. `pid` and `code` are not set. It does not appear in `GET /sessions/:id/messages`. Before, only the process exit (`process-exit`, exit code `1`) arrived, with no reason
- Codex: `message.usage` is now carried on the assistant events of live delivery (the `assistant-response-completed` Webhook), as the most recently received value (the previous response's), because Codex writes the token counts after the response line. For a session that already has a record (for example a resumed one), the last value in the file is the starting value. The first response of a new session waits for its value (up to 1 second, then it is delivered without `usage`). The history (`GET /sessions/:id/messages`) is unchanged: each response's own value is on the last event of that response

### Changed
- **Codex tool calls take the form Claude Code uses.** A call that only runs shell commands becomes `name: "Bash"` with `input: { "command", "script" }` (several commands in one call are joined with newlines; `script` is the original JavaScript). The result (`tool_result`) is a single text with only the output body, and carries `is_error` (`true` when the script failed or a command's exit code is not 0). Other tools keep their tool names, and the `input` of a `function_call` is the parsed arguments object. A call that cannot be interpreted is delivered as before (`name: "exec"`, a string `input`). `tools` carries the actual names (`["Bash"]`). The JSON Schema now allows `input` to be a string as well as an object (a string remains only for an uninterpreted `exec`, or a `function_call` whose arguments are not valid JSON)

## [0.3.1] - 2026-10-12

### Added
- Codex: the model in use is now set as `model` directly on assistant events (the same position as `model` in `session-started`; for example the `assistant-response-completed` Webhook and `GET /sessions/:id/messages`), read from Codex's `turn_context`. A receiver can show the actual model, including when `send` specifies `model`. Before, nothing carried it for Codex (`model` in the start response and in `session-started` is still `null`, because Codex's first output does not include it). The field is absent when the model is not known yet, and `claude-code` does not set it. The JSON Schema now describes it

## [0.3.0] - 2026-10-11

> **Breaking change for receivers:** `backendType` is no longer sent. Read `engine` instead (see Removed). This change is in 0.3.0.

### Added
- **Several engines in one server.** `engines` selects the coding agents to run (`claude-code`, `codex`), and `watchDirs` sets where each engine's sessions live. The connection (port and `callbackUrl`) stays one; receivers tell the engines apart by `engine`. If `engines` is not written, only `claude-code` runs, so existing configurations keep working as they are. The legacy `engine` (one engine) and `watchDir` still work, but cannot be written together with `engines` (a startup error, because the meaning would be ambiguous). See "Running multiple engines" in DETAILS
- `GET /engine` (the running engines) and `engines` in `GET /info` (additive; the existing fields are the values of the default engine)
- `GET /engine/:id/auth`: whether an engine is logged in (`loggedIn`) and how (`method`), from `claude auth status` and `codex login status`. Email addresses, organization IDs, and the like are never returned. The result is kept for 30 seconds. If the CLI is unavailable, the response is still `200` with `loggedIn: false` and an `error`. `404` for an engine that is not running
- `engine` on each session in `GET /sessions` and `GET /projects`. Both now list the sessions of every running engine together (the projects are grouped by directory). `?engine=` narrows to one engine (`400` for one that is not running). Routes that look a session up by ID (`/sessions/:id/...`) find the engine from the session ID; if the same ID exists in more than one engine, the response is `409` (choose with `?engine=`)
- `engine` for starting sessions: `POST /sessions/new` and the MQTT command accept `engine` (default: `claude-code`, or the only running engine if `claude-code` is not running). `POST /sessions/:id/send` and the MQTT resume find the engine from the session ID. The responses of `POST /sessions/new` and `POST /sessions/:id/send` include `engine`
- `engine` on each entry of `GET /processes` and `GET /managed`

### Changed
- The Webhook process events (`session-started`, `session-error`, `session-timeout`, `cancel-initiated`, `process-exit`) now carry the `engine` of the session they belong to (they used to carry the server's single engine). This differs from before only when several engines run
- A `claude-code` configuration without `watchDir` used to stop at startup. It now watches `~/.claude/projects`
- Documentation: "1 process = 1 engine" no longer applies; the configuration section, the Codex section, and the project structure were corrected

### Removed
- **`backendType`** is no longer sent in any Webhook payload or in `GET /info`. It had the same meaning as `engine` but a different spelling (`claude_code` vs `claude-code`), so it was unified into `engine` (`claude-code`, `codex`). Receivers should read `engine`; when it is absent (claude-code-pipe never sends it), treat it as `claude-code`. The JSON Schema no longer requires `backendType` and accepts payloads with or without it

### Known issues
- For `claude-code`, the project path of a session is cached by the name of its directory. If a session file without a working directory (`cwd`) is read first, a guessed path is cached, and the other sessions in the same directory get that path as their project. This was inherited from claude-code-pipe and is not fixed yet

## [0.2.0] - 2026-10-10

### Added
- **Codex engine**: with `"engine": "codex"`, the server handles OpenAI's Codex CLI instead of Claude Code (the API and Webhook shapes are the same). It follows `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (`watchDir` defaults to `~/.codex/sessions` for this engine), starts `codex exec --json` (and `codex exec resume` for an existing session) without a PTY, and derives `projectPath` from the working directory on the first line of each session file. Sub-agents started by Codex appear as separate sessions with `isSubagent: true` and are excluded from the default `GET /sessions` list. `allowedTools` and `disallowedTools` have no effect, and `dangerouslySkipPermissions` maps to `--dangerously-bypass-approvals-and-sandbox` (approvals and the sandbox). Token counts (`totalTokens`, `usage`) are computed from Codex's `token_usage_record` records (`input_tokens` excludes the cached part, like Claude). Windows and MQTT are not verified. See "Using Codex" in DETAILS
- `codingAgentVersion` in the responses of `POST /sessions/new` and `POST /sessions/:id/send`: the engine-independent name of the agent version. With `claude-code` it has the same value as `claudeCodeVersion` (which is still returned); with `codex` it is `null` and `claudeCodeVersion` is not returned

### Fixed
- A start that failed no longer emits a `session-timeout` about 60 seconds later. When the agent process exited without reporting its session (or could not be started), the 60-second start timer kept running, so a `session-timeout` webhook was sent for a session that had already ended, and `kill` was called on the dead process. The timer is now stopped when the process exits or fails to start, for both new sessions and sends to an existing session. A process that is still running when the timer expires is handled as before

### Changed
- Documentation only: that shutting down the server does not stop the agent processes it started is now documented as intended behavior, not a known weakness. Behavior is unchanged. It is removed from "Known behaviors" in DETAILS and described under stopping and restarting the server

## [0.1.0] - 2026-10-08

### Fixed
- A `watchDir` that does not exist is no longer created. The server logs a warning once, keeps running, and starts watching when the directory appears (checked every 5 seconds). Before, a typo in `watchDir` silently created a stray directory. A `watchDir` that exists behaves as before
- Subagent events now carry `projectPath`, `projectName`, and `git`, like the other events. The project of a subagent file (under `<project>/<sessionId>/subagents/`) was looked up one directory too low and never found. The same fix applies to REST: with `excludeAgents=false`, `GET /sessions` now shows `projectPath` and `projectName` for subagent sessions, and `GET /projects` counts them in their project. Default listings are unchanged
- With several `subscribers`, `responseTime` in `assistant-response-completed` is now the same for every subscriber. It was `0` for the second and later ones, because the first subscriber updated the last timestamp before they were handled
- MQTT commands that send to an existing session (`sessionId` given) now use `projectPath` as the working directory and put it in the events, like the REST API and like MQTT commands that start a new session. It was ignored, so the agent started in the directory the server was started from
- `cancel` now really moves on to SIGTERM when the process has not ended after SIGINT and `send.cancelTimeoutMs`. It was never sent, because the code checked Node's `killed` flag, which becomes true as soon as SIGINT is sent
- The same mistake in three more places: `alive` in `GET /processes` stays `true` while the process is really running (it turned `false` right after a `cancel`), and `DELETE /processes/:sessionId` and `DELETE /processes` now send SIGTERM to a process that already received SIGINT from a `cancel` (they skipped it and reported `killed: false`)

### Changed
- **From 0.1.0, keeping every behavior identical to claude-code-pipe is no longer a goal.** The weaknesses inherited from it are fixed one by one and recorded here as intended changes (see Fixed and Changed). The weaknesses that remain are listed under "Known behaviors" in DETAILS
- `~` in `watchDir` is now expanded with `os.homedir()` instead of `process.env.HOME`, so it no longer becomes an empty string when `HOME` is not set (for example on native Windows)
- The `apiToken` check now compares tokens in constant time (SHA-256 digests with `crypto.timingSafeEqual`), so the comparison time no longer depends on how many leading characters match. Accepted and rejected tokens are unchanged

## [0.0.2] - 2026-10-04

### Added
- **Adapter layer**: engine-specific knowledge (where to read, how to interpret, how to spawn) is now bundled in `src/adapters/<engine>/`. `src/core/` no longer knows which engine it is serving. The first adapter is `claude-code`. One process = one engine; the engine is chosen once at startup
- **`config.engine`**: selects the adapter (default and empty string: `claude-code`, so existing claude-code-pipe configs keep working). An unknown or invalid name stops startup with the list of available engines
- **`engine` field**: every webhook payload and `GET /info` now include `engine` (e.g. `"claude-code"`), next to `pipeApp`. Additive; `backendType` is kept. claude-code-pipe never sends it, so receivers can treat a missing `engine` as `claude-code`
- **`schema/event.schema.json`**: JSON Schema of the webhook events and the `GET /info` response, the single source of truth for the contract. Both claude-code-pipe's recorded output and this version's real output validate against it; unknown fields are allowed

### Changed
- Source layout (no behavior change, verified by comparison tests against claude-code-pipe): `watcher.js` → `core/sources/file-tail.js`, `subscribers.js` → `core/deliver.js`, `sender.js` → `core/process.js` + `adapters/claude-code/spawn.js`, `parser.js` → `adapters/claude-code/parse.js`, `api.js` → `core/api.js` (session reading goes through the adapter), `GET /claude-version` is now registered by the `claude-code` adapter

## [0.0.1] - 2026-10-04

### Added
- **`pipeApp` field**: every webhook payload and `GET /info` now include `pipeApp: "coding-agent-pipe"` (additive; no existing field changed), so receivers can tell which application the data came from. claude-code-pipe never sends it, so receivers can treat a missing `pipeApp` as `claude-code-pipe`. It is independent of `backendType` (which coding agent)
- Port of `claude-code-pipe` v0.9.1 to Hono (ESM, no build step, Node.js >= 20). Same file layout as claude-code-pipe; only the HTTP layer changed (Express → Hono). REST API and webhook payloads are unchanged, verified by comparison tests against claude-code-pipe (130 cases, 2 of them intentional differences)
- `src/http-utils.js`: small helpers that keep Express's implicit behavior (duplicate query keys become arrays, `express.json()`-compatible body parsing, `'10mb'`-style size parsing)
- `config.example.json` (copied from claude-code-pipe)
- Project set up from `claude-code-pipe` v0.9.1 as the porting baseline (Express → Hono, no behavior change planned for 0.0.x)

### Changed
- Attachments are now saved to `/tmp/coding-agent-pipe/` (claude-code-pipe used `/tmp/claude-code-pipe/`), so both can run on one host without cleaning up each other's files
- Error responses that Express rendered as HTML (404, malformed JSON, 413) are now JSON (`{ "error": "..." }`)
- `GET /claude-version` no longer risks a crash when `claude` is not installed (the result is settled once)
- A missing `config.json` now prints a hint and exits instead of a stack trace

### Not reproduced (intentional differences from Express)
- Automatic `OPTIONS` responses
- Case-insensitive routing (`/Health`)
