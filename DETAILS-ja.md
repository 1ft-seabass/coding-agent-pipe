# coding-agent-pipe - 詳細ドキュメント

coding-agent-pipe の完全なドキュメント

[English version](./DETAILS.md)

> **このドキュメントの根拠**: ルートごとの入出力は、実際のコード(`src/`)と、claude-code-pipe との挙動の比較テストで記録した実際の出力に基づいています。例のレスポンスの `<TMP>` や `<PID>` のような記号は、実行ごとに変わる値の置き換えです。

## 目次

- [概要](#概要)
- [設定詳細](#設定詳細)
- [API リファレンス](#api-リファレンス)
- [Webhook イベントフォーマット](#webhook-イベントフォーマット)
- [エラーと制限](#エラーと制限)
- [トラブルシューティング](#トラブルシューティング)
- [開発](#開発)
- [セキュリティに関する注意事項](#セキュリティに関する注意事項)

---

## 概要

coding-agent-pipe は、コーディングエージェントのセッションファイル(JSONL)を監視して、Webhook で配信し、REST API(と MQTT)で、セッションの読み取り・送信・キャンセルを行う、薄い橋渡しです。

- **1 プロセス = 1 エンジン**: 起動時に `config.engine` で、どのコーディングエージェントを扱うかを 1 つ選びます。今は `claude-code` と `codex` です(未指定、空文字は `claude-code`)。別のエンジンは、別のプロセスとして立てます。[Codex を使う](#codex-を使う)を参照。
- claude-code-pipe(0.9.x)の、API と Webhook の出力を引き継いでいます。claude-code-pipe に対して、次のものを**追加**しています。
  - Webhook と `GET /info` の `pipeApp`(どのアプリから来たか。常に `"coding-agent-pipe"`)と `engine`(どのエージェントか。例: `"claude-code"`)。claude-code-pipe はこの 2 つを送りません。受け手は、無ければ `pipeApp` を `claude-code-pipe`、`engine` を `claude-code` とみなせます。
- claude-code-pipe の文書に載っていなかったルート(`GET /health`、`GET /managed`)や、項目(`GET /processes` の `alive` など)も、ここに載せています(機能は claude-code-pipe にもありました)。
- 受け手(viewer など)に届く Webhook の契約は、[`schema/event.schema.json`](./schema/event.schema.json) が「正」です。

---

## 設定詳細

`config.example.json` を `config.json` にコピーして編集します(`config.json` は起動時に 1 回だけ読まれます。変更したら、再起動してください)。

### 完全な設定構造

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

### 設定フィールド

#### ルートレベル

| フィールド | 型 | 必須 | デフォルト | 説明 |
|-------|------|----------|---------|-------------|
| `engine` | string | No | `"claude-code"` | 扱うコーディングエージェント(`claude-code`、`codex`)。未指定・空文字は `claude-code`。未知の値は、起動時にエラー終了 |
| `watchDir` | string | Yes(`engine` が `codex` なら No) | - | セッションファイルの監視ディレクトリ(例: `~/.claude/projects`)。`codex` で省略すると `~/.codex/sessions`。`~` は展開される。**存在しない場合は、作らない**: 警告を 1 回出して、起動は続け、ディレクトリが現れたら監視を始める(5 秒おきに確認する) |
| `port` | number | No | `3100` | サーバーのポート番号 |
| `apiToken` | string | No | `""` | API 認証トークン。設定すると、全リクエストに `Authorization: Bearer TOKEN` ヘッダーが必要 |
| `projectTitle` | string | No | `null` | ユーザー定義のプロジェクトタイトル(Webhook ペイロードと `GET /info` に含まれる) |
| `callbackUrl` | string | No | `null` | このサーバーのコールバック URL(Webhook ペイロードに含まれる。受け手がコマンドを送り返す際に使う) |
| `subscribers` | array | No | `[]` | Webhook 購読者のリスト |
| `send` | object | No | `{}` | 送信まわりの設定 |
| `mqtt` | object | No | なし | MQTT コマンド受信。[MQTT コマンドチャネル](#mqtt-コマンドチャネル)を参照 |
| `upload` | object | No | 下記の既定値 | 添付ファイル。[`POST /attachments`](#post-attachments)を参照 |
| `viewer` | object | No | 下記の既定値 | プロジェクトのファイルの閲覧。[`POST /projects/file`](#post-projectsfile)を参照 |

#### Subscribers(購読者)

| フィールド | 型 | 必須 | デフォルト | 説明 |
|-------|------|----------|---------|-------------|
| `url` | string | Yes | - | Webhook エンドポイント URL |
| `label` | string | Yes | - | ログでの識別用ラベル |
| `authorization` | string | No | `""` | Authorization ヘッダーの値(例: `Bearer YOUR_TOKEN`) |

> **注意:** claude-code-pipe にあった `level` と `includeMessage` は、廃止済みで無視されます(書いてあっても害はありません)。全イベントと完全なメッセージ内容が、常に配信されます。受け手で、`type` や `isSubagent`・`isMeta` を使ってフィルタしてください。

#### Send 設定

| フィールド | 型 | 必須 | デフォルト | 説明 |
|-------|------|----------|---------|-------------|
| `defaultAllowedTools` | array | No | `[]` | **MQTT のコマンドで**使う、許可ツールの既定値。REST の送信 API(`POST /sessions/new`、`POST /sessions/:id/send`)は、これを使いません。リクエストの `allowedTools` を、そのまま渡します(省略すると、ツールの指定なし) |
| `cancelTimeoutMs` | number | No | `3000` | キャンセル操作で、SIGINT のあと SIGTERM に進むまでのミリ秒 |
| `defaultDangerouslySkipPermissions` | boolean | No | `false` | **⚠️ 危険:** 権限確認をスキップするデフォルト値。`true` にすると、REST の送信 API の全リクエストで、権限確認がスキップされます(リクエストで明示的に上書きしない限り)。詳細は[セキュリティに関する注意事項](#セキュリティに関する注意事項)を参照 |

#### upload と viewer の既定値

| フィールド | 既定値 |
|-------|---------|
| `upload.maxBodySize` | `"10mb"`(リクエストボディの上限。超えると 413) |
| `upload.allowedExtensions` | `.jpg` `.jpeg` `.png` `.pdf` `.txt` `.md` `.docx` `.xlsx` `.csv` |
| `upload.maxAgeDays` | `7`(これより古い添付を、起動時と 1 時間ごとに削除) |
| `viewer.maxFileSize` | `1048576`(1MB。テキストファイル) |
| `viewer.maxImageFileSize` | `5242880`(5MB。画像) |
| `viewer.imageExtensions` | `.jpg` `.jpeg` `.png` `.gif` `.bmp` `.webp` `.ico` `.svg` |
| `viewer.deniedExtensions` | バイナリ・危険な拡張子の一覧(`.pdf`、`.zip`、`.exe`、フォント、動画・音声、データベースなど。完全な一覧は `config.example.json`) |

### Webhook 配信

全イベントと完全なメッセージ内容が、購読者全員に常に配信されます。受け手で、`type`・`isSubagent`・`isMeta` を使って、必要に応じてフィルタしてください。

**イベントタイプ一覧:**

- `session-started`、`assistant-response-completed`、`process-exit`
- `session-error`、`session-timeout`、`cancel-initiated`
- `user-message-received`

### 設定例

#### 最小構成(Watch のみ)

```json
{
  "watchDir": "~/.claude/projects",
  "port": 3100
}
```

#### 単一 Webhook(Node-RED)

```json
{
  "watchDir": "~/.claude/projects",
  "port": 3100,
  "subscribers": [
    { "url": "http://localhost:1880/webhook", "label": "node-red" }
  ]
}
```

#### 複数 Webhook

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

#### API トークン付き(本番環境)

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

#### callbackUrl と projectTitle 付き(双方向通信)

Webhook を受信する側が、coding-agent-pipe に送信 API でメッセージを送り返す場合に有用です。

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

- `callbackUrl` は、Webhook ペイロードに含まれます。受け手が、この URL を使って、Send API にメッセージを送れます(例: Node-RED から `{{callbackUrl}}/sessions/{{sessionId}}/send`)。
- `projectTitle` は、Webhook ペイロードに含まれます。プロジェクトを、人間が識別しやすい名前で管理できます。

> **ポートについて**: claude-code-pipe を同じマシンで動かしている場合は、ポートを分けてください(claude-code-pipe の既定は 3100)。

### Codex を使う

`engine` を `codex` にすると、Claude Code の代わりに、OpenAI の Codex CLI を扱います。API と Webhook の形は、`claude-code` と同じです。

**前提**: `codex` コマンドが `PATH` にあり、ログイン済みであること(ChatGPT のアカウント、または API キー)。ログインは、このサーバーの外(`codex login`)で行います。

**設定例**(`watchDir` は省略できます。省略すると `~/.codex/sessions` を見ます):

```json
{
  "engine": "codex",
  "port": 3101,
  "projectTitle": "my-project",
  "callbackUrl": "http://localhost:3101",
  "subscribers": [
    { "url": "http://localhost:1880/webhook", "label": "node-red" }
  ]
}
```

**仕組み**:
- 観測: `~/.codex/sessions/YYYY/MM/DD/rollout-<日時>-<UUID>.jsonl` を追いかけます。`sessionId` は、ファイル名の UUID です。プロジェクト(`projectPath`)は、ファイルの 1 行目に書かれた作業ディレクトリから割り出します。
- 起動: `codex exec --json --skip-git-repo-check -- <プロンプト>` を起動します(既存のセッションへの送信は `codex exec resume`)。作業ディレクトリは `projectPath` です。

**`claude-code` との違い**:

| 項目 | `codex` の場合 |
|---|---|
| `allowedTools`・`disallowedTools` | 受け付けますが、効きません(対応するフラグがありません) |
| `dangerouslySkipPermissions` | `true` のとき、`--dangerously-bypass-approvals-and-sandbox` を付けます(承認とサンドボックスの**両方**を無効にします)。`false`・未指定のときは、Codex の既定(サンドボックスは読み取り専用、承認は求めない)です。環境によっては、サンドボックスが動かず(例: ユーザー名前空間を許さないコンテナ)、コマンドが失敗します。[セキュリティに関する注意事項](#セキュリティに関する注意事項)を参照 |
| `POST /sessions/new`・`POST /sessions/:id/send` のレスポンス | `claudeCodeVersion` は返しません。`codingAgentVersion`・`model`・`cwd`・`permissionMode`・`apiKeySource` は `null`、`tools` は空です(Codex の最初の出力に、これらが載らないため) |
| `GET /claude-version` | 登録されません |
| ツール呼び出し | Codex のツール名(`exec` など)で出ます。1 回の呼び出しに、複数のコマンドが入ることがあります |
| トークン数 | `GET /sessions` の `totalTokens` などは、Codex の記録(`token_usage_record`)から計算します。`input_tokens` は、キャッシュから読んだ分(`cache_read_input_tokens`)を除いた値で、Claude に揃えています。Webhook には載りません |
| サブエージェント | Codex が起動したサブエージェントは、別のセッションとして出ます。Webhook の `isSubagent` が `true` になり、`GET /sessions` と `GET /projects` の既定では除外されます(`excludeAgents=false` で含めます) |
| `cancel` | SIGINT で止まります(確認した範囲では、数百ミリ秒。終了コードは `1`)。中断したセッションは、続けて再開できます |
| MQTT・Windows | 動作を確かめていません |

> `claude-code` と `codex` は、別のプロセスとして立てます(1 プロセス = 1 エンジン)。同じマシンで両方を動かすときは、ポートを分けてください。

---

## API リファレンス

### 認証

`config.json` で `apiToken` が設定されている場合、全ての API リクエストに `Authorization` ヘッダーが必要です。

```bash
curl -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  http://localhost:3100/sessions
```

`apiToken` が未設定または空の場合、認証は無効です(本番環境では非推奨)。トークンがない・違う場合は `401` で、本文は次のとおりです。

```json
{ "error": "Unauthorized: Missing or invalid authorization header" }
```

```json
{ "error": "Unauthorized: Invalid token" }
```

`Authorization` は `Bearer ` で始まる必要があります(`Bearer` と値は 1 つの空白で区切る。小文字の `bearer` は受け付けません)。認証が有効なとき、**存在しないルートも、トークンがなければ `401`** です(トークンがあれば `404`)。

### 共通のクエリ

- `projectPath`(多くの読み取り系): 同じセッション ID が複数のプロジェクトにある場合の絞り込み。
- 値の `true` / `false` は、文字列として比較します(`?excludeEmpty=false`)。

### Info(情報)

#### `GET /health`

ヘルスチェックです。起動しているか、バージョン、起動からの秒数を返します。**認証が有効なときは、このルートにもトークンが必要です。**

**リクエスト:**

```bash
curl http://localhost:3100/health
```

**レスポンス:**

```json
{
  "status": "ok",
  "version": "0.2.0",
  "uptime": 123.456
}
```

| フィールド | 型 | 説明 |
|-------|------|-------------|
| `status` | string | 常に `"ok"` |
| `version` | string | 現在のバージョン(`package.json` より) |
| `uptime` | number | プロセスの起動からの秒数 |

`HEAD /health` も `200` を返します(本文なし)。末尾のスラッシュ(`/health/`)は区別しません。

#### `GET /version`

パッケージの情報を取得します。

**リクエスト:**

```bash
curl http://localhost:3100/version
```

**レスポンス:**

```json
{
  "name": "coding-agent-pipe",
  "version": "0.2.0",
  "description": "A pipe for coding agent CLI input/output using JSONL and Hono"
}
```

| フィールド | 型 | 説明 |
|-------|------|-------------|
| `name` | string | パッケージ名 |
| `version` | string | 現在のバージョン |
| `description` | string | パッケージの説明 |

#### `GET /info`

この pipe の、現在の設定状態を取得します。初回接続時の viewer 側の把握・デバッグ用です。継続的なステータス把握には、このエンドポイントをポーリングするのではなく、全 Webhook ペイロードに含まれる `communicationMode` を使う方が適しています。

**リクエスト:**

```bash
curl http://localhost:3100/info
```

**レスポンス:**

```json
{
  "version": "0.2.0",
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

| フィールド | 型 | 説明 |
|-------|------|-------------|
| `version` | string | 現在のバージョン |
| `os` | string | `"linux"`、`"mac"`、`"windows"` のいずれか(WSL は `"linux"`) |
| `communicationMode` | string | `"watch-only"`(subscriber なし)、`"webhook-only"`(subscriber はあるが `callbackUrl` も `mqtt.commandTopic` もない)、`"bidirectional"`(subscriber があり、`callbackUrl` または `mqtt.commandTopic` もある) |
| `backendType` | string | 旧来の互換項目(`claude_code`。`codex` のときは `codex`)。どのエージェントかは `engine` を見る |
| `pipeApp` | string | 常に `"coding-agent-pipe"`(claude-code-pipe は送らない) |
| `engine` | string | どのコーディングエージェントか(`"claude-code"`、`"codex"`。claude-code-pipe は送らない) |
| `callbackUrl` | string\|null | `config.callbackUrl`。未設定は `null` |
| `mqttCommandTopic` | string\|null | `config.mqtt.commandTopic`。MQTT 未設定は `null`。broker の URL・認証情報は含まれない |
| `subscriberCount` | number | 設定済み `subscribers` の件数 |
| `projectTitle` | string\|null | `config.projectTitle`。未設定は `null` |
| `watchDir` | string | `config.watchDir` |

#### `GET /claude-version`

**エンジン固有のルート**(`claude-code` のときだけ登録されます)。Claude Code CLI のバージョンを取得します。

**リクエスト:**

```bash
curl http://localhost:3100/claude-version
```

**レスポンス:**

```json
{
  "version": "2.1.289",
  "raw": "2.1.289 (Claude Code)"
}
```

| フィールド | 型 | 説明 |
|-------|------|-------------|
| `version` | string | パースしたバージョン番号 |
| `raw` | string | `claude -v` の出力(前後の空白を除いたもの) |

**エラー(`500`):** `claude -v` が失敗したときは `{ "error": "Failed to get claude version", "details": "..." }`、`claude` を実行できないときは `{ "error": "Failed to execute claude command", "details": "..." }`。

### Watch(読み取り)

セッションファイルを読み取る API です。どれも `GET` で、認証が有効なら `Authorization` が必要です。

#### `GET /projects`

プロジェクトごとのセッションの一覧を返します。セッション数の多い順に並びます。

**クエリパラメータ:**

| パラメータ | 既定 | 説明 |
|-------|------|-------------|
| `excludeAgents` | `true` | `agent-*` のセッション(サブエージェント)を除く。`false` で含める |
| `excludeEmpty` | `true` | メッセージが 0 件のセッションを除く。`false` で含める |

**リクエスト:**

```bash
curl http://localhost:3100/projects
```

**レスポンス:**

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

`mtime` は、セッションファイルの更新時刻(ミリ秒のエポック)です。

#### `GET /sessions`

セッションの一覧を、メタデータつきで返します。

**クエリパラメータ:**

| パラメータ | 既定 | 説明 |
|-------|------|-------------|
| `detail` | `false` | `true` で、最初と最後のメッセージを、オブジェクト(`content`・`timestamp`・`usage`)で返す |
| `excludeAgents` | `true` | `agent-*` のセッションを除く |
| `excludeEmpty` | `true` | メッセージが 0 件のセッションを除く |

**リクエスト:**

```bash
curl http://localhost:3100/sessions
curl "http://localhost:3100/sessions?detail=true&excludeEmpty=false"
```

**レスポンス(既定):**

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
      "firstUserMessage": "最初の質問です",
      "lastUserMessage": "追記の質問",
      "firstAssistantMessage": "最初の回答です",
      "lastAssistantMessage": "追記の回答"
    }
  ]
}
```

- `firstUserMessage` などは、`text` ブロックを連結した文字列です。該当するメッセージがなければ `null`。
- `totalTokens` は、アシスタントの `input_tokens` と `output_tokens` の合計です。
- `detail=true` のとき、`firstUserMessage` などは `{ "content": "...", "timestamp": "..." }`(アシスタントは `usage` も)のオブジェクトになります。

#### `GET /sessions/:id/signals`

メッセージ本文を含まない、「シグナル」の配列を返します(種別・時刻・所要時間・本文のバイト数)。サブエージェントは別ファイル・別のセッション ID なので、含まれません。

**クエリパラメータ:** `projectPath`(任意。同じ ID が複数のプロジェクトにあるとき)

**リクエスト:**

```bash
curl http://localhost:3100/sessions/SESSION_ID/signals
```

**レスポンス:**

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

| `type` | 説明 |
|-------|-------------|
| `user` | ユーザーのメッセージ(`start` と `end` は同じ。`durationMs` は 0)。`tool_result` だけの行は含まれない |
| `assistant` | アシスタントの本文(`textBytes` は `text` ブロックの UTF-8 バイト数。`thinking`・`tool_use` は含まない) |
| `tool-use` | `tool_use` と、対応する `tool_result` の時刻の差(`tool_use_id` で対応づける)。`end` と `durationMs` は、結果が来るまで `null` |

`isMeta` の行は除かれます。

#### `GET /sessions/:id/messages`

セッションの全メッセージを返します。

**クエリパラメータ:**

| パラメータ | 説明 |
|-------|-------------|
| `projectPath` | 同じ ID が複数のプロジェクトにあるときの絞り込み |
| `textOnly` | `true` で、`tool_use`・`tool_result`・`isMeta` を除いた、本文だけのターン(`role`・`timestamp`・`text`)にする。本文が空になるターンは除かれる |
| `limit` | 正の整数で、(整形後の)末尾 N 件に絞る |

**リクエスト:**

```bash
curl http://localhost:3100/sessions/SESSION_ID/messages
curl "http://localhost:3100/sessions/SESSION_ID/messages?textOnly=true&limit=30"
```

**レスポンス(既定。JSONL の行そのもの):**

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
      "message": { "role": "user", "content": "最初の質問です" }
    }
  ]
}
```

**レスポンス(`textOnly=true`):**

```json
{
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "events": [
    { "role": "user", "timestamp": "2026-09-01T00:00:00.000Z", "text": "最初の質問です" },
    { "role": "assistant", "timestamp": "2026-09-01T00:00:01.000Z", "text": "最初の回答です" }
  ]
}
```

**エラー:** セッションが見つからないとき `404` `{ "error": "Session not found" }`。

#### 最初・最後のメッセージ(8 本)

次の 8 つは、条件に合うメッセージを 1 件だけ返します。どれも `projectPath` を受け付けます。

| ルート | 返すもの |
|-------|-------------|
| `GET /sessions/:id/messages/user/first` | 最初の `user` のメッセージ |
| `GET /sessions/:id/messages/user/latest` | 最後の `user` のメッセージ |
| `GET /sessions/:id/messages/assistant/first` | 最初の `assistant` のメッセージ |
| `GET /sessions/:id/messages/assistant/latest` | 最後の `assistant` のメッセージ |
| `GET /sessions/:id/messages/chat/user/first` | 最初のユーザーの**チャット**メッセージ |
| `GET /sessions/:id/messages/chat/user/latest` | 最後のユーザーの**チャット**メッセージ |
| `GET /sessions/:id/messages/chat/assistant/first` | 最初のアシスタントの**チャット**メッセージ |
| `GET /sessions/:id/messages/chat/assistant/latest` | 最後のアシスタントの**チャット**メッセージ |

**「チャット」メッセージ**とは、ツール操作を除いた、純粋な会話のメッセージです。
- ユーザー: `content` が文字列、または、`tool_result` を含まない配列。
- アシスタント: `content` が配列で、`text` ブロックがあり、`tool_use` ブロックがないもの。

**リクエスト:**

```bash
curl http://localhost:3100/sessions/SESSION_ID/messages/assistant/latest
```

**レスポンス:**

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
      "content": [{ "type": "text", "text": "追記の回答" }],
      "usage": { "input_tokens": 30, "output_tokens": 7, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0 }
    }
  }
}
```

**エラー(`404`):**

| 状況 | 本文 |
|-------|-------------|
| セッションが見つからない | `{ "error": "Session not found" }` |
| 該当するメッセージがない | `{ "error": "No user messages found" }`(`assistant` は `No assistant messages found`、チャットは `No user chat messages found` / `No assistant chat messages found`) |

### Send Mode(送信)

#### `POST /sessions/new`

新しいセッションを開始します(エージェントの CLI を、子プロセスとして起動します)。起動を確認できてから、応答を返します。

**リクエストボディ:**

| フィールド | 型 | 必須 | 説明 |
|-------|------|----------|-------------|
| `prompt` | string | Yes | 送信するプロンプト |
| `projectPath` | string | Yes(または `cwd`) | セッションの作業ディレクトリ(存在するディレクトリ) |
| `cwd` | string | - | `projectPath` の別名(後方互換)。両方あれば `projectPath` が優先 |
| `allowedTools` | array | No | 許可するツール。省略すると、ツールの指定なし(`send.defaultAllowedTools` は使われない) |
| `disallowedTools` | array | No | 禁止するツール |
| `model` | string | No | 使用するモデル |
| `dangerouslySkipPermissions` | boolean | No | 権限確認をスキップする。省略すると `send.defaultDangerouslySkipPermissions`。**⚠️ 危険です**。[セキュリティに関する注意事項](#セキュリティに関する注意事項)を参照 |

**リクエスト:**

```bash
curl -X POST http://localhost:3100/sessions/new \
  -H "Content-Type: application/json" \
  -d '{"prompt": "README を要約して", "projectPath": "/home/user/projects/my-app", "allowedTools": ["Read", "Grep"]}'
```

**レスポンス(`200`):**

```json
{
  "message": "Session started",
  "sessionId": "55555555-5555-4555-8555-555555555555",
  "pid": 12345,
  "model": "claude-opus-5-5",
  "cwd": "/home/user/projects/my-app",
  "permissionMode": "default",
  "claudeCodeVersion": "2.1.289",
  "codingAgentVersion": "2.1.289",
  "apiKeySource": "none",
  "tools": ["Read", "Grep", "Bash"]
}
```

`codingAgentVersion` は、エンジンに依らない名前のバージョンです(`claude-code` では `claudeCodeVersion` と同じ値、`codex` では `null`)。`claudeCodeVersion` は `claude-code` のときだけ返ります。

起動と同時に、Webhook の `session-started` が配信されます(のちに `user-message-received`、`assistant-response-completed`、終了時に `process-exit`)。

**エラー:**

| ステータス | 本文 | 状況 |
|-------|-------------|-------------|
| `400` | `{ "error": "prompt is required" }` | `prompt` がない・空 |
| `400` | `{ "error": "projectPath is required", "message": "..." }` | `projectPath`(と `cwd`)がない |
| `400` | `{ "error": "projectPath does not exist", "message": "..." }` | そのディレクトリが存在しない |
| `500` | `{ "error": "Failed to start new session" }` | 起動に失敗した(理由は、ログにだけ出る。下の注意を参照) |

> **注意: `500` の理由は返りません。** 次のような場合に起きます(いずれも、claude-code-pipe から引き継いだ既知の挙動です。[エラーと制限](#エラーと制限)を参照)。
> - エージェントの起動時の出力(`system/init`)が、約 4KB を超えると、起動を検知できないことがある
> - プロンプトが長すぎる(約 128KB。`\` `"` `` ` `` `$` が多いと約 64KB)
> - `script` コマンドがない、エージェントが起動しない、起動のタイムアウト(60 秒)

#### `POST /sessions/:id/send`

既存のセッションに、メッセージを送ります(エージェントの `--resume` で、新しいプロセスを起動します)。

**リクエストボディ:** `POST /sessions/new` と同じです(`prompt` と `projectPath`(または `cwd`)が必須)。

**リクエスト:**

```bash
curl -X POST http://localhost:3100/sessions/SESSION_ID/send \
  -H "Content-Type: application/json" \
  -d '{"prompt": "続けて", "projectPath": "/home/user/projects/my-app"}'
```

**レスポンス(`200`):**

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
  "codingAgentVersion": "2.1.289",
  "apiKeySource": "none"
}
```

**エラー:** `400`(`prompt is required` / `projectPath is required` / `projectPath does not exist`。`POST /sessions/new` と同じ)、`404` `{ "error": "Session not found" }`(そのセッションが見つからない)、`500` `{ "error": "Failed to send message" }`。

> **同じセッションに、続けて 2 回送ると**、最初のプロセスが管理から外れて、`DELETE /processes` や `cancel` で止められなくなります(既知の挙動。[エラーと制限](#エラーと制限)を参照)。

### MQTT コマンドチャネル

REST の送信 API の代わりに、MQTT で、セッションを動かせます。イベント配信(pipe → 受け手)は、常に HTTP の Webhook で、MQTT は、コマンドの受信(受け手 → pipe)専用です。`config.mqtt` で、独立して設定します。

**設定:**

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

| フィールド | 型 | 必須 | 説明 |
|-------|------|----------|-------------|
| `url` | string | Yes | broker の URL。`mqtt://`(平文)または `mqtts://`(TLS) |
| `username` | string | No | broker が認証を要求する場合のユーザー名 |
| `password` | string | No | broker が認証を要求する場合のパスワード |
| `commandTopic` | string | Yes | この pipe が、コマンドを受けるために購読するトピック |

`config.mqtt` を省略する(または `url` か `commandTopic` がない)と、MQTT チャネルは無効です(接続を試みません)。

**コマンドペイロード**(受け手が `commandTopic` に publish する JSON):

```json
{
  "prompt": "Your prompt here",
  "projectPath": "/path/to/project",
  "sessionId": "11111111-1111-4111-8111-111111111111",
  "model": "sonnet"
}
```

| フィールド | 型 | 必須 | 説明 |
|-------|------|----------|-------------|
| `prompt` | string | Yes | 送信するプロンプト |
| `projectPath` | string | No | **新規**セッションの作業ディレクトリ。`sessionId` がある場合は無視される。**省略すると、サーバーの起動ディレクトリで動く**(REST の `projectPath` 必須とは違う) |
| `sessionId` | string | No | 指定すると、既存セッションに送る(`--resume`)。省略すると、新規セッション |
| `model` | string | No | 使用するモデル |

- 許可ツールは、`config.send.defaultAllowedTools` を使います(REST の送信 API は、これを使いません)。
- QoS は 0(送りっぱなし)で、publish した側への確認はありません。broker との接続が切れている間に publish されたコマンドは、黙って失われます。
- **壊れたコマンドは、黙って捨てられます**: `prompt` がない・空、JSON でないものは、何も起動せず、Webhook も出ません。エラーは、サーバーのログにだけ出ます(`[mqtt] Command missing required field: prompt`、`[mqtt] Invalid JSON payload: ...`)。
- broker が落ちても、サーバーは動き続けます(`/health` は返る)。broker が戻ると、再接続して、購読し直します。起動時に broker がいなくても、起動して、あとから接続します。認証が通らない場合も、サーバーは動き続けます(ログに `Connection error: Connection refused: Bad username or password`)。
- `mqtt.password` は、一切露出しません。Webhook ペイロードの `mqttCommandTopic` と `GET /info` に含まれるのは `commandTopic` だけです。

**プラットフォームに関する注意:** Windows ネイティブでは、MQTT コマンドチャネルは無効です。Windows ネイティブで `config.mqtt` が設定されていると、起動時に警告を出して、接続しません(REST の送信 API は、Windows ネイティブでも、エージェントを直接起動して動きます)。

### Cancel Mode(キャンセル)

#### `POST /sessions/:id/cancel`

この pipe が起動して、管理しているプロセスを、キャンセルします。まず SIGINT を送ります。

**リクエスト:**

```bash
curl -X POST http://localhost:3100/sessions/SESSION_ID/cancel
```

**レスポンス(`200`):**

```json
{
  "cancelled": true,
  "pid": 12345,
  "sessionId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
}
```

Webhook の `cancel-initiated` が配信され、プロセスが終わると `process-exit` が配信されます。

**エラー(`404`):** `{ "error": "Session not found or not managed" }`(この pipe が管理していないセッション、または、すでに終わったセッション)。

> **注意:** `cancel` は、まず SIGINT を送ります。`send.cancelTimeoutMs` が過ぎても終わらないときは、SIGTERM に進みます(この段階は、0.1.0 より前は動いていませんでした。[CHANGELOG](./CHANGELOG-ja.md) を参照)。すぐに止めたいときは、[`DELETE /processes/:sessionId`](#delete-processessessionid) を使ってください。

### Management(管理)

この pipe が起動した(`POST /sessions/new`、`POST /sessions/:id/send`、MQTT のコマンド)プロセスだけが、管理の対象です。ターミナルなどで直接動かしているセッションは、含まれません。

#### `GET /processes`

管理中のプロセスの一覧を返します。

**リクエスト:**

```bash
curl http://localhost:3100/processes
```

**レスポンス:**

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

| フィールド | 型 | 説明 |
|-------|------|-------------|
| `sessionId` | string | セッション ID |
| `pid` | number | プロセス ID |
| `startedAt` | string | 起動した時刻(ISO 8601) |
| `alive` | boolean | プロセスが生きているか |

管理中のプロセスがなければ、`{ "processes": [] }` です。

#### `GET /managed`

管理中のプロセスの一覧を返します。`GET /processes` と同じ項目ですが、**`processes` で包まず、配列をそのまま返します**。

**リクエスト:**

```bash
curl http://localhost:3100/managed
```

**レスポンス:**

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

管理中のプロセスがなければ `[]` です。

#### `DELETE /processes/:sessionId`

指定したセッションの、管理中のプロセスを終了します。

**リクエスト:**

```bash
curl -X DELETE http://localhost:3100/processes/SESSION_ID
```

**レスポンス(`200`):**

```json
{
  "message": "Process terminated",
  "killed": true,
  "pid": 12345,
  "sessionId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
}
```

プロセスが実際に終わるまでには、1〜4 秒ほどかかることがあります。

**エラー(`404`):** `{ "error": "Process not found", "sessionId": "..." }`。

#### `DELETE /processes`

管理中の全プロセスを終了します(緊急用)。

**リクエスト:**

```bash
curl -X DELETE http://localhost:3100/processes
```

**レスポンス(`200`):**

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

管理中のプロセスがなければ、`killed` は `0`、`sessions` は `[]` です。

### Files(ファイル)

#### `GET /attachments-config`

添付ファイルの設定(上限と許可する拡張子)を返します。

**リクエスト:**

```bash
curl http://localhost:3100/attachments-config
```

**レスポンス:**

```json
{
  "maxBodySize": "10mb",
  "allowedExtensions": [".jpg", ".jpeg", ".png", ".pdf", ".txt", ".md", ".docx", ".xlsx", ".csv"]
}
```

#### `POST /attachments`

base64 のファイル(画像・テキスト・PDF など)を、サーバーの `/tmp/coding-agent-pipe/` に保存します。保存したパスを、あとのプロンプトに入れて、エージェントに読ませる使い方を想定しています。

**リクエストボディ:**

| フィールド | 型 | 必須 | 説明 |
|-------|------|----------|-------------|
| `data` | string | Yes | base64 のファイルの内容 |
| `filename` | string | Yes | 元のファイル名(拡張子が `allowedExtensions` に含まれること) |

**リクエスト:**

```bash
curl -X POST http://localhost:3100/attachments \
  -H "Content-Type: application/json" \
  -d '{"data": "iVBORw0KGgo...", "filename": "screenshot.png"}'
```

**レスポンス(`200`):**

```json
{
  "path": "/tmp/coding-agent-pipe/550e8400-e29b-41d4-a716-446655440000-screenshot.png",
  "filename": "550e8400-e29b-41d4-a716-446655440000-screenshot.png"
}
```

- 保存名は `<UUID>-<元のファイル名>` で、ファイル名の `a-zA-Z0-9._-` 以外の文字は `_` に置き換わります。
- 保存先は、`/tmp/claude-code-pipe/` とは別です。同じマシンで両方を動かしても、ぶつかりません。
- `config.upload.maxAgeDays`(既定 7 日)より古いファイルは、起動時と 1 時間ごとに削除されます。

**エラー:** `400` `{ "error": "data and filename are required" }`、`400` `{ "error": "File type not allowed. Allowed: ..." }`、`413`(ボディが `maxBodySize` を超えた。[エラーと制限](#エラーと制限))、`500` `{ "error": "Failed to save file" }`。

#### `POST /projects/file`

プロジェクトのディレクトリの中のファイルの内容を返します(viewer 向け)。安全のため、次の制限があります。

- `filePath` は、`projectPath` の中を指す相対パスで、シンボリックリンクを解決したあとも、中に収まること
- `.` で始まるファイル・ディレクトリ(`.env`、`.git`、`.ssh` など)は、常に拒否
- `.gitignore` の対象は拒否(git リポジトリで判定できる場合だけ)
- `viewer.deniedExtensions` の拡張子は拒否(画像は除く)
- 通常のファイルであること。大きさの上限は、テキスト 1MB、画像 5MB(`viewer.maxFileSize`、`viewer.maxImageFileSize`)

**リクエストボディ:**

| フィールド | 型 | 必須 | 説明 |
|-------|------|----------|-------------|
| `projectPath` | string | Yes | プロジェクトのディレクトリ(存在するもの) |
| `filePath` | string | Yes | `projectPath` からの相対パス |

**リクエスト:**

```bash
curl -X POST http://localhost:3100/projects/file \
  -H "Content-Type: application/json" \
  -d '{"projectPath": "/home/user/projects/my-app", "filePath": "src/index.js"}'
```

**レスポンス(テキスト、`200`):**

```json
{
  "content": "console.log('hello');\n",
  "mtime": "2026-09-01T00:00:00.000Z",
  "size": 22,
  "encoding": "utf8"
}
```

**レスポンス(画像、`200`):** `encoding` は `"base64"` で、`mimeType` が付きます。

```json
{
  "content": "iVBORw0KGgoBAgME",
  "mtime": "2026-09-01T00:00:00.000Z",
  "size": 12,
  "encoding": "base64",
  "mimeType": "image/png"
}
```

**エラー:**

| ステータス | 本文(`error`) | 状況 |
|-------|-------------|-------------|
| `400` | `projectPath and filePath are required` | どちらかがない |
| `400` | `projectPath does not exist` | プロジェクトのディレクトリがない |
| `400` | `filePath must resolve within projectPath` | プロジェクトの外を指している(`..` やシンボリックリンク) |
| `400` | `Hidden files/directories are not viewable via this API. Use code-server instead.` | `.` で始まるもの |
| `400` | `File type not viewable via this API: <拡張子>. Use code-server instead.` | `deniedExtensions` |
| `400` | `File is git-ignored and not viewable via this API. Use code-server instead.` | `.gitignore` の対象 |
| `400` | `filePath must point to a regular file` | ディレクトリなど |
| `404` | `File not found` | ファイルがない |
| `413` | `File too large. Max size: <バイト数> bytes` | 大きさの上限を超えた |
| `500` | `Failed to read file` | 読み取りに失敗 |

### Git

#### `GET /git/status`

プロジェクトの git の状態を返します。

**クエリパラメータ:**

| パラメータ | 必須 | 説明 |
|-------|----------|-------------|
| `projectPath` | Yes | プロジェクトのディレクトリ |
| `files` | No | `true` で、ファイルの一覧つき。既定は、件数だけ |

**リクエスト:**

```bash
curl "http://localhost:3100/git/status?projectPath=/home/user/projects/my-app"
curl "http://localhost:3100/git/status?projectPath=/home/user/projects/my-app&files=true"
```

**レスポンス(既定):**

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

**レスポンス(`files=true`):** `stagedCount` などの代わりに、`staged`・`unstaged`・`untracked`(ファイルの配列)が付きます。

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

**エラー:** `400` `{ "error": "projectPath is required" }`、`404` `{ "error": "Not a git repository" }`。

#### `GET /git/log`

プロジェクトの git のログを返します(未プッシュのコミットを示します)。

**クエリパラメータ:**

| パラメータ | 必須 | 説明 |
|-------|----------|-------------|
| `projectPath` | Yes | プロジェクトのディレクトリ |
| `limit` | No | 件数。既定 `20`、最大 `100` |

**リクエスト:**

```bash
curl "http://localhost:3100/git/log?projectPath=/home/user/projects/my-app&limit=10"
```

**レスポンス:**

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

**エラー:** `400` `{ "error": "projectPath is required" }`、`404` `{ "error": "Not a git repository" }`。

---

## Webhook イベントフォーマット

Webhook は、次の構造の JSON を、`POST`(`Content-Type: application/json`)で受け取ります。契約は、[`schema/event.schema.json`](./schema/event.schema.json) が「正」です。`subscribers[].authorization` を設定すると、`Authorization` ヘッダーに、その値が付きます。

### イベント構造

#### すべてのイベントに共通する項目

| フィールド | 型 | 説明 |
|-------|------|-------------|
| `type` | string | イベントタイプ([イベントタイプ](#イベントタイプ)を参照) |
| `version` | string | 送り元アプリのバージョン |
| `sessionId` | string | セッション ID |
| `timestamp` | string | ISO 8601。メッセージ系は JSONL の時刻、プロセス系は pipe の実行時刻 |
| `cwdPath` | string | この pipe を起動したディレクトリのフルパス |
| `cwdName` | string | 同じディレクトリのベース名 |
| `callbackUrl` | string\|null | `config.callbackUrl`(未設定は `null`)。受け手が、この pipe に戻るときの URL |
| `os` | string | `"mac"`、`"linux"`、`"windows"`(WSL は `"linux"`) |
| `communicationMode` | string | `"watch-only"`、`"webhook-only"`、`"bidirectional"`([`GET /info`](#get-info)を参照) |
| `backendType` | string | 旧来の互換項目(`claude_code`。`codex` のときは `codex`) |
| `pipeApp` | string | 常に `"coding-agent-pipe"`。claude-code-pipe は送らない(無ければ `claude-code-pipe` とみなせる) |
| `engine` | string | どのコーディングエージェントか(`"claude-code"`、`"codex"`)。claude-code-pipe は送らない(無ければ `claude-code` とみなせる) |
| `mqttCommandTopic` | string | `config.mqtt.commandTopic`(設定した場合のみ) |
| `projectPath`・`projectName` | string | セッションのプロジェクトのパスと名前(セッションファイルの場所から割り出す。サブエージェントは、そのセッションが属するプロジェクト) |
| `projectTitle` | string | `config.projectTitle`(設定した場合のみ) |

#### メッセージ系(`user-message-received`、`assistant-response-completed`)

| フィールド | 型 | 説明 |
|-------|------|-------------|
| `source` | string | `"api"`(この pipe が起動したプロセスのセッション)または `"cli"`(直接操作) |
| `isSubagent` | boolean | サブエージェントのセッション(`subagents/` 配下のファイル)由来なら `true` |
| `isMeta` | boolean | エージェントのハーネスが自動で入れたメッセージ(例: "Continue from where you left off.")なら `true` |
| `git` | object\|null | プロジェクトの git の情報(`branch`、`commit`、`isWorktree`、`mainWorktreePath`)。git リポジトリでなければ `null` |
| `message` | object | JSONL のメッセージ(`role`、`content`、`usage`)。**常に含まれる** |

`assistant-response-completed` には、さらに次の項目があります。

| フィールド | 型 | 説明 |
|-------|------|-------------|
| `tools` | array | この応答で使ったツール名 |
| `responseTime` | number\|null | 直前のメッセージからの経過秒 |

#### プロセス系(`session-started`、`session-error`、`session-timeout`、`cancel-initiated`、`process-exit`)

| フィールド | 型 | 説明 |
|-------|------|-------------|
| `pid` | number | プロセス ID |
| `model` | string\|null | `session-started` のモデル |
| `resumed` | boolean | `session-started` で、既存セッションの再開なら `true` |
| `code`・`signal` | number\|null・string\|null | `process-exit` の終了コードと、終了シグナル |
| `error` | string | `session-error`・`session-timeout` の理由 |

### イベントタイプ

| タイプ | 説明 | 出どころ |
|------|-------------|--------|
| `session-started` | 新しいセッションが作られた、または、再開された | この pipe が起動したプロセス |
| `user-message-received` | セッションファイルに、ユーザーのメッセージが追記された | セッションファイルの監視 |
| `assistant-response-completed` | アシスタントの応答が追記された | セッションファイルの監視 |
| `process-exit` | この pipe が起動したプロセスが終了した | この pipe が起動したプロセス |
| `session-error` | プロセスの起動に失敗した | この pipe が起動したプロセス |
| `session-timeout` | 起動を確認できないまま、タイムアウト(60 秒)した | この pipe が起動したプロセス |
| `cancel-initiated` | キャンセルが要求された | キャンセル |

メッセージ系は、**セッションファイルを監視して**出るので、ターミナルなどで直接動かしているセッションも、含まれます(`source: "cli"`)。プロセス系は、この pipe が起動したものだけです。

### イベント例

以下の `pipeApp` と `engine` は、claude-code-pipe にはありません。

#### user-message-received

```json
{
  "type": "user-message-received",
  "version": "0.2.0",
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
  "message": { "role": "user", "content": "追記の質問" }
}
```

#### assistant-response-completed

```json
{
  "type": "assistant-response-completed",
  "version": "0.2.0",
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
      { "type": "thinking", "thinking": "追記の思考", "signature": "SIG2" },
      { "type": "text", "text": "追記の回答" }
    ],
    "usage": { "input_tokens": 30, "output_tokens": 7, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0 }
  }
}
```

#### session-started

```json
{
  "type": "session-started",
  "version": "0.2.0",
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
  "version": "0.2.0",
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

`session-started` と同じ共通項目に、`pid` が付きます(`type` は `"cancel-initiated"`)。

#### session-error と session-timeout

共通項目に、`error` が付きます。起動に失敗したときは、本物のセッション ID が分からないので、`sessionId` は `temp-<時刻>-<pid>` の形の、仮の ID になります。

```json
{
  "type": "session-timeout",
  "sessionId": "temp-1788220800000-12345",
  "pid": 12345,
  "error": "Session start timeout: Failed to retrieve session ID"
}
```

(共通項目は省略しています。`session-error` の `error` は、たとえば `spawn script ENOENT` です。)

---

## エラーと制限

### エラーの形

エラーは、JSON の `{ "error": "..." }` です(一部は `message` や `details` が付きます)。

| ステータス | 本文 | 状況 |
|-------|-------------|-------------|
| `400` | `{ "error": "Invalid JSON payload" }` | リクエストボディが、JSON として壊れている |
| `401` | `{ "error": "Unauthorized: ..." }` | 認証が必要なのに、トークンがない・違う |
| `404` | `{ "error": "Not Found" }` | 該当するルートがない |
| `413` | `{ "error": "Payload Too Large" }` | ボディが `upload.maxBodySize`(既定 10mb)を超えた |
| `500` | `{ "error": "Internal Server Error" }` | 想定外のエラー |

各ルートの個別のエラーは、それぞれの節を参照してください。

### claude-code-pipe との違い

- エラー本文(404 や 413 など)は、claude-code-pipe は Express の HTML でしたが、coding-agent-pipe は JSON です。
- 自動の `OPTIONS` への応答は、ありません(CORS が要る場合は、リバースプロキシなどで)。
- ルーティングは、大文字小文字を区別します(`/Health` は 404)。末尾のスラッシュ(`/health/`)は、区別しません。
- 添付の保存先は `/tmp/coding-agent-pipe/` です(claude-code-pipe は `/tmp/claude-code-pipe/`)。

### 既知の挙動(claude-code-pipe から引き継いでいるもの)

次の挙動は、claude-code-pipe から引き継いだもので、現時点では、そのままです。

| 挙動 | 影響 | 回避策 |
|-------|-------------|-------------|
| エージェントの起動時の出力(`system/init`)が約 4KB を超えると、起動を検知できないことがある(境界は不安定で、確率的に失敗する) | `POST /sessions/new`、`POST /sessions/:id/send` が `500`(`Failed to start new session`)になる。エージェントのプロセスは動き続けることがある | スキル・プラグイン・MCP サーバーを減らして、出力を小さくする |
| プロンプトの上限は約 128KB。`\` `"` `` ` `` `$` が多いと、エスケープで 2 倍になり、約 64KB | `500`(理由の説明なし) | プロンプトを短くする。長い内容は、添付(`POST /attachments`)で渡して、パスをプロンプトに書く |
| 同じセッションに、続けて 2 回送る | 最初のプロセスが管理から外れ、`DELETE /processes`・`cancel` で止められない | 前の送信が終わってから、次を送る |
| 1 行の書き込みが、100ms 以上空いて分割されると、その行を失う | まれに、メッセージ系のイベントが欠ける | (エージェント側の書き込みの仕方に依存) |
| リクエストが途中で止まった接続があると、停止(SIGINT / SIGTERM)が終わらない | プロセスが終了しない | 接続が切れるのを待つか、`kill -9` |

---

## トラブルシューティング

### サーバーが起動しない

**症状:** `Error: listen EADDRINUSE: address already in use :::3100`

**解決策:** ポートが使用中です。使用状況を確認します。

```bash
lsof -i :3100
```

プロセスを終了するか、`config.json` の `port` を変更してください。claude-code-pipe が同じマシンで 3100 を使っていないかも、確認してください。

---

**症状:** `[index] Failed to load config.json: ...`

**解決策:** `config.json` がない、または JSON が壊れています。

```bash
cp config.example.json config.json
```

そのうえで、環境に合わせて編集してください。

---

**症状:** `[index] Unknown engine: "..."`

**解決策:** `config.engine` に、未対応の値が入っています。今使えるのは `claude-code` と `codex` です(未指定は `claude-code`)。

---

### イベントが受信されない

**症状:** Webhook の受け手に、イベントが届かない。

**解決策 1:** 受け手の URL に、到達できるか確認します。

```bash
curl -X POST http://localhost:1880/webhook \
  -H "Content-Type: application/json" \
  -d '{"test": "message"}'
```

**解決策 2:** サーバーのログに、`[subscribers] Error posting to ...` がないか確認します(送信先が落ちていても、サーバーは動き続けます)。

**解決策 3:** `config.json` の `subscribers` を確認します(`url` が正しい、`label` を付ける)。

---

### セッションが見つからない

**症状:** `GET /sessions/:id/messages` が `404`(`Session not found`)を返す。

**解決策 1:** セッションがあるか確認します。

```bash
curl http://localhost:3100/sessions
```

**解決策 2:** `watchDir` が正しいディレクトリを指しているか確認します。

```bash
ls ~/.claude/projects
```

`.jsonl` ファイルがあるはずです。起動した直後は、**起動前からあるファイルの、追記以降**が、Webhook の対象です。

**解決策 3:** ファイルの読み取り権限を、確認します(coding-agent-pipe を動かしているユーザーが、読めること)。

---

### キャンセルが効かない

**症状:** `POST /sessions/:id/cancel` を送っても、プロセスが止まらない。

**解決策:** `cancel` は、まず SIGINT を送り、`send.cancelTimeoutMs` が過ぎても終わらないときは、SIGTERM に進みます(この段階は、0.1.0 より前は動いていませんでした。[CHANGELOG](./CHANGELOG-ja.md) を参照)。すぐに止めるには、`DELETE /processes/:sessionId` を使います。また、`cancel` と `DELETE /processes` が対象にするのは、この pipe が起動したプロセスだけです(`GET /processes` で確認できます)。

---

### `POST /sessions/new` が `500` になる

**症状:** `{ "error": "Failed to start new session" }`

**解決策:** 理由は、サーバーのログにだけ出ます(`[api] Error starting new session:`)。よくある原因は次のとおりです。

- `script` コマンドがない(Linux・macOS・WSL では、エージェントの出力を PTY 経由で受け取るために必要)
- `claude` が、`PATH` にない
- プロンプトが長すぎる([既知の挙動](#既知の挙動claude-code-pipe-から引き継いでいるもの)を参照)
- エージェントの起動時の出力が大きすぎて、起動を検知できない(同上)
- 起動のタイムアウト(60 秒)

---

### 認証エラー

**症状:** `401 Unauthorized: Missing or invalid authorization header`

**解決策 1:** リクエストに `Authorization` ヘッダーを付けます。

```bash
curl -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  http://localhost:3100/sessions
```

**解決策 2:** トークンが `config.json` の `apiToken` と一致するか確認します。

**解決策 3:** 認証が不要なら、`apiToken` を空にして、サーバーを再起動します。

---

### サーバーの停止と再起動

**停止:** `Ctrl+C`(SIGINT)、または SIGTERM。観測元と、サーバーを止めて終了します。**起動したエージェントのプロセスは、止まりません**(仕様です)。サーバーを再起動しても、実行中のエージェントは動き続けます。エージェントも止めたいときは、停止の前に `DELETE /processes` で止めてください。

**再起動:** 停止してから、`npm start` で起動します。設定の変更は、再起動で反映されます(起動時に 1 回だけ読むため)。

---

### プラットフォーム固有の注意事項

- **Linux・macOS・WSL**: エージェントは `script -q -c "<エスケープ済みコマンド>" /dev/null` で起動します(PTY で、標準出力のバッファリングを避けるため)。
- **Windows(ネイティブ)**: エージェントを、配列渡し・シェルなしの `spawn` で、直接起動します。エスケープは要りません。**MQTT コマンドチャネルは、Windows ネイティブでは無効**です(起動時に警告を出します)。この環境では、Windows ネイティブは試せていません。

---

## 開発

### プロジェクト構造

```
coding-agent-pipe/
├── src/
│   ├── index.js                  組み立て(Hono、認証、ルート、停止)
│   ├── package-info.js           パッケージ情報と、pipeApp の値
│   ├── core/                     エンジンに依存しない部分
│   │   ├── api.js                REST のルート(読み取り・送信・管理・ファイル・git)
│   │   ├── process.js            起動したプロセスの管理
│   │   ├── canceller.js          キャンセル
│   │   ├── deliver.js            Webhook の配信
│   │   ├── mqtt-receiver.js      MQTT コマンドの受信
│   │   ├── git-info.js           git の情報
│   │   ├── http-utils.js         リクエストボディの処理など
│   │   ├── platform.js           OS の判定
│   │   └── sources/              観測元(セッションファイルの追記を読む)
│   └── adapters/                 エンジンごとの部分
│       ├── index.js              config.engine で adapter を 1 つ選ぶ
│       └── claude-code/          Claude Code の adapter
├── schema/event.schema.json      Webhook と GET /info の契約
└── config.example.json
```

### adapter の面

`core` は、エンジンを知りません。エンジン固有の知識(どこを読むか、どう解釈するか、どう起動するか)は、`src/adapters/<engine>/index.js` が、次の面で `core` に渡します。

| 項目 | 役割 |
|-------|-------------|
| `id`、`backendType` | エンジンの識別子と、旧来の互換項目 |
| `observe`、`parse(line)` | 観測の方法と、1 行の解釈 |
| `resolveProject`、`isSubagent`、`isAgentSession`、`sessionIdFromPath` | セッションの出どころから、プロジェクトなどを割り出す |
| `sessions` | `{ list, locate, read }`。REST の読み取りが使う、セッションデータへの入口 |
| `spawn` | `{ buildArgs, spawnProcess, parseInit }`。プロセスの起動 |
| `mountRoutes(api)` | エンジン固有の REST ルート(任意。`claude-code` は `GET /claude-version`) |

新しいエンジンを足すときは、`src/adapters/<engine>/index.js` を作り、この面を満たします。

### 新機能の追加

#### 新しい API エンドポイントの追加

1. `src/core/api.js` に、ルートを追加します(エンジン固有なら、`adapters/<engine>/routes.js`)。
2. **このドキュメントに、見出し(`#### \`METHOD /path\``)つきの節を足します。**

#### 新しい設定オプションの追加

1. 読む場所のコードに、既定値を決めます。
2. [設定詳細](#設定詳細)の表と、`config.example.json` に足します。

### デバッグ

- サーバーのログは、標準出力と、`logs/server.log`(メッセージ系を除く、プロセス系のイベント)に出ます。
- Webhook の配信を確かめるには、受け手を別に立てて、届いた JSON を見ます。
- セッションファイルの読み取りの問題は、`[watcher]` のログと、`GET /sessions/:id/messages` で確かめます。

---

## セキュリティに関する注意事項

### ⚠️ `dangerouslySkipPermissions` フラグ

`dangerouslySkipPermissions` フラグは、Claude Code のツール使用時の権限確認プロンプトを回避します(`codex` では、承認とサンドボックスの**両方**を無効にします。[Codex を使う](#codex-を使う)を参照)。**これは非常に危険であり、管理された信頼できる環境でのみ使用してください。**

#### 動作の仕組み

- **デフォルト動作**: `false`(安全)
  - Claude Code は、`Write`、`Bash` などのツールを実行する前に、権限確認を求めます
  - ユーザーが、各ツールの使用を手動で承認する必要があります
- **有効にした場合**(`true`):
  - Claude Code は、許可された全てのツールを、**ユーザーの確認なしで実行**します
  - ファイルの書き込みやコマンド実行などの、安全確認のプロンプトが出ません
  - 完全に自動で動きます

#### 設定オプション

1. **リクエストごとの指定**(推奨):

   ```json
   {
     "prompt": "プロンプト内容",
     "projectPath": "/path/to/project",
     "dangerouslySkipPermissions": true
   }
   ```

2. **グローバルな既定値**(十分に注意して使用):

   ```json
   {
     "send": {
       "defaultDangerouslySkipPermissions": true
     }
   }
   ```

#### セキュリティリスク

`dangerouslySkipPermissions` を有効にした場合:

- ⚠️ Claude Code は、作業ディレクトリの**任意のファイルを書き込み・変更・削除**できます
- ⚠️ Claude Code は、**任意の bash コマンドを実行**できます
- ⚠️ 破壊的な操作の前に、人間による確認がありません
- ⚠️ 悪意のある、あるいは誤ったプロンプトが、データ損失を引き起こす可能性があります

#### 安全な使用ガイドライン

**次の条件を、全て満たす場合だけ、有効にしてください。**

1. ✅ **サンドボックス・隔離された環境**にいる(Docker コンテナ、VM など)
2. ✅ 作業ディレクトリに、**重要なデータがない**
3. ✅ 送る**プロンプトを、完全に信頼**している
4. ✅ 重要なデータの**バックアップ**がある
5. ✅ セッションを**積極的に監視**している

**安全な使用例:** 使い捨ての Docker コンテナでの自動テスト、隔離された環境の CI/CD パイプライン、バージョン管理された開発環境。

**危険な使用例:** ❌ 本番サーバー、❌ 機密データのあるディレクトリ、❌ 共有の開発マシン、❌ 適切なバックアップのない環境。

#### 推奨される代替手段

ほとんどの使い方では、代わりに `allowedTools` で、ツールの使用を制限してください。

```json
{
  "prompt": "このコードを分析して",
  "projectPath": "/path/to/project",
  "allowedTools": ["Read", "Grep"],
  "dangerouslySkipPermissions": false
}
```

これにより、Claude Code は、ファイルを読めますが、書き込み・実行はできません。

### ⚠️ Webhook(`subscribers`)へのデータの露出

`subscribers` の各送信先は、セッションのメッセージの生の内容(`event.message`)を受け取ります。これには、実行されたコマンド(例: `Bash` ツールの呼び出し)の全文が含まれることがあります。同じ内容は、Claude Code が自分のセッションファイル(JSONL)に、すでに保存しているものです。coding-agent-pipe は、転送の前に、絞り込みやマスクをしません。

**`subscribers[].url` は、信頼できるネットワークの中(例: 同じ Tailscale の tailnet、同じ Docker ネットワーク)のエンドポイントだけにしてください。** 公開された外部のエンドポイント(本物の Slack の incoming webhook、公開サーバーなど)を指すと、コマンドの中にたまたま出た秘密情報も含めて、セッションの生の内容が、信頼の境界の外に出ます。

### ⚠️ `apiToken` と、ネットワークへの公開

`apiToken` を設定しない場合、API は、認証なしで、セッションの内容の読み取りと、プロジェクト内のファイルの読み取り(`POST /projects/file`)と、エージェントの起動(`POST /sessions/new`)ができます。**信頼できるネットワークの中だけで使い、公開する場合は、必ず `apiToken` を設定してください。**

**サーバーは、すべてのネットワークインターフェースで待ち受けます**(アドレスは `::`。マシンのすべての IPv4 と IPv6 のアドレスが対象)。ポートは `port` の設定です。自分のマシンの中(`127.0.0.1`)だけには限られず、いまのところ、限る設定もありません。そのポートに届くマシンなら、どれでも API を呼べます(同じネットワークの他のマシン、同じ Docker ネットワークの他のコンテナ、同じ Tailscale の tailnet の他のマシンなど)。

自分のマシンからだけ届くようにしたいときは、サーバーの外で限ってください。ファイアウォール、Docker のポートの公開をループバックアドレスだけにする(例: `127.0.0.1:3100:3100`)、リバースプロキシの内側に置く、などの方法があります。

---

## ライセンス

MIT
