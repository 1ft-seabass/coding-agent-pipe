# coding-agent-pipe

A bidirectional pipe for coding agent CLIs (short name: `ca-pipe`).

[日本語版はこちら](./README-ja.md)

## Overview

**coding-agent-pipe** is a lightweight library that simply pipes a coding agent's behavior bidirectionally.

It watches the agent's JSONL session files, provides REST APIs for interaction, and distributes session events via webhooks. You can send prompts to the agent programmatically and receive events when responses are ready.

- One process = one engine (selected by `config.engine`). The engine available today is `claude-code`

## What This Does (and Doesn't Do)

### ✅ What it does
- Watches coding agent session files and provides REST API access
- Sends prompts to the agent programmatically
- Distributes session events via webhooks
- Lightweight implementation for personal workflow automation

### ❌ What it doesn't do
- Provide a UI (you bring your own frontend)
- Manage the agent's installation or updates
- Guarantee compatibility across all agent versions

### 🚫 What we won't do
- Enterprise features (complex auth, rate limiting, multi-tenancy)
- Database persistence (in-memory cache only)
- Maintain compatibility when the agent makes breaking changes

## Features

- **Watch Mode**: Monitor session files and extract structured data
- **Send Mode**: Send prompts to the agent via REST API (creates `claude -p` processes)
- **Cancel Mode**: Cancel running sessions programmatically
- **Webhook Distribution**: Send session events to external services (e.g., Node-RED, Slack)
- **MQTT Command Channel**: Drive sessions over MQTT as well (optional; receiving commands only)
- **Git Info API**: Get repository status and commit log for any project via REST API
- **File Upload API**: Upload files (images, text, PDF, Office docs, CSV) in base64 format for use in sessions
- **Project File Viewer API**: Get the content of a text or image file within a project (for viewer UIs), with path traversal / hidden file / `.gitignore` protection built in

## Platform Support

| Feature | Linux | macOS | WSL | Windows (native) |
|---------|-------|-------|-----|------------------|
| Webhook / Watch Mode | ✅ | ✅ | ✅ | ✅ |
| Send Mode / Cancel Mode | ✅ | ✅ | ✅ | ✅ |
| MQTT Command Channel | ✅ | ✅ | ✅ | ❌ (disabled) |

- Requires Node.js 20 or later.
- On Linux, macOS, and WSL, the agent is started through the `script` command (a PTY).
- Behavior is verified on Linux.

## Quick Start

### Step 1: Install and Start

Install dependencies:

```bash
npm install
```

Copy the example config and edit it:

```bash
cp config.example.json config.json
```

Edit `config.json` - at minimum, set your `watchDir`:

```json
{
  "watchDir": "~/.claude/projects",
  "port": 3100
}
```

Start the server:

```bash
npm start
```

You should see:

```
[index] Logging to: /path/to/coding-agent-pipe/logs/server.log
[subscribers] No subscribers configured
coding-agent-pipe v0.0.2 listening on port 3100
[watcher] Starting to watch: /home/user/.claude/projects
[watcher] Watching started
```

Check that it is running:

```bash
curl http://localhost:3100/health
```

### Step 2: Watch Mode (Read-Only)

Test the API by listing sessions:

```bash
curl http://localhost:3100/sessions
```

You'll get session metadata including message counts, timestamps, and the first and last messages:

```json
{
  "sessions": [
    {
      "id": "01234567-89ab-cdef-0123-456789abcdef",
      "createdAt": "2026-03-01T10:00:00.000Z",
      "lastModifiedAt": "2026-03-01T10:05:00.000Z",
      "messageCount": 12,
      "totalTokens": 15000,
      "projectPath": "/home/user/projects/my-app",
      "projectName": "my-app",
      "firstUserMessage": "What is the project structure?",
      "lastAssistantMessage": "You're welcome!"
    }
  ]
}
```

(The actual response contains more fields, such as `userMessageCount`.)

Get all messages from a session:

```bash
curl http://localhost:3100/sessions/SESSION_ID/messages
```

Get the latest assistant response:

