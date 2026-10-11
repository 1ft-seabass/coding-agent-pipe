# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
