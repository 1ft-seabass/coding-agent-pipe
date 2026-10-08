# coding-agent-pipe

コーディングエージェント CLI のための双方向パイプ(略称: `ca-pipe`)

[English version](./README.md)

## 概要

**coding-agent-pipe** は、コーディングエージェントの動作を双方向にパイプするための軽量なライブラリです。

コーディングエージェントの JSONL セッションファイルを監視し、REST API で操作を提供し、セッションイベントを Webhook で配信します。プログラムからエージェントにプロンプトを送信し、応答が完了したらイベントを受け取ることができます。

- 1 プロセス = 1 エンジン(`config.engine` で選択)。今使えるエンジンは `claude-code` です

## できること・できないこと・やらないこと

### ✅ できること
- コーディングエージェントのセッションファイルを監視し、REST API でアクセスを提供
- プログラムからエージェントにプロンプトを送信
- セッションイベントを Webhook で配信
- 個人のワークフロー自動化のための軽量な実装

### ❌ できないこと
- UI の提供(フロントエンドは各自で用意してください)
- エージェント本体のインストールや更新管理
- すべてのエージェントのバージョンでの動作保証

### 🚫 やらないこと
- エンタープライズ機能(複雑な認証、レート制限、マルチテナント対応など)
- データベース永続化(インメモリキャッシュのみ)
- エージェントの破壊的変更時の後方互換性維持

## 機能

- **Watch Mode**: セッションファイルを監視し、構造化されたデータを抽出
- **Send Mode**: REST API 経由でエージェントにプロンプトを送信(`claude -p` プロセスを作成)
- **Cancel Mode**: 実行中のセッションをプログラムからキャンセル
- **Webhook 配信**: セッションイベントを外部サービス(Node-RED、Slack など)に送信
- **MQTT コマンドチャネル**: MQTT 経由でもセッションを動かせる(任意。コマンドの受信だけ)
- **Git 情報 API**: REST API 経由でプロジェクトのリポジトリ状態・コミットログを取得
- **ファイルアップロード API**: base64 形式で画像・テキスト・PDF・Office 文書・CSV をアップロードしてセッションで利用
- **プロジェクトファイル閲覧 API**: プロジェクト内のテキスト・画像ファイルの内容を取得(ビューワー UI 向け)。パストラバーサル・隠しファイル・`.gitignore` 対策を内蔵

## プラットフォーム対応

| 機能 | Linux | macOS | WSL | Windows(ネイティブ) |
|---------|-------|-------|-----|------------------|
| Webhook / Watch Mode | ✅ | ✅ | ✅ | ✅ |
| Send Mode / Cancel Mode | ✅ | ✅ | ✅ | ✅ |
| MQTT コマンドチャネル | ✅ | ✅ | ✅ | ❌(無効) |

- Node.js 20 以上が必要です。
- Linux・macOS・WSL では、エージェントを `script` コマンド(PTY)経由で起動します。
- 動作の検証は、Linux で行っています。

## クイックスタート

### ステップ 1: インストールと起動

依存パッケージをインストールします。

```bash
npm install
```

設定ファイルのサンプルをコピーして、編集します。

```bash
cp config.example.json config.json
```

`config.json` を編集します。最低限、`watchDir` を設定してください。

```json
{
  "watchDir": "~/.claude/projects",
  "port": 3100
}
```

サーバーを起動します。

```bash
npm start
```

次のように表示されます。

```
[index] Logging to: /path/to/coding-agent-pipe/logs/server.log
[subscribers] No subscribers configured
coding-agent-pipe v0.1.0 listening on port 3100
[watcher] Starting to watch: /home/user/.claude/projects
[watcher] Watching started
```

動作を確認します。

```bash
curl http://localhost:3100/health
```

### ステップ 2: Watch Mode(読み取りのみ)

セッションの一覧を取得して、API を試します。

```bash
curl http://localhost:3100/sessions
```

