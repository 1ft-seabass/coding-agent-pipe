# 変更履歴

このプロジェクトの主な変更はすべてこのファイルに記録します。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.0.0/) に基づき、バージョニングは [セマンティック バージョニング](https://semver.org/lang/ja/) に従います。

## [Unreleased]

## [0.2.0] - 2026-10-10

### Added
- **Codex エンジン**: `"engine": "codex"` にすると、Claude Code の代わりに、OpenAI の Codex CLI を扱う(API と Webhook の形は同じ)。`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` を追いかけ(このエンジンでは `watchDir` の既定が `~/.codex/sessions`)、PTY を使わずに `codex exec --json`(既存のセッションへは `codex exec resume`)を起動し、`projectPath` は、各セッションファイルの 1 行目の作業ディレクトリから割り出す。Codex が起動したサブエージェントは、`isSubagent: true` の別のセッションとして出て、`GET /sessions` の既定の一覧からは除かれる。`allowedTools`・`disallowedTools` は効かず、`dangerouslySkipPermissions` は `--dangerously-bypass-approvals-and-sandbox`(承認とサンドボックス)に対応する。トークン数(`totalTokens`、`usage`)は、Codex の `token_usage_record` から計算する(`input_tokens` は、Claude と同じく、キャッシュ分を除く)。Windows と MQTT は未確認。DETAILS の「Codex を使う」を参照
- `POST /sessions/new` と `POST /sessions/:id/send` のレスポンスに `codingAgentVersion` を追加した。エンジンに依らない名前のエージェントのバージョン。`claude-code` では `claudeCodeVersion`(これまでどおり返す)と同じ値、`codex` では `null` で、`claudeCodeVersion` は返さない

### Fixed
- 起動に失敗したあと、約 60 秒後に `session-timeout` が出ないようにした。エージェントのプロセスが、セッションを報告しないまま終了した(または起動できなかった)とき、60 秒の起動タイマーが動き続け、すでに終わったセッションについて `session-timeout` の Webhook が送られ、終わったプロセスに `kill` が呼ばれていた。プロセスの終了時と起動エラーのときに、タイマーを止める(新規のセッションと、既存のセッションへの送信の両方)。タイマーが切れた時点で、まだ動いているプロセスの扱いは、これまでどおり

### Changed
- ドキュメントのみ: サーバーを止めても、起動したエージェントのプロセスが止まらないことを、既知の弱点でなく、仕様として書いた。挙動は変わらない。DETAILS の「既知の挙動」から外し、サーバーの停止と再起動の節に書いた

## [0.1.0] - 2026-10-08

### Fixed
- 存在しない `watchDir` を、作らないようにした。警告を 1 回出して、起動は続け、ディレクトリが現れたら監視を始める(5 秒おきに確認する)。これまでは、`watchDir` のタイプミスで、余計なディレクトリが黙って作られていた。存在する `watchDir` の動きは、変わらない
- サブエージェントのイベントにも、ほかのイベントと同じく、`projectPath`・`projectName`・`git` が付くようにした。サブエージェントのファイル(`<プロジェクト>/<sessionId>/subagents/` の下)のプロジェクトを、1 つ下のディレクトリで探していて、見つからなかった。REST にも同じ修正が効く。`excludeAgents=false` のとき、`GET /sessions` はサブエージェントのセッションの `projectPath`・`projectName` を返し、`GET /projects` はそれを、所属するプロジェクトに数える。既定の一覧は変わらない
- `subscribers` が複数のとき、`assistant-response-completed` の `responseTime` が、すべての subscriber で同じ値になるようにした。これまでは、2 件目以降で `0` になっていた(1 件目の処理が、先に最後のタイムスタンプを更新するため)
- MQTT で、既存のセッションに送るコマンド(`sessionId` つき)が、`projectPath` を作業ディレクトリとして使い、イベントにも載せるようになった(REST API や、MQTT の新規セッションの開始と同じ)。これまでは無視されていて、エージェントは、サーバーを起動した場所で起動していた
- `cancel` が、SIGINT のあと `send.cancelTimeoutMs` を過ぎても終わらないプロセスに、実際に SIGTERM を送るようになった。これまでは、Node の `killed` を見ていて、SIGINT を送った時点で真になるため、SIGTERM が送られなかった
- 同じ誤りが、ほかの 3 か所にもあったので、あわせて直した。`GET /processes` の `alive` は、実際に動いている間は `true` のままになる(これまでは、`cancel` の直後に `false` になった)。`DELETE /processes/:sessionId` と `DELETE /processes` は、`cancel` で SIGINT を受けたプロセスにも、SIGTERM を送る(これまでは、飛ばして、`killed: false` と返していた)

### Changed
- **0.1.0 から、claude-code-pipe とすべての挙動を同じに保つことは、目標ではなくなった。** 引き継いだ弱点を、1 つずつ直し、意図した変更として、ここに記録する(Fixed と Changed を参照)。残っている弱点は、DETAILS の「既知の挙動」にある
- `watchDir` の `~` の展開を、`process.env.HOME` から `os.homedir()` に変更。`HOME` が未設定の環境(Windows ネイティブなど)でも、`~` が空文字にならない
- `apiToken` の確認で、トークンを定数時間で比べるようにした(SHA-256 のダイジェストにそろえて `crypto.timingSafeEqual`)。先頭の何文字が合っているかで、比較の時間が変わらなくなる。通るトークンと、通らないトークンは、変わらない

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
