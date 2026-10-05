# coding-agent-pipe - Details

Complete documentation for coding-agent-pipe

[日本語版](./DETAILS-ja.md)

> **Basis of this document**: The input and output of each route are based on the actual code (`src/`) and on the real output recorded in comparison tests against claude-code-pipe. Placeholders such as `<TMP>` and `<PID>` in the example responses stand for values that change on every run.

## Table of Contents

- [Overview](#overview)
- [Configuration Details](#configuration-details)
- [API Reference](#api-reference)
- [Webhook Event Format](#webhook-event-format)
- [Errors and Limits](#errors-and-limits)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Security Considerations](#security-considerations)

---

## Overview

coding-agent-pipe is a thin bridge that watches the session files (JSONL) of a coding agent, delivers them by Webhook, and reads, sends, and cancels sessions through a REST API (and MQTT).

- **1 process = 1 engine**: At startup, `config.engine` selects which coding agent the process handles. Currently only `claude-code` is available (an unset or empty value also means `claude-code`). To handle another engine, run it as a separate process.
- It carries over the API and Webhook output of claude-code-pipe (0.9.x). Compared with claude-code-pipe, it **adds** the following.
  - `pipeApp` (which app the event comes from; always `"coding-agent-pipe"`) and `engine` (which agent; for example `"claude-code"`) in Webhooks and in `GET /info`. claude-code-pipe does not send these two fields. When they are absent, a receiver can treat `pipeApp` as `claude-code-pipe` and `engine` as `claude-code`.
- Routes and fields that claude-code-pipe's documentation did not cover (`GET /health`, `GET /managed`, and the `alive` field of `GET /processes`, among others) are documented here (the features existed in claude-code-pipe as well).
- For the Webhook contract that reaches receivers (such as a viewer), [`schema/event.schema.json`](./schema/event.schema.json) is the source of truth.

---

## Configuration Details

Copy `config.example.json` to `config.json` and edit it. (`config.json` is read only once at startup. Restart after changing it.)

### Complete Configuration Structure

```json
{
  "engine": "claude-code",
  "watchDir": "~/.claude/projects",
  "port": 3100,
  "apiToken": "YOUR_TOKEN_HERE",
  "projectTitle": "",
  "callbackUrl": "http://localhost:3100",
  "subscribers": [
    {
      "url": "http://localhost:1880/webhook",
      "label": "my-service",
      "authorization": ""
    }
  ],
  "send": {
    "defaultAllowedTools": ["Read", "Grep", "Write", "Bash"],
    "cancelTimeoutMs": 3000,
    "defaultDangerouslySkipPermissions": false
  },
  "mqtt": {
    "url": "mqtts://broker.example.com:8883",
    "username": "",
    "password": "",
    "commandTopic": "claude/pipe-A/send"
  },
  "upload": {
    "maxBodySize": "10mb",
    "allowedExtensions": [".jpg", ".jpeg", ".png", ".pdf", ".txt", ".md", ".docx", ".xlsx", ".csv"],
    "maxAgeDays": 7
  },
  "viewer": {
    "deniedExtensions": [".pdf", ".zip", ".exe"],
    "imageExtensions": [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".ico", ".svg"],
    "maxFileSize": 1048576,
    "maxImageFileSize": 5242880
  }
}
```

### Configuration Fields

#### Root Level

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `engine` | string | No | `"claude-code"` | The coding agent to handle. Unset or empty means `claude-code`. An unknown value makes the process exit with an error at startup |
| `watchDir` | string | Yes | - | Directory to watch for session files (e.g., `~/.claude/projects`). `~` is expanded. **If it does not exist, the server tries to create it** (if it cannot be created, a warning is logged and startup continues) |
| `port` | number | No | `3100` | Port number for the server |
| `apiToken` | string | No | `""` | API authentication token. If set, all requests must include the `Authorization: Bearer TOKEN` header |
| `projectTitle` | string | No | `null` | User-defined project title (included in Webhook payloads and in `GET /info`) |
| `callbackUrl` | string | No | `null` | Callback URL of this server (included in Webhook payloads; receivers use it to send commands back) |
| `subscribers` | array | No | `[]` | List of Webhook subscribers |
| `send` | object | No | `{}` | Settings for sending |
| `mqtt` | object | No | none | MQTT command reception. See [MQTT Command Channel](#mqtt-command-channel) |
| `upload` | object | No | defaults below | Attachments. See [`POST /attachments`](#post-attachments) |
| `viewer` | object | No | defaults below | Viewing project files. See [`POST /projects/file`](#post-projectsfile) |

#### Subscribers

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `url` | string | Yes | - | Webhook endpoint URL |
| `label` | string | Yes | - | Label for identification in logs |
| `authorization` | string | No | `""` | Authorization header value (e.g., `Bearer YOUR_TOKEN`) |

> **Note:** `level` and `includeMessage`, which existed in claude-code-pipe, are deprecated and ignored (leaving them in the file does no harm). All events and full message content are always delivered. Filter on the receiver side by `type`, `isSubagent`, and `isMeta`.

#### Send Configuration

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `defaultAllowedTools` | array | No | `[]` | Default allowed tools used **for MQTT commands**. The REST send APIs (`POST /sessions/new`, `POST /sessions/:id/send`) do not use it. They pass the request's `allowedTools` as is (if omitted, no tools are specified) |
| `cancelTimeoutMs` | number | No | `3000` | Milliseconds a cancel operation waits after SIGINT before moving on to SIGTERM |
| `defaultDangerouslySkipPermissions` | boolean | No | `false` | **⚠️ DANGEROUS:** Default value for skipping permission confirmations. When `true`, every request to the REST send APIs skips permission confirmations (unless the request explicitly overrides it). See [Security Considerations](#security-considerations) for details |

#### Defaults for upload and viewer

| Field | Default |
|-------|---------|
| `upload.maxBodySize` | `"10mb"` (upper limit of the request body; larger bodies get 413) |
| `upload.allowedExtensions` | `.jpg` `.jpeg` `.png` `.pdf` `.txt` `.md` `.docx` `.xlsx` `.csv` |
| `upload.maxAgeDays` | `7` (attachments older than this are deleted at startup and every hour) |
| `viewer.maxFileSize` | `1048576` (1MB; text files) |
| `viewer.maxImageFileSize` | `5242880` (5MB; images) |
| `viewer.imageExtensions` | `.jpg` `.jpeg` `.png` `.gif` `.bmp` `.webp` `.ico` `.svg` |
| `viewer.deniedExtensions` | List of binary and dangerous extensions (`.pdf`, `.zip`, `.exe`, fonts, video and audio, databases, and so on; see `config.example.json` for the full list) |

### Webhook Delivery

All events and full message content are always delivered to every subscriber. Filter on the receiver side by `type`, `isSubagent`, and `isMeta` as needed.

**Event Types:**

- `session-started`, `assistant-response-completed`, `process-exit`
- `session-error`, `session-timeout`, `cancel-initiated`
- `user-message-received`

### Example Configurations

#### Minimal Configuration (Watch Only)

```json
{
  "watchDir": "~/.claude/projects",
  "port": 3100
}
```

#### Single Webhook (Node-RED)

```json
{
  "watchDir": "~/.claude/projects",
  "port": 3100,
  "subscribers": [
    { "url": "http://localhost:1880/webhook", "label": "node-red" }
  ]
}
```

#### Multiple Webhooks

```json
{
  "watchDir": "~/.claude/projects",
  "port": 3100,
  "subscribers": [
    { "url": "http://localhost:1880/webhook", "label": "node-red" },
    { "url": "https://hooks.slack.com/services/YOUR/WEBHOOK/URL", "label": "slack-notify" },
    { "url": "http://localhost:3200/debug", "label": "debug-logger", "authorization": "Bearer YOUR_TOKEN" }
  ]
}
```

#### With API Token (Production)

```json
{
  "watchDir": "~/.claude/projects",
  "port": 3100,
  "apiToken": "YOUR_TOKEN_HERE",
  "subscribers": [
    { "url": "http://localhost:1880/webhook", "label": "node-red" }
  ],
  "send": {
    "cancelTimeoutMs": 5000,
    "defaultDangerouslySkipPermissions": false
  }
}
```

#### With callbackUrl and projectTitle (Bidirectional Communication)

Useful when the side that receives the Webhook sends messages back to coding-agent-pipe through the send API.

```json
{
  "watchDir": "~/.claude/projects",
  "port": 3100,
  "apiToken": "YOUR_TOKEN_HERE",
  "projectTitle": "My Project",
  "callbackUrl": "http://localhost:3100",
  "subscribers": [
    { "url": "http://localhost:1880/webhook", "label": "node-red" }
  ]
}
```

- `callbackUrl` is included in the Webhook payload. A receiver can use this URL to send messages to the Send API (for example, from Node-RED: `{{callbackUrl}}/sessions/{{sessionId}}/send`).
- `projectTitle` is included in the Webhook payload. It lets you manage projects under human-friendly names.

> **About ports**: If claude-code-pipe runs on the same machine, use different ports (claude-code-pipe's default is 3100).

---

## API Reference

### Authentication

If `apiToken` is set in `config.json`, every API request requires the `Authorization` header.

```bash
curl -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  http://localhost:3100/sessions
```

If `apiToken` is unset or empty, authentication is disabled (not recommended in production). A missing or wrong token returns `401` with one of the following bodies.

```json
{ "error": "Unauthorized: Missing or invalid authorization header" }
```

```json
{ "error": "Unauthorized: Invalid token" }
```

`Authorization` must start with `Bearer ` (`Bearer` and the value are separated by a single space; a lowercase `bearer` is not accepted). While authentication is enabled, **a nonexistent route also returns `401` if there is no token** (with a token, it returns `404`).

### Common Query Parameters

- `projectPath` (most read routes): Narrows the result when the same session ID exists in multiple projects.
- The values `true` / `false` are compared as strings (`?excludeEmpty=false`).

### Info

#### `GET /health`

Health check. It returns whether the server is running, the version, and the seconds since startup. **When authentication is enabled, this route also requires the token.**

**Request:**

```bash
curl http://localhost:3100/health
```

**Response:**

```json
{
  "status": "ok",
  "version": "0.0.2",
  "uptime": 123.456
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | Always `"ok"` |
| `version` | string | Current version (from `package.json`) |
| `uptime` | number | Seconds since the process started |

`HEAD /health` also returns `200` (with no body). A trailing slash (`/health/`) makes no difference.

#### `GET /version`

Get the package information.

**Request:**

```bash
curl http://localhost:3100/version
```

**Response:**

```json
{
  "name": "coding-agent-pipe",
  "version": "0.0.2",
  "description": "A pipe for coding agent CLI input/output using JSONL and Hono"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Package name |
| `version` | string | Current version |
| `description` | string | Package description |

#### `GET /info`

Get the current configuration state of this pipe. It is meant for a viewer's initial grasp of the connection and for debugging. For continuous status tracking, use the `communicationMode` included in every Webhook payload rather than polling this endpoint.

**Request:**

```bash
curl http://localhost:3100/info
```

**Response:**

```json
{
  "version": "0.0.2",
  "os": "linux",
  "communicationMode": "bidirectional",
  "backendType": "claude_code",
  "pipeApp": "coding-agent-pipe",
  "engine": "claude-code",
  "callbackUrl": "http://localhost:3100",
  "mqttCommandTopic": "claude/pipe-A/send",
  "subscriberCount": 2,
  "projectTitle": "My Project",
  "watchDir": "~/.claude/projects"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Current version |
| `os` | string | One of `"linux"`, `"mac"`, `"windows"` (WSL is `"linux"`) |
| `communicationMode` | string | `"watch-only"` (no subscribers), `"webhook-only"` (has subscribers but neither `callbackUrl` nor `mqtt.commandTopic`), `"bidirectional"` (has subscribers, and also `callbackUrl` or `mqtt.commandTopic`) |
| `backendType` | string | Legacy compatibility field (`claude_code`). Use `engine` to tell which agent it is |
| `pipeApp` | string | Always `"coding-agent-pipe"` (claude-code-pipe does not send it) |
| `engine` | string | Which coding agent it is (e.g., `"claude-code"`; claude-code-pipe does not send it) |
| `callbackUrl` | string\|null | `config.callbackUrl`. `null` if unset |
| `mqttCommandTopic` | string\|null | `config.mqtt.commandTopic`. `null` if MQTT is not configured. The broker URL and credentials are not included |
| `subscriberCount` | number | Number of configured `subscribers` |
| `projectTitle` | string\|null | `config.projectTitle`. `null` if unset |
| `watchDir` | string | `config.watchDir` |

#### `GET /claude-version`

An **engine-specific route** (registered only when the engine is `claude-code`). Get the version of the Claude Code CLI.

**Request:**

```bash
curl http://localhost:3100/claude-version
```

**Response:**

```json
{
  "version": "2.1.289",
  "raw": "2.1.289 (Claude Code)"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Parsed version number |
| `raw` | string | Output of `claude -v` (with leading and trailing whitespace removed) |

**Errors (`500`):** `{ "error": "Failed to get claude version", "details": "..." }` when `claude -v` fails, and `{ "error": "Failed to execute claude command", "details": "..." }` when `claude` cannot be executed.

### Watch (Read)

APIs that read session files. All of them are `GET`, and they require `Authorization` when authentication is enabled.

#### `GET /projects`

Return the list of sessions for each project, ordered by session count in descending order.

**Query parameters:**

| Parameter | Default | Description |
|-------|------|-------------|
| `excludeAgents` | `true` | Exclude `agent-*` sessions (subagents). `false` includes them |
| `excludeEmpty` | `true` | Exclude sessions with 0 messages. `false` includes them |

**Request:**

```bash
curl http://localhost:3100/projects
```

**Response:**

```json
{
  "projects": [
    {
      "projectPath": "/home/user/projects/my-app",
      "projectName": "my-app",
      "sessionCount": 1,
      "sessions": [
        { "id": "11111111-1111-4111-8111-111111111111", "mtime": 1788220800000 }
      ]
    }
  ]
}
```

`mtime` is the modification time of the session file (epoch in milliseconds).

#### `GET /sessions`

Return the list of sessions with metadata.

**Query parameters:**

| Parameter | Default | Description |
|-------|------|-------------|
| `detail` | `false` | When `true`, return the first and last messages as objects (`content`, `timestamp`, `usage`) |
| `excludeAgents` | `true` | Exclude `agent-*` sessions |
| `excludeEmpty` | `true` | Exclude sessions with 0 messages |

**Request:**

```bash
curl http://localhost:3100/sessions
curl "http://localhost:3100/sessions?detail=true&excludeEmpty=false"
```

**Response (default):**

```json
{
  "sessions": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "createdAt": "2026-09-01T00:00:00.000Z",
      "lastModifiedAt": "2026-09-01T00:33:21.000Z",
      "messageCount": 11,
      "userMessageCount": 6,
      "assistantMessageCount": 5,
      "totalTokens": 123,
      "projectPath": "/home/user/projects/my-app",
      "projectName": "my-app",
      "firstUserMessage": "First question",
      "lastUserMessage": "Follow-up question",
      "firstAssistantMessage": "First answer",
      "lastAssistantMessage": "Follow-up answer"
    }
  ]
}
```

- `firstUserMessage` and the similar fields are strings that concatenate the `text` blocks. They are `null` when no matching message exists.
- `totalTokens` is the sum of the assistant's `input_tokens` and `output_tokens`.
- With `detail=true`, `firstUserMessage` and the similar fields become objects of the form `{ "content": "...", "timestamp": "..." }` (assistant messages also include `usage`).

#### `GET /sessions/:id/signals`

Return an array of "signals" that contain no message body (type, time, duration, and body size in bytes). Subagents are not included, because they have separate files and separate session IDs.

**Query parameters:** `projectPath` (optional; when the same ID exists in multiple projects)

**Request:**

```bash
curl http://localhost:3100/sessions/SESSION_ID/signals
```

**Response:**

```json
{
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "signals": [
    { "type": "user", "start": "2026-09-01T00:00:00.000Z", "end": "2026-09-01T00:00:00.000Z", "durationMs": 0, "textBytes": 21 },
    { "type": "tool-use", "toolName": "Read", "start": "2026-09-01T00:00:03.000Z", "end": "2026-09-01T00:00:04.000Z", "durationMs": 1000 },
    { "type": "assistant", "start": "2026-09-01T00:00:05.000Z", "end": "2026-09-01T00:00:05.000Z", "durationMs": 0, "textBytes": 15 }
  ]
}
```

| `type` | Description |
|-------|-------------|
| `user` | A user message (`start` and `end` are the same; `durationMs` is 0). Lines that contain only a `tool_result` are not included |
| `assistant` | The assistant's body text (`textBytes` is the UTF-8 byte count of the `text` blocks; `thinking` and `tool_use` are not included) |
| `tool-use` | The time difference between a `tool_use` and its matching `tool_result` (matched by `tool_use_id`). `end` and `durationMs` are `null` until the result arrives |

Lines with `isMeta` are excluded.

#### `GET /sessions/:id/messages`

Return all messages of a session.

**Query parameters:**

| Parameter | Description |
|-------|-------------|
| `projectPath` | Narrows the result when the same ID exists in multiple projects |
| `textOnly` | When `true`, return only body-text turns (`role`, `timestamp`, `text`), excluding `tool_use`, `tool_result`, and `isMeta`. Turns whose body becomes empty are dropped |
| `limit` | A positive integer; keep only the last N entries (after formatting) |

**Request:**

```bash
curl http://localhost:3100/sessions/SESSION_ID/messages
curl "http://localhost:3100/sessions/SESSION_ID/messages?textOnly=true&limit=30"
```

**Response (default; the JSONL lines as they are):**

```json
{
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "events": [
    {
      "parentUuid": null,
      "isMeta": false,
      "sessionId": "11111111-1111-4111-8111-111111111111",
      "timestamp": "2026-09-01T00:00:00.000Z",
      "uuid": "u-1",
      "tools": [],
      "message": { "role": "user", "content": "First question" }
    }
  ]
}
```

**Response (`textOnly=true`):**

```json
{
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "events": [
    { "role": "user", "timestamp": "2026-09-01T00:00:00.000Z", "text": "First question" },
    { "role": "assistant", "timestamp": "2026-09-01T00:00:01.000Z", "text": "First answer" }
  ]
}
```

**Error:** `404` `{ "error": "Session not found" }` when the session is not found.

#### First / latest message (8 routes)

Each of the following 8 routes returns exactly one message that matches the condition. All of them accept `projectPath`.

| Route | Returns |
|-------|-------------|
| `GET /sessions/:id/messages/user/first` | The first `user` message |
| `GET /sessions/:id/messages/user/latest` | The last `user` message |
| `GET /sessions/:id/messages/assistant/first` | The first `assistant` message |
| `GET /sessions/:id/messages/assistant/latest` | The last `assistant` message |
| `GET /sessions/:id/messages/chat/user/first` | The first user **chat** message |
| `GET /sessions/:id/messages/chat/user/latest` | The last user **chat** message |
| `GET /sessions/:id/messages/chat/assistant/first` | The first assistant **chat** message |
| `GET /sessions/:id/messages/chat/assistant/latest` | The last assistant **chat** message |

A **"chat" message** is a pure conversation message, excluding tool operations.
- User: `content` is a string, or an array that contains no `tool_result`.
- Assistant: `content` is an array that has a `text` block and no `tool_use` block.

**Request:**

```bash
curl http://localhost:3100/sessions/SESSION_ID/messages/assistant/latest
```

**Response:**

```json
{
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "message": {
    "parentUuid": "u-5",
    "isMeta": false,
    "sessionId": "11111111-1111-4111-8111-111111111111",
    "timestamp": "2026-09-01T00:33:21.000Z",
    "uuid": "a-3",
    "tools": [],
    "message": {
      "role": "assistant",
      "content": [{ "type": "text", "text": "Follow-up answer" }],
      "usage": { "input_tokens": 30, "output_tokens": 7, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0 }
    }
  }
}
```

**Errors (`404`):**

| Situation | Body |
|-------|-------------|
| The session is not found | `{ "error": "Session not found" }` |
| No matching message | `{ "error": "No user messages found" }` (`No assistant messages found` for `assistant`; `No user chat messages found` / `No assistant chat messages found` for chat) |

### Send Mode

#### `POST /sessions/new`

Start a new session (the agent's CLI is started as a child process). The response returns once the startup is confirmed.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | Yes | The prompt to send |
| `projectPath` | string | Yes (or `cwd`) | Working directory of the session (an existing directory) |
| `cwd` | string | - | Alias of `projectPath` (backward compatibility). If both are given, `projectPath` takes precedence |
| `allowedTools` | array | No | Tools to allow. If omitted, no tools are specified (`send.defaultAllowedTools` is not used) |
| `disallowedTools` | array | No | Tools to forbid |
| `model` | string | No | Model to use |
| `dangerouslySkipPermissions` | boolean | No | Skip permission confirmations. If omitted, `send.defaultDangerouslySkipPermissions` applies. **⚠️ Dangerous.** See [Security Considerations](#security-considerations) |

**Request:**

```bash
curl -X POST http://localhost:3100/sessions/new \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Summarize the README", "projectPath": "/home/user/projects/my-app", "allowedTools": ["Read", "Grep"]}'
```

**Response (`200`):**

```json
{
  "message": "Session started",
  "sessionId": "55555555-5555-4555-8555-555555555555",
  "pid": 12345,
  "model": "claude-opus-5-5",
  "cwd": "/home/user/projects/my-app",
  "permissionMode": "default",
  "claudeCodeVersion": "2.1.289",
  "apiKeySource": "none",
  "tools": ["Read", "Grep", "Bash"]
}
```

At startup, the Webhook `session-started` is delivered (later followed by `user-message-received` and `assistant-response-completed`, and by `process-exit` when the process ends).

**Errors:**

| Status | Body | Situation |
|-------|-------------|-------------|
| `400` | `{ "error": "prompt is required" }` | `prompt` is missing or empty |
| `400` | `{ "error": "projectPath is required", "message": "..." }` | `projectPath` (and `cwd`) is missing |
| `400` | `{ "error": "projectPath does not exist", "message": "..." }` | The directory does not exist |
| `500` | `{ "error": "Failed to start new session" }` | Startup failed (the reason appears only in the log; see the note below) |

> **Note: The reason for a `500` is not returned.** It happens in cases such as the following (all are known behaviors inherited from claude-code-pipe; see [Errors and Limits](#errors-and-limits)).
> - If the agent's startup output (`system/init`) exceeds about 4KB, the startup may not be detected
> - The prompt is too long (about 128KB; about 64KB when it contains many `\` `"` `` ` `` `$`)
> - The `script` command is missing, the agent does not start, or the startup times out (60 seconds)

#### `POST /sessions/:id/send`

Send a message to an existing session (starts a new process with the agent's `--resume`).

**Request body:** Same as `POST /sessions/new` (`prompt` and `projectPath` (or `cwd`) are required).

**Request:**

```bash
curl -X POST http://localhost:3100/sessions/SESSION_ID/send \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Continue", "projectPath": "/home/user/projects/my-app"}'
```

**Response (`200`):**

```json
{
  "success": true,
  "message": "Message sent successfully",
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "pid": 12346,
  "model": "claude-opus-5-5",
  "cwd": "/home/user/projects/my-app",
  "permissionMode": "default",
  "claudeCodeVersion": "2.1.289",
  "apiKeySource": "none"
}
```

**Errors:** `400` (`prompt is required` / `projectPath is required` / `projectPath does not exist`; same as `POST /sessions/new`), `404` `{ "error": "Session not found" }` (the session is not found), `500` `{ "error": "Failed to send message" }`.

> **If a message is sent twice in a row to the same session**, the first process is dropped from management and can no longer be stopped by `DELETE /processes` or `cancel` (a known behavior; see [Errors and Limits](#errors-and-limits)).

### MQTT Command Channel

Instead of the REST send APIs, MQTT can drive sessions. Event delivery (pipe to receiver) always uses the HTTP Webhook; MQTT is dedicated to receiving commands (receiver to pipe). It is configured independently through `config.mqtt`.

**Configuration:**

```json
{
  "mqtt": {
    "url": "mqtts://broker.example.com:8883",
    "username": "YOUR_USER",
    "password": "YOUR_PASSWORD",
    "commandTopic": "claude/pipe-A/send"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | Yes | Broker URL. `mqtt://` (plaintext) or `mqtts://` (TLS) |
| `username` | string | No | Username, if the broker requires authentication |
| `password` | string | No | Password, if the broker requires authentication |
| `commandTopic` | string | Yes | Topic this pipe subscribes to in order to receive commands |

If `config.mqtt` is omitted (or `url` or `commandTopic` is missing), the MQTT channel is disabled (no connection is attempted).

**Command payload** (JSON that a receiver publishes to `commandTopic`):

```json
{
  "prompt": "Your prompt here",
  "projectPath": "/path/to/project",
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "model": "sonnet"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | Yes | The prompt to send |
| `projectPath` | string | No | Working directory for a **new** session. Ignored when `sessionId` is present. **If omitted, the command runs in the server's startup directory** (unlike REST, where `projectPath` is required) |
| `sessionId` | string | No | If given, send to the existing session (`--resume`). If omitted, a new session is started |
| `model` | string | No | Model to use |

- Allowed tools come from `config.send.defaultAllowedTools` (the REST send APIs do not use it).
- QoS is 0 (fire and forget), and the publisher receives no acknowledgment. A command published while the connection to the broker is down is silently lost.
- **Malformed commands are silently discarded**: a command with a missing or empty `prompt`, or one that is not JSON, starts nothing and emits no Webhook. The error appears only in the server log (`[mqtt] Command missing required field: prompt`, `[mqtt] Invalid JSON payload: ...`).
- If the broker goes down, the server keeps running (`/health` still responds). When the broker returns, the server reconnects and resubscribes. If the broker is not there at startup, the server still starts and connects later. If authentication fails, the server also keeps running (the log shows `Connection error: Connection refused: Bad username or password`).
- `mqtt.password` is never exposed. Only `commandTopic` is included in the Webhook payload's `mqttCommandTopic` and in `GET /info`.

**Platform note:** On native Windows, the MQTT command channel is disabled. If `config.mqtt` is set on native Windows, a warning is logged at startup and no connection is made (the REST send APIs work on native Windows too, by starting the agent directly).

### Cancel Mode

#### `POST /sessions/:id/cancel`

Cancel a process that this pipe started and manages. It sends SIGINT first.

**Request:**

```bash
curl -X POST http://localhost:3100/sessions/SESSION_ID/cancel
```

**Response (`200`):**

```json
{
  "cancelled": true,
  "pid": 12345,
  "sessionId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
}
```

The Webhook `cancel-initiated` is delivered, and `process-exit` is delivered when the process ends.

**Error (`404`):** `{ "error": "Session not found or not managed" }` (a session this pipe does not manage, or one that has already ended).

> **Note:** The mechanism that moves on to SIGTERM when the process has not ended after SIGINT and `send.cancelTimeoutMs` has elapsed **does not work because of a known defect** (behavior inherited from claude-code-pipe). To stop a process reliably, use [`DELETE /processes/:sessionId`](#delete-processessessionid).

### Management

Only processes that this pipe started (`POST /sessions/new`, `POST /sessions/:id/send`, MQTT commands) are managed. Sessions run directly in a terminal or elsewhere are not included.

#### `GET /processes`

Return the list of managed processes.

**Request:**

```bash
curl http://localhost:3100/processes
```

**Response:**

```json
{
  "processes": [
    {
      "sessionId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "pid": 12345,
      "startedAt": "2026-09-01T00:00:00.000Z",
      "alive": true
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | string | Session ID |
| `pid` | number | Process ID |
| `startedAt` | string | Time the process started (ISO 8601) |
| `alive` | boolean | Whether the process is alive |

If there are no managed processes, the response is `{ "processes": [] }`.

#### `GET /managed`

Return the list of managed processes. It has the same fields as `GET /processes`, but **returns the array as is, without wrapping it in `processes`**.

**Request:**

```bash
curl http://localhost:3100/managed
```

**Response:**

```json
[
  {
    "sessionId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "pid": 12345,
    "startedAt": "2026-09-01T00:00:00.000Z",
    "alive": true
  }
]
```

If there are no managed processes, the response is `[]`.

#### `DELETE /processes/:sessionId`

Terminate the managed process of the specified session.

**Request:**

```bash
curl -X DELETE http://localhost:3100/processes/SESSION_ID
```

**Response (`200`):**

```json
{
  "message": "Process terminated",
  "killed": true,
  "pid": 12345,
  "sessionId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
}
```

It can take about 1 to 4 seconds for the process to actually end.

**Error (`404`):** `{ "error": "Process not found", "sessionId": "..." }`.

#### `DELETE /processes`

Terminate all managed processes (for emergencies).

**Request:**

```bash
curl -X DELETE http://localhost:3100/processes
```

**Response (`200`):**

```json
{
  "message": "All processes terminated",
  "killed": 2,
  "sessions": [
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    "ffffffff-ffff-4fff-8fff-ffffffffffff"
  ]
}
```

If there are no managed processes, `killed` is `0` and `sessions` is `[]`.

### Files

#### `GET /attachments-config`

Return the attachment settings (the size limit and the allowed extensions).

**Request:**

```bash
curl http://localhost:3100/attachments-config
```

**Response:**

```json
{
  "maxBodySize": "10mb",
  "allowedExtensions": [".jpg", ".jpeg", ".png", ".pdf", ".txt", ".md", ".docx", ".xlsx", ".csv"]
}
```

#### `POST /attachments`

Save a base64 file (an image, text, PDF, and so on) to `/tmp/coding-agent-pipe/` on the server. The intended use is to put the saved path in a later prompt so that the agent reads the file.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `data` | string | Yes | The file content in base64 |
| `filename` | string | Yes | The original file name (its extension must be in `allowedExtensions`) |

**Request:**

```bash
curl -X POST http://localhost:3100/attachments \
  -H "Content-Type: application/json" \
  -d '{"data": "iVBORw0KGgo...", "filename": "screenshot.png"}'
```

**Response (`200`):**

```json
{
  "path": "/tmp/coding-agent-pipe/550e8400-e29b-41d4-a716-446655440000-screenshot.png",
  "filename": "550e8400-e29b-41d4-a716-446655440000-screenshot.png"
}
```

- The saved name is `<UUID>-<original file name>`, and any character in the file name other than `a-zA-Z0-9._-` is replaced with `_`.
- The save location differs from claude-code-pipe's (`/tmp/claude-code-pipe/`). Running both on the same machine causes no conflict.
- Files older than `config.upload.maxAgeDays` (default 7 days) are deleted at startup and every hour.

**Errors:** `400` `{ "error": "data and filename are required" }`, `400` `{ "error": "File type not allowed. Allowed: ..." }`, `413` (the body exceeds `maxBodySize`; see [Errors and Limits](#errors-and-limits)), `500` `{ "error": "Failed to save file" }`.

#### `POST /projects/file`

Return the content of a file inside a project directory (for viewers). For safety, the following restrictions apply.

- `filePath` is a relative path pointing inside `projectPath`, and it must still stay inside after symbolic links are resolved
- Files and directories that start with `.` (`.env`, `.git`, `.ssh`, and so on) are always rejected
- Files matched by `.gitignore` are rejected (only when it can be determined in a git repository)
- Extensions in `viewer.deniedExtensions` are rejected (images excepted)
- It must be a regular file. The size limits are 1MB for text and 5MB for images (`viewer.maxFileSize`, `viewer.maxImageFileSize`)

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `projectPath` | string | Yes | The project directory (must exist) |
| `filePath` | string | Yes | Path relative to `projectPath` |

**Request:**

```bash
curl -X POST http://localhost:3100/projects/file \
  -H "Content-Type: application/json" \
  -d '{"projectPath": "/home/user/projects/my-app", "filePath": "src/index.js"}'
```

**Response (text, `200`):**

```json
{
  "content": "console.log('hello');\n",
  "mtime": "2026-09-01T00:00:00.000Z",
  "size": 22,
  "encoding": "utf8"
}
```

**Response (image, `200`):** `encoding` is `"base64"`, and `mimeType` is added.

```json
{
  "content": "iVBORw0KGgoBAgME",
  "mtime": "2026-09-01T00:00:00.000Z",
  "size": 12,
  "encoding": "base64",
  "mimeType": "image/png"
}
```

**Errors:**

| Status | Body (`error`) | Situation |
|-------|-------------|-------------|
| `400` | `projectPath and filePath are required` | One of them is missing |
| `400` | `projectPath does not exist` | The project directory does not exist |
| `400` | `filePath must resolve within projectPath` | It points outside the project (`..` or a symbolic link) |
| `400` | `Hidden files/directories are not viewable via this API. Use code-server instead.` | Starts with `.` |
| `400` | `File type not viewable via this API: <extension>. Use code-server instead.` | `deniedExtensions` |
| `400` | `File is git-ignored and not viewable via this API. Use code-server instead.` | Matched by `.gitignore` |
| `400` | `filePath must point to a regular file` | A directory, for example |
| `404` | `File not found` | The file does not exist |
| `413` | `File too large. Max size: <bytes> bytes` | The size limit is exceeded |
| `500` | `Failed to read file` | Reading failed |

### Git

#### `GET /git/status`

Return the git status of a project.

**Query parameters:**

| Parameter | Required | Description |
|-------|----------|-------------|
| `projectPath` | Yes | The project directory |
| `files` | No | When `true`, include the file lists. By default, only counts are returned |

**Request:**

```bash
curl "http://localhost:3100/git/status?projectPath=/home/user/projects/my-app"
curl "http://localhost:3100/git/status?projectPath=/home/user/projects/my-app&files=true"
```

**Response (default):**

```json
{
  "branch": "main",
  "ahead": 0,
  "behind": 0,
  "stagedCount": 0,
  "unstagedCount": 0,
  "untrackedCount": 0,
  "isClean": true
}
```

**Response (`files=true`):** Instead of `stagedCount` and the like, `staged`, `unstaged`, and `untracked` (arrays of files) are added.

```json
{
  "branch": "main",
  "ahead": 0,
  "behind": 0,
  "isClean": true,
  "staged": [],
  "unstaged": [],
  "untracked": []
}
```

**Errors:** `400` `{ "error": "projectPath is required" }`, `404` `{ "error": "Not a git repository" }`.

#### `GET /git/log`

Return the git log of a project (it shows unpushed commits).

**Query parameters:**

| Parameter | Required | Description |
|-------|----------|-------------|
| `projectPath` | Yes | The project directory |
| `limit` | No | Number of entries. Default `20`, maximum `100` |

**Request:**

```bash
curl "http://localhost:3100/git/log?projectPath=/home/user/projects/my-app&limit=10"
```

**Response:**

```json
{
  "commits": [
    {
      "hash": "727d49b",
      "fullHash": "727d49b5bbf40655c59ad826cd03565961c7c2d6",
      "author": "Alice",
      "date": "2026-09-01 00:00:00 +0000",
      "message": "initial commit",
      "unpushed": false
    }
  ],
  "unpushedCount": 0
}
```

**Errors:** `400` `{ "error": "projectPath is required" }`, `404` `{ "error": "Not a git repository" }`.

---

## Webhook Event Format

A Webhook receives JSON with the following structure by `POST` (`Content-Type: application/json`). The contract's source of truth is [`schema/event.schema.json`](./schema/event.schema.json). If `subscribers[].authorization` is set, its value is attached as the `Authorization` header.

### Event Structure

#### Fields common to all events

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Event type (see [Event Types](#event-types)) |
| `version` | string | Version of the sending app |
| `sessionId` | string | Session ID |
| `timestamp` | string | ISO 8601. For message events, the time from the JSONL; for process events, the pipe's execution time |
| `cwdPath` | string | Full path of the directory where this pipe was started |
| `cwdName` | string | Base name of the same directory |
| `callbackUrl` | string\|null | `config.callbackUrl` (`null` if unset). The URL a receiver uses to come back to this pipe |
| `os` | string | `"mac"`, `"linux"`, `"windows"` (WSL is `"linux"`) |
| `communicationMode` | string | `"watch-only"`, `"webhook-only"`, `"bidirectional"` (see [`GET /info`](#get-info)) |
| `backendType` | string | Legacy compatibility field (`claude_code`) |
| `pipeApp` | string | Always `"coding-agent-pipe"`. claude-code-pipe does not send it (when absent, it can be treated as `claude-code-pipe`) |
| `engine` | string | Which coding agent it is (e.g., `"claude-code"`). claude-code-pipe does not send it (when absent, it can be treated as `claude-code`) |
| `mqttCommandTopic` | string | `config.mqtt.commandTopic` (only when set) |
| `projectPath`, `projectName` | string | Path and name of the session's project (derived from the location of the session file; **not attached to subagent events**) |
| `projectTitle` | string | `config.projectTitle` (only when set) |

#### Message events (`user-message-received`, `assistant-response-completed`)

| Field | Type | Description |
|-------|------|-------------|
| `source` | string | `"api"` (a session of a process this pipe started) or `"cli"` (operated directly) |
| `isSubagent` | boolean | `true` if it comes from a subagent session (a file under `subagents/`) |
| `isMeta` | boolean | `true` for a message the agent's harness inserted automatically (e.g., "Continue from where you left off.") |
| `git` | object\|null | Git information of the project (`branch`, `commit`, `isWorktree`, `mainWorktreePath`). `null` if it is not a git repository |
| `message` | object | The JSONL message (`role`, `content`, `usage`). **Always included** |

`assistant-response-completed` additionally has the following fields.

| Field | Type | Description |
|-------|------|-------------|
| `tools` | array | Names of the tools used in this response |
| `responseTime` | number\|null | Seconds elapsed since the previous message |

#### Process events (`session-started`, `session-error`, `session-timeout`, `cancel-initiated`, `process-exit`)

| Field | Type | Description |
|-------|------|-------------|
| `pid` | number | Process ID |
| `model` | string\|null | The model of `session-started` |
| `resumed` | boolean | In `session-started`, `true` when an existing session is resumed |
| `code`, `signal` | number\|null, string\|null | The exit code and the exit signal of `process-exit` |
| `error` | string | The reason for `session-error` and `session-timeout` |

### Event Types

| Type | Description | Source |
|------|-------------|--------|
| `session-started` | A new session was created or resumed | A process this pipe started |
| `user-message-received` | A user message was appended to the session file | Session file watching |
| `assistant-response-completed` | An assistant response was appended | Session file watching |
| `process-exit` | A process this pipe started exited | A process this pipe started |
| `session-error` | Starting the process failed | A process this pipe started |
| `session-timeout` | Timed out (60 seconds) without the startup being confirmed | A process this pipe started |
| `cancel-initiated` | A cancel was requested | Cancel |

Message events are emitted by **watching the session files**, so they also cover sessions run directly in a terminal or elsewhere (`source: "cli"`). Process events cover only processes this pipe started.

### Event Examples

`pipeApp` and `engine` below do not exist in claude-code-pipe.

#### user-message-received

```json
{
  "type": "user-message-received",
  "version": "0.0.2",
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "timestamp": "2026-09-01T00:33:20.000Z",
  "cwdPath": "/home/user/workspace/repos/coding-agent-pipe",
  "cwdName": "coding-agent-pipe",
  "callbackUrl": "http://localhost:3100",
  "os": "linux",
  "communicationMode": "bidirectional",
  "backendType": "claude_code",
  "pipeApp": "coding-agent-pipe",
  "engine": "claude-code",
  "projectPath": "/home/user/projects/my-app",
  "projectName": "my-app",
  "projectTitle": "My Project",
  "source": "cli",
  "isSubagent": false,
  "isMeta": false,
  "git": { "branch": "main", "commit": "727d49b", "isWorktree": false, "mainWorktreePath": "/home/user/projects/my-app" },
  "message": { "role": "user", "content": "Follow-up question" }
}
```

#### assistant-response-completed

```json
{
  "type": "assistant-response-completed",
  "version": "0.0.2",
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "timestamp": "2026-09-01T00:33:21.000Z",
  "cwdPath": "/home/user/workspace/repos/coding-agent-pipe",
  "cwdName": "coding-agent-pipe",
  "callbackUrl": "http://localhost:3100",
  "os": "linux",
  "communicationMode": "bidirectional",
  "backendType": "claude_code",
  "pipeApp": "coding-agent-pipe",
  "engine": "claude-code",
  "projectPath": "/home/user/projects/my-app",
  "projectName": "my-app",
  "projectTitle": "My Project",
  "source": "cli",
  "isSubagent": false,
  "isMeta": false,
  "git": { "branch": "main", "commit": "727d49b", "isWorktree": false, "mainWorktreePath": "/home/user/projects/my-app" },
  "tools": [],
  "responseTime": 1,
  "message": {
    "role": "assistant",
    "content": [
      { "type": "thinking", "thinking": "Follow-up thought", "signature": "SIG2" },
      { "type": "text", "text": "Follow-up answer" }
    ],
    "usage": { "input_tokens": 30, "output_tokens": 7, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0 }
  }
}
```

#### session-started

```json
{
  "type": "session-started",
  "version": "0.0.2",
  "sessionId": "55555555-5555-4555-8555-555555555555",
  "timestamp": "2026-09-01T00:00:00.000Z",
  "cwdPath": "/home/user/workspace/repos/coding-agent-pipe",
  "cwdName": "coding-agent-pipe",
  "callbackUrl": "http://localhost:3100",
  "os": "linux",
  "communicationMode": "bidirectional",
  "backendType": "claude_code",
  "pipeApp": "coding-agent-pipe",
  "engine": "claude-code",
  "projectPath": "/home/user/projects/my-app",
  "projectName": "my-app",
  "pid": 12345,
  "model": "claude-opus-5-5"
}
```

#### process-exit

```json
{
  "type": "process-exit",
  "version": "0.0.2",
  "sessionId": "55555555-5555-4555-8555-555555555555",
  "timestamp": "2026-09-01T00:00:05.000Z",
  "cwdPath": "/home/user/workspace/repos/coding-agent-pipe",
  "cwdName": "coding-agent-pipe",
  "callbackUrl": "http://localhost:3100",
  "os": "linux",
  "communicationMode": "bidirectional",
  "backendType": "claude_code",
  "pipeApp": "coding-agent-pipe",
  "engine": "claude-code",
  "projectPath": "/home/user/projects/my-app",
  "projectName": "my-app",
  "pid": 12345,
  "code": 0,
  "signal": null
}
```

#### cancel-initiated

The same common fields as `session-started`, plus `pid` (`type` is `"cancel-initiated"`).

#### session-error and session-timeout

The common fields, plus `error`. When startup fails, the real session ID is unknown, so `sessionId` is a temporary ID of the form `temp-<time>-<pid>`.

```json
{
  "type": "session-timeout",
  "sessionId": "temp-1788220800000-12345",
  "pid": 12345,
  "error": "Session start timeout: Failed to retrieve session ID"
}
```

(The common fields are omitted. The `error` of `session-error` is, for example, `spawn script ENOENT`.)

---

## Errors and Limits

### Error Format

Errors are JSON of the form `{ "error": "..." }` (some also carry `message` or `details`).

| Status | Body | Situation |
|-------|-------------|-------------|
| `400` | `{ "error": "Invalid JSON payload" }` | The request body is malformed as JSON |
| `401` | `{ "error": "Unauthorized: ..." }` | Authentication is required, but the token is missing or wrong |
| `404` | `{ "error": "Not Found" }` | No matching route |
| `413` | `{ "error": "Payload Too Large" }` | The body exceeds `upload.maxBodySize` (default 10mb) |
| `500` | `{ "error": "Internal Server Error" }` | Unexpected error |

For the errors specific to each route, see the section of that route.

### Differences from claude-code-pipe

- Error bodies (such as 404 and 413) were Express HTML in claude-code-pipe; coding-agent-pipe returns JSON.
- There is no automatic response to `OPTIONS` (if CORS is needed, use a reverse proxy or similar).
- Routing is case-sensitive (`/Health` is 404). A trailing slash (`/health/`) makes no difference.
- Attachments are saved to `/tmp/coding-agent-pipe/` (claude-code-pipe used `/tmp/claude-code-pipe/`).

### Known behaviors (inherited from claude-code-pipe)

The following behaviors are inherited from claude-code-pipe and are unchanged for now.

| Behavior | Impact | Workaround |
|-------|-------------|-------------|
| If the agent's startup output (`system/init`) exceeds about 4KB, the startup may not be detected (the boundary is unstable and failure is probabilistic) | `POST /sessions/new` and `POST /sessions/:id/send` return `500` (`Failed to start new session`). The agent's process may keep running | Reduce skills, plugins, and MCP servers to make the output smaller |
| The prompt limit is about 128KB. With many `\` `"` `` ` `` `$`, escaping doubles the size and the limit becomes about 64KB | `500` (no explanation of the reason) | Shorten the prompt. Pass long content as an attachment (`POST /attachments`) and write the path in the prompt |
| Sending twice in a row to the same session | The first process is dropped from management and cannot be stopped by `DELETE /processes` or `cancel` | Send the next message after the previous send has finished |
| If a single line is written in pieces with a gap of 100ms or more, that line is lost | Rarely, a message event is missing | (Depends on how the agent writes) |
| With multiple `subscribers`, `responseTime` is 0 for the second and later ones | `responseTime` in `assistant-response-completed` is inaccurate | Do not rely on `responseTime` on the receiver side |
| Subagent events have no `projectPath` or `projectName` | They cannot be tied to a project | Handle them by `sessionId` and `isSubagent` |
| If `watchDir` does not exist, the server tries to create it | A typo can create a stray directory. If it cannot be created, only a warning is logged and startup continues | Check `watchDir` |
| If a connection whose request has stalled exists, shutdown (SIGINT / SIGTERM) does not finish | The process does not exit | Wait for the connection to close, or use `kill -9` |
| The mechanism that moves on to SIGTERM after SIGINT in `cancel` does not work | The process may not stop even after `cancelTimeoutMs` | Stop it with `DELETE /processes/:sessionId` |
| Shutting down the server does not stop the child processes (agents) it started | The agents may keep running after shutdown | Stop them with `DELETE /processes` before shutting down |

---

## Troubleshooting

### Server won't start

**Symptom:** `Error: listen EADDRINUSE: address already in use :::3100`

**Solution:** The port is in use. Check what is using it.

```bash
lsof -i :3100
```

Terminate the process or change `port` in `config.json`. Also check whether claude-code-pipe is using 3100 on the same machine.

---

**Symptom:** `[index] Failed to load config.json: ...`

**Solution:** `config.json` is missing or is malformed JSON.

```bash
cp config.example.json config.json
```

Then edit it to suit your environment.

---

**Symptom:** `[index] Unknown engine: "..."`

**Solution:** `config.engine` contains an unsupported value. Currently only `claude-code` is available (an unset value also means `claude-code`).

---

### No events received

**Symptom:** Events do not reach the Webhook receiver.

**Solution 1:** Check that the receiver's URL is reachable.

```bash
curl -X POST http://localhost:1880/webhook \
  -H "Content-Type: application/json" \
  -d '{"test": "message"}'
```

**Solution 2:** Check the server log for `[subscribers] Error posting to ...` (the server keeps running even if the destination is down).

**Solution 3:** Check `subscribers` in `config.json` (`url` is correct, and a `label` is set).

---

### Session not found

**Symptom:** `GET /sessions/:id/messages` returns `404` (`Session not found`).

**Solution 1:** Check whether the session exists.

```bash
curl http://localhost:3100/sessions
```

**Solution 2:** Check that `watchDir` points to the correct directory.

```bash
ls ~/.claude/projects
```

`.jsonl` files should be there. Right after startup, **appends made after startup to files that existed before startup** are the ones covered by the Webhook.

**Solution 3:** Check the file read permissions (the user running coding-agent-pipe must be able to read the files).

---

### Cancel not working

**Symptom:** The process does not stop even after `POST /sessions/:id/cancel`.

**Solution:** `cancel` sends SIGINT first. The mechanism that then moves on to SIGTERM **does not work because of a known defect** (behavior inherited from claude-code-pipe). To stop a process reliably, use `DELETE /processes/:sessionId`. Also, `cancel` and `DELETE /processes` target only processes this pipe started (you can check them with `GET /processes`).

---

### `POST /sessions/new` returns `500`

**Symptom:** `{ "error": "Failed to start new session" }`

**Solution:** The reason appears only in the server log (`[api] Error starting new session:`). Common causes are as follows.

- The `script` command is missing (on Linux, macOS, and WSL, it is required to receive the agent's output through a PTY)
- `claude` is not in `PATH`
- The prompt is too long (see [Known behaviors](#known-behaviors-inherited-from-claude-code-pipe))
- The agent's startup output is too large for the startup to be detected (same as above)
- The startup timed out (60 seconds)

---

### Authentication errors

**Symptom:** `401 Unauthorized: Missing or invalid authorization header`

**Solution 1:** Add the `Authorization` header to the request.

```bash
curl -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  http://localhost:3100/sessions
```

**Solution 2:** Check that the token matches `apiToken` in `config.json`.

**Solution 3:** If authentication is not needed, empty `apiToken` and restart the server.

---

### Stopping and restarting the server

**Stop:** `Ctrl+C` (SIGINT) or SIGTERM. This stops the observation sources and the server, then exits. **The agent processes it started are not stopped** (stop them first with `DELETE /processes`).

**Restart:** Stop the server, then start it with `npm start`. Configuration changes take effect on restart (the file is read only once at startup).

---

### Platform-specific notes

- **Linux, macOS, WSL**: The agent is started with `script -q -c "<escaped command>" /dev/null` (a PTY, to avoid stdout buffering).
- **Windows (native)**: The agent is started directly with `spawn`, passing arguments as an array and without a shell. No escaping is needed. **The MQTT command channel is disabled on native Windows** (a warning is logged at startup). Native Windows could not be tried in this environment.

---

## Development

### Project Structure

```
coding-agent-pipe/
├── src/
│   ├── index.js                  Assembly (Hono, authentication, routes, shutdown)
│   ├── package-info.js           Package information and the pipeApp value
│   ├── core/                     Engine-independent parts
│   │   ├── api.js                REST routes (read, send, management, files, git)
│   │   ├── process.js            Management of started processes
│   │   ├── canceller.js          Cancel
│   │   ├── deliver.js            Webhook delivery
│   │   ├── mqtt-receiver.js      MQTT command reception
│   │   ├── git-info.js           Git information
│   │   ├── http-utils.js         Request body handling, etc.
│   │   ├── platform.js           OS detection
│   │   └── sources/              Observation sources (read appends to session files)
│   └── adapters/                 Engine-specific parts
│       ├── index.js              Select one adapter by config.engine
│       └── claude-code/          Adapter for Claude Code
├── schema/event.schema.json      Contract for Webhooks and GET /info
└── config.example.json
```

### The adapter interface

`core` does not know about engines. Engine-specific knowledge (where to read, how to interpret, how to start) is handed to `core` by `src/adapters/<engine>/index.js` through the following interface.

| Item | Role |
|-------|-------------|
| `id`, `backendType` | The engine's identifier and the legacy compatibility field |
| `observe`, `parse(line)` | How to observe, and how to interpret one line |
| `resolveProject`, `isSubagent`, `isAgentSession`, `sessionIdFromPath` | Derive the project and so on from where a session comes from |
| `sessions` | `{ list, locate, read }`. The entry point to session data used by REST reads |
| `spawn` | `{ buildArgs, spawnProcess, parseInit }`. Starting processes |
| `mountRoutes(api)` | Engine-specific REST routes (optional; `claude-code` provides `GET /claude-version`) |

To add a new engine, create `src/adapters/<engine>/index.js` and satisfy this interface.

### Adding New Features

#### Adding a new API endpoint

1. Add the route to `src/core/api.js` (for an engine-specific route, `adapters/<engine>/routes.js`).
2. **Add a section with a heading (`#### \`METHOD /path\``) to this document.**

#### Adding a new configuration option

1. Decide the default value in the code that reads it.
2. Add it to the table in [Configuration Details](#configuration-details) and to `config.example.json`.

### Debugging

- Server logs go to standard output and to `logs/server.log` (process events, excluding message events).
- To check Webhook delivery, set up a separate receiver and inspect the JSON that arrives.
- Investigate problems reading session files with the `[watcher]` log and `GET /sessions/:id/messages`.

---

## Security Considerations

### ⚠️ `dangerouslySkipPermissions` Flag

The `dangerouslySkipPermissions` flag bypasses the permission confirmation prompts shown when Claude Code uses tools. **This is extremely dangerous. Use it only in a controlled, trusted environment.**

#### How It Works

- **Default behavior**: `false` (safe)
  - Claude Code asks for permission confirmation before running tools such as `Write` and `Bash`
  - The user must approve each tool use manually
- **When enabled** (`true`):
  - Claude Code **runs all allowed tools without user confirmation**
  - No safety confirmation prompts appear for actions such as writing files or running commands
  - It runs fully automatically

#### Configuration Options

1. **Per-request setting** (recommended):

   ```json
   {
     "prompt": "Your prompt here",
     "projectPath": "/path/to/project",
     "dangerouslySkipPermissions": true
   }
   ```

2. **Global default** (use with great caution):

   ```json
   {
     "send": {
       "defaultDangerouslySkipPermissions": true
     }
   }
   ```

#### Security Risks

When `dangerouslySkipPermissions` is enabled:

- ⚠️ Claude Code can **write, modify, and delete any file** in the working directory
- ⚠️ Claude Code can **run any bash command**
- ⚠️ There is no human confirmation before destructive operations
- ⚠️ A malicious or mistaken prompt can cause data loss

#### Safe Usage Guidelines

**Enable it only if all of the following conditions are met.**

1. ✅ You are in a **sandboxed or isolated environment** (a Docker container, a VM, etc.)
2. ✅ The working directory has **no important data**
3. ✅ You **fully trust the prompts** you send
4. ✅ You have **backups** of important data
5. ✅ You are **actively monitoring** the session

**Safe usage examples:** Automated tests in a disposable Docker container, CI/CD pipelines in an isolated environment, version-controlled development environments.

**Dangerous usage examples:** ❌ Production servers, ❌ directories with sensitive data, ❌ shared development machines, ❌ environments without proper backups.

#### Recommended Alternative

For most uses, restrict tool use with `allowedTools` instead.

```json
{
  "prompt": "Analyze this code",
  "projectPath": "/path/to/project",
  "allowedTools": ["Read", "Grep"],
  "dangerouslySkipPermissions": false
}
```

With this, Claude Code can read files but cannot write or execute anything.

### ⚠️ Webhook (`subscribers`) Data Exposure

Each destination in `subscribers` receives the raw content of session messages (`event.message`). This can include the full text of executed commands (for example, calls to the `Bash` tool). Claude Code already stores the same content in its own session files (JSONL). coding-agent-pipe does not filter or mask anything before forwarding.

**Point `subscribers[].url` only at endpoints inside a trusted network (for example, the same Tailscale tailnet or the same Docker network).** If it points at a public external endpoint (a real Slack incoming webhook, a public server, and so on), the raw content of sessions leaves the trust boundary, including any secrets that happened to appear in commands.

### ⚠️ `apiToken` and Network Exposure

If `apiToken` is not set, the API can read session content and start agents (`POST /sessions/new`) without authentication. **Use it only inside a trusted network, and always set `apiToken` when exposing it.**

---

## License

MIT
