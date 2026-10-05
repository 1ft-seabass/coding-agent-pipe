# 変更履歴

このプロジェクトの主な変更はすべてこのファイルに記録します。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.0.0/) に基づき、バージョニングは [セマンティック バージョニング](https://semver.org/lang/ja/) に従います。

## [Unreleased]

## [0.0.2] - 2026-10-04

### Added
- **adapter 層**: エンジン固有の知識(どこを読むか・どう解釈するか・どう起動するか)を `src/adapters/<engine>/` に一束にした。`src/core/` は、自分がどのエンジンを相手にしているかを知らない。最初の adapter は `claude-code`。1 プロセス = 1 エンジンで、起動時に 1 回だけ選ぶ
- **`config.engine`**: adapter を選ぶ(未指定と空文字は `claude-code`。claude-code-pipe の config がそのまま動く)。未知の名前や不正な名前は、利用できるエンジンの一覧を添えて起動に失敗する
- **`engine` 項目**: すべての webhook ペイロードと `GET /info` に、`pipeApp` と並べて `engine`(例: `"claude-code"`)を追加。追加のみで、`backendType` は残す。claude-code-pipe は送らないので、受け手は「`engine` が無ければ `claude-code`」とみなせる
- **`schema/event.schema.json`**: webhook のイベントと `GET /info` のレスポンスの JSON Schema。契約の「正」の 1 ファイル。claude-code-pipe の出力の記録も、この版の実際の出力も、同じスキーマに合う。未知の項目は許す

### Changed
- ソースの配置(挙動は変えない。claude-code-pipe との比較テストで確認): `watcher.js` → `core/sources/file-tail.js`、`subscribers.js` → `core/deliver.js`、`sender.js` → `core/process.js` と `adapters/claude-code/spawn.js`、`parser.js` → `adapters/claude-code/parse.js`、`api.js` → `core/api.js`(セッションの読み取りは adapter 経由)。`GET /claude-version` は `claude-code` adapter が登録する

## [0.0.1] - 2026-10-04

### Added
- **`pipeApp` 項目**: すべての webhook ペイロードと `GET /info` に `pipeApp: "coding-agent-pipe"` を追加(追加のみで、既存の項目は変えない)。受け手が、どのアプリから来たデータかを区別できる。claude-code-pipe はこの項目を送らないので、受け手は「`pipeApp` が無ければ `claude-code-pipe`」とみなせる。`backendType`(どのコーディングエージェントか)とは独立している
- `claude-code-pipe` v0.9.1 を Hono に移植(ESM、ビルドなし、Node.js 20 以上)。ファイル構成は claude-code-pipe と同じで、HTTP 層だけを Express から Hono に替えた。REST API と webhook のペイロードは変わらず、claude-code-pipe との比較テスト(130 件。うち 2 件は意図した差分)で確認している
- `src/http-utils.js`: Express が暗黙にやっていたことを揃える小さな補助関数(クエリの重複キーは配列になる、`express.json()` 互換のボディのパース、`'10mb'` 形式のサイズ表記)
- `config.example.json`(claude-code-pipe からコピー)
- `claude-code-pipe` v0.9.1 を移植の基準として開発を開始(Express → Hono。0.0.x では挙動を変えない方針)

### Changed
- 添付の保存先を `/tmp/coding-agent-pipe/` に変更(claude-code-pipe は `/tmp/claude-code-pipe/`)。同じホストで両方を動かしても、清掃処理が互いのファイルを消さない
- Express が HTML で返していたエラー(404、不正な JSON、413)を JSON(`{ "error": "..." }`)に変更
- `GET /claude-version` は、`claude` が未インストールでもクラッシュしない(結果を一度だけ確定する)
- `config.json` が無いときは、スタックトレースではなくヒントを出して終了する

### Not reproduced(Express との意図的な差分)
- 自動の `OPTIONS` 応答
- 大文字小文字を区別しないルーティング(`/Health`)