メッセージ数、タイムスタンプ、最初と最後のメッセージなどの、セッションのメタデータが返ります。

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
      "firstUserMessage": "プロジェクトの構成を教えて",
      "lastAssistantMessage": "どういたしまして!"
    }
  ]
}
```

(実際には、`userMessageCount` など、ほかの項目も含まれます。)

セッションの全メッセージを取得します。

```bash
curl http://localhost:3100/sessions/SESSION_ID/messages
```

最後のアシスタントの応答を取得します。

```bash
curl http://localhost:3100/sessions/SESSION_ID/messages/assistant/latest
```

既存のセッションのデータを読むだけなので、いちばん安全な始め方です。

### ステップ 3: Send Mode(任意)

慣れてきたら、エージェントにプロンプトを送れます。

新しいセッションを作ります(`projectPath` は必須で、存在するディレクトリです)。

```bash
curl -X POST http://localhost:3100/sessions/new \
  -H "Content-Type: application/json" \
  -d '{"prompt": "こんにちは", "projectPath": "/path/to/project"}'
```

レスポンス(一部):

```json
{
  "message": "Session started",
  "sessionId": "01234567-89ab-cdef-0123-456789abcdef",
  "pid": 12345
}
```

既存のセッションに送ります。

```bash
curl -X POST http://localhost:3100/sessions/SESSION_ID/send \
  -H "Content-Type: application/json" \
  -d '{"prompt": "続きをお願いします", "projectPath": "/path/to/project"}'
```

> **注意**: Send Mode は、エージェントを、あなたの権限で起動します。`allowedTools` で、使えるツールを絞ることを、おすすめします。`dangerouslySkipPermissions` は、隔離された環境でだけ使ってください。詳しくは、[DETAILS-ja.md のセキュリティに関する注意事項](./DETAILS-ja.md#セキュリティに関する注意事項)を参照してください。

## 基本の設定

### 最小構成

```json
{
  "watchDir": "~/.claude/projects",
  "port": 3100
}
```

### Webhook つき

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

### API トークン付き(本番環境では推奨)

```json
{
  "watchDir": "~/.claude/projects",
  "port": 3100,
  "apiToken": "YOUR_TOKEN_HERE"
}
```

`apiToken` を設定すると、すべての API リクエストに `Authorization` ヘッダーが必要になります。

```bash
curl -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  http://localhost:3100/sessions
```

そのほかの設定は、[DETAILS-ja.md](./DETAILS-ja.md) を参照してください。

## よくある使い方

### セッションを監視する

新しい応答を監視して、通知を送ります。

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

> **注意**: Webhook には、セッションのメッセージの生の内容(実行したコマンドを含む)が、そのまま送られます。送信先は、信頼できるネットワークの中のものだけにしてください。詳しくは、[DETAILS-ja.md](./DETAILS-ja.md#-webhooksubscribersへのデータの露出)を参照してください。

### ワークフローを自動化する

プログラムからセッションを作り、結果を Webhook で受け取ります。

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

`callbackUrl` は、Webhook のペイロードに含まれます。受け取る側が、その URL に、メッセージを送り返せます。

## ドキュメント

- **[DETAILS-ja.md](./DETAILS-ja.md)** - 完全な API リファレンス、設定オプション、Webhook フォーマット、既知の挙動、トラブルシューティング
- **[DETAILS.md](./DETAILS.md)** - English version
- **[CHANGELOG-ja.md](./CHANGELOG-ja.md)** - リリースノートとバージョン履歴

## プロジェクトの方針

このプロジェクトは**意図的にミニマル**に作られており、特定の個人的なニーズを解決するために構築されています。

### メンテナンス方針

- **主な焦点**: 作者の日常ワークフローを改善する機能
- **エージェントの更新**: 破壊的変更には可能な範囲で追従します
- **Issue**: お気軽に開いてください(ただし、迅速な対応は保証できません)
- **Pull Request**: コントリビューションは感謝します!ただし、大きく複雑さを増すものや、ミニマルな思想から外れるものはマージしない場合があります。大きな機能追加はフォークをご検討ください。

### なぜこのアプローチなのか?

このツールは実際の必要性から生まれました:「コーディングエージェントのセッションをプログラムから操作したい。最小限の手間で。」

フル機能のプラットフォームを構築するのではなく、シンプルさを保ちます。
- 理解しやすく、改造しやすい小さなコードベース
- 役立つために必要最小限の機能
- もっと機能が欲しい場合は、フォークや拡張を推奨します

**注意**: これは個人用ツールを公開したものです。そのまま使う、必要に応じてフォークする、改善をコントリビュートする—どれも歓迎ですが、エンタープライズレベルのサポートは期待しないでください。

## ライセンス

MIT。