```bash
curl http://localhost:3100/sessions/SESSION_ID/messages/assistant/latest
```

This is the safest way to start - you're only reading existing session data.

### Step 3: Send Mode (Optional)

Once you're comfortable, you can send prompts to the agent.

Create a new session (`projectPath` is required and must be an existing directory):

```bash
curl -X POST http://localhost:3100/sessions/new \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Hello", "projectPath": "/path/to/project"}'
```

Response (excerpt):

```json
{
  "message": "Session started",
  "sessionId": "01234567-89ab-cdef-0123-456789abcdef",
  "pid": 12345
}
```

Send to an existing session:

```bash
curl -X POST http://localhost:3100/sessions/SESSION_ID/send \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Follow-up message", "projectPath": "/path/to/project"}'
```

> **Note**: Send Mode starts the agent with your permissions. Restricting the tools with `allowedTools` is recommended. Use `dangerouslySkipPermissions` only in isolated environments. See [Security Considerations in DETAILS.md](./DETAILS.md#security-considerations) for details.

## Basic Configuration

### Minimal Setup

```json
{
  "watchDir": "~/.claude/projects",
  "port": 3100
}
```

### With Webhooks

```json
{
  "watchDir": "~/.claude/projects",
  "port": 3100,
  "subscribers": [
    {
      "url": "http://localhost:1880/webhook",
      "label": "node-red"
    }
  ]
}
```

### With API Token (Recommended for Production)

```json
{
  "watchDir": "~/.claude/projects",
  "port": 3100,
  "apiToken": "YOUR_TOKEN_HERE"
}
```

When `apiToken` is set, all API requests must include an `Authorization` header:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  http://localhost:3100/sessions
```

For more configuration options, see [DETAILS.md](./DETAILS.md).

## Common Use Cases

### Monitor Sessions

Watch for new responses and send notifications:

```json
{
  "watchDir": "~/.claude/projects",
  "port": 3100,
  "subscribers": [
    {
      "url": "https://hooks.slack.com/services/YOUR/WEBHOOK/URL",
      "label": "slack"
    }
  ]
}
```

> **Note**: Webhooks receive the raw content of session messages (including the commands that were run) as-is. Point them only at endpoints inside your trusted network. See [DETAILS.md](./DETAILS.md#-webhook-subscribers-data-exposure) for details.

### Automate Workflows

Create sessions programmatically and receive results via webhooks:

```json
{
  "watchDir": "~/.claude/projects",
  "port": 3100,
  "apiToken": "YOUR_TOKEN_HERE",
  "callbackUrl": "http://localhost:3100",
  "subscribers": [
    {
      "url": "http://localhost:1880/webhook",
      "label": "node-red"
    }
  ]
}
```

`callbackUrl` is included in the webhook payload, so the receiver can send messages back to that URL.

## Documentation

- **[DETAILS.md](./DETAILS.md)** - Complete API reference, configuration options, webhook formats, known behaviors, and troubleshooting
- **[DETAILS-ja.md](./DETAILS-ja.md)** - 日本語版の詳細ドキュメント
- **[CHANGELOG.md](./CHANGELOG.md)** - Release notes and version history

## Project Philosophy

This project is **intentionally minimal** and built to solve a specific personal need.

### Maintenance Policy

- **Primary focus**: Features that improve the author's daily workflow
- **Agent updates**: Breaking changes will be followed on a best-effort basis
- **Issues**: Feel free to open them, but timely responses are not guaranteed
- **Pull requests**: Contributions are appreciated! However, PRs that add significant complexity or diverge from the minimal philosophy may not be merged. Consider forking for major feature additions.

### Why This Approach?

This tool was born from a real need: "I want to interact with coding agent sessions programmatically, with minimal overhead."

Instead of building a full-featured platform, we keep it simple:
- Small codebase that's easy to understand and modify
- Just enough features to be useful
- If you need more features, you're encouraged to fork or extend it

**Note**: This is a personal tool made public. Use it as-is, fork it for your needs, or contribute improvements—but don't expect enterprise-level support.

## License

MIT.
