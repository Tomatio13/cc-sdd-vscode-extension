# セッション(Sessions)

Claude Code が保存する会話ログを一覧・プレビュー・再開する機能です。実装は `src/core/sessions.ts` と `src/ui/sessionsTree.ts`、再開 UI は Runs コンソールが担当します。

## 保存場所と形式

Claude Code はプロジェクトごとにセッションを保存します。

```text
~/.claude/projects/<encoded-cwd>/
├─ <session-id>.jsonl          ← 会話ログ(1行1イベントの JSON)
└─ <session-id>/               ← 大きな tool result の退避先など
   └─ tool-results/*.txt
```

- ディレクトリ名は **cwd の非英数字を `-` に置換**したもの
  例: `/home/masato/Workspace/cc-sdd/example-test` → `-home-masato-Workspace-cc-sdd-example-test`
- JSONL の主なイベント: `user`(テキスト / `tool_result`)、`assistant`(テキスト / `tool_use` / `thinking`)、`system`、`result`、メタ行(`permission-mode` など)
- スラッシュコマンド実行時は user メッセージ内に
  `<command-name>/kiro-impl</command-name><command-args>ubuntu-resource-summary</command-args>`
  が入る

## 一覧の作り方(`listSessions`)

1. `claudeProjectDir(workspaceRoot)` でディレクトリを特定
2. `*.jsonl` を列挙し、各ファイルの mtime を取得
3. **先頭 256KB まで**を読んで(`readSessionHead`)、最初の user テキストから
   - `cwd` / `timestamp` / `/skill feature` のタイトル / skill / feature を抽出
4. **末尾 128KB** を読んで(`readSessionTail`)、最後のアシスタント発話を取得(ツールチップ用)
5. **`cwd` が現在のワークスペースと一致するものだけ**残す(末尾スラッシュは正規化)
6. mtime の新しい順にソート

タイトル抽出:

- `<command-name>` があれば `/<skill> <args>` をタイトルにする
- なければ `<system-reminder>` 等のタグを除去して先頭 100 文字
- それも無ければ `Session <id 先頭8文字>`

`formatWhen` で `just now` / `5m ago` / `3h ago` / `2d ago` / `YYYY-MM-DD` を表示します。

## Sessions ビュー(`ui/sessionsTree.ts`)

| 操作 | 動作 |
| --- | --- |
| ホバー | ツールチップに **最後のアシスタント発話** + id / updated / cwd / file |
| クリック | `ccSdd.previewSession` → **読み取り専用プレビュー**を Runs コンソールに開く |
| インライン(右) | `ccSdd.resumeSession` → アクションメニュー |
| ビュータイトルの更新 | `ccSdd.refreshSessions` |

アクションメニューの内容: Preview transcript / Resume in Runs console / Resume in terminal / Open raw transcript / Copy session id。

`~/.claude/projects/<project>/*.jsonl` を `FileSystemWatcher` で監視し、変更があれば自動更新します(他プロジェクトのセッションは表示しません)。

## プレビュー(読み取り専用)

`RunsConsole.previewSession()` が **プロセスを起動せずに** 1 枚のカードを作ります。

- `status: 'preview'`、`permissionMode: 'read-only'`、`preview: { sessionId, filePath, defaultPermissionMode }`
- `readTranscriptSegments(filePath)` で JSONL を `RunSegment[]` に変換し、`history` として保持
- Webview では `Session history · N entries` が**最初から展開**され、末尾までスクロールされた状態で表示
- カード下端に **継続メッセージ入力 + 権限モード選択 + Resume in console / Terminal**

### トランスクリプト変換(`transcriptSegmentsFromLines`)

| JSONL イベント | Segment |
| --- | --- |
| user の text(コマンドラッパー含む) | `user`(表示は `/kiro-impl …`) |
| user の `tool_result` | `toolresult` |
| assistant の text | `text`(`thinking` は捨てる) |
| assistant の `tool_use` | `tool`(`Name: summary`) |

上限: 1,500 エントリ(超過分は先頭を省略)、1 テキスト 4,000 文字、ツール結果 1,200 文字。
ファイルが 32MB を超える場合は末尾 32MB だけ読み、先頭の部分行を捨てます。

## 再開

### 同じカード内で再開(in-place)

`Resume in console` は Webview から `{ type: 'resumeConsole', runId, instruction, permissionMode }` を送ります。

`RunsConsole.resumePreview()`:

1. その run の `status` を `running` に変更し、`preview` をクリア
2. `permissionMode` / `prompt` を更新し、`segments` をリセット(履歴は保持)
3. `startClaudeRun({ resume: sessionId, prompt, permissionMode })` を同じ run に接続

→ **新しいカードは増えず、同じ画面の同じカードがライブ実行に切り替わります。** 履歴は上に残ります。

### ターミナルで再開

`Resume in terminal` / メニューの terminal は次を実行します。

```bash
claude --resume <session-id>
```

`ccSdd.claudePath` のパスを使い、`cwd` はワークスペースルートです。

## 設計上の注意

- **読み取り専用のプレビューは課金ゼロ**: SDK を起動しないためトークンを消費しません
- **再開は履歴を送る**ため、巨大セッションの resume はトークン消費が大きくなります(必要ならプレビューで内容を確認してから)
- セッションの読み取りはローカルファイルのみ。ネットワーク送信はしません
- マルチルートは他機能と同じく**先頭フォルダ**基準です
- ディレクトリ名のエンコード規則は Claude Code 側の実装に依存します。変更された場合は `encodeProjectDir` を修正してください
