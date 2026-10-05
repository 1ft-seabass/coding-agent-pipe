# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
