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
4. **末尾 128KB** を読んで(`readSessionTailInfo`)、最後のアシスタント発話と
   `activity`(running / waiting / stopped / unknown)を取得
5. **`cwd` が現在のワークスペースと一致するものだけ**残す(末尾スラッシュは正規化)
6. mtime の新しい順にソート

`readSessionTail()` は `readSessionTailInfo()` の後方互換ラッパーで、最後のアシスタント発話だけを返します。

タイトル抽出:

- `<command-name>` があれば `/<skill> <args>` をタイトルにする
- なければ `<system-reminder>` 等のタグを除去して先頭 100 文字
- それも無ければ `Session <id 先頭8文字>`

`formatWhen` で `just now` / `5m ago` / `3h ago` / `2d ago` / `YYYY-MM-DD` を表示します。

## セッションの活動状態(`activity`)

Sessions ビューは選択中 Spec（または全 Spec）のセッションを表示しつつ、`readSessionTailInfo()` が JSONL の末尾を逆順に走査して返す `SessionRecord.activity` を状態アイコン / ラベルに使います。

| 末尾の内容 | `activity.state` | Sessions ビューでの表示 |
| --- | --- | --- |
| assistant の `tool_use`(未完了) | `running` | `Running` / **Active** |
| 未回答の `AskUserQuestion` | `waiting` (`pending: 'question'`) | `Waiting for input` / **Question** |
| user の `tool_result` | `running` | `Running` |
| assistant のテキスト + `system stop_hook_summary` / `turn_duration` | `stopped` | 停止アイコン |
| `result` エントリ | `stopped` | 停止アイコン |
| assistant のテキストのみ(停止マーカーなし) | 更新から 60 秒以内なら `running`、それ以降は `stopped` | 同上 |
| 判定できる内容がない | `unknown` | 不明アイコン |

補足:

- **mtime だけでは判定しない**。完了後も `last-prompt` / `cost-state` などのメタ行が追記され、mtime は新しくなる
- `stop_hook_summary` / `turn_duration` / `stop` を停止マーカーとして扱う
- 停止マーカーが無い古い CLI 形式のためのフォールバックが 60 秒の猶予
- Sessions ツリーは選択中 Spec（または全 Spec）のセッションを表示し、`activity` は状態表示に使う
- 15分以上更新がなく、対応する実行中 Run もない `running` / `waiting` セッションは、停止と断定せず `unverified` として Past sessions に表示する

## Sessions ビュー(`ui/sessionsTree.ts`)

選択中 Spec の作業状況を確認するビューです。初期表示は選択中 Spec に絞り、
ビュー上部の **Showing: ...** ノード（またはタイトルの scope ボタン）で全 Spec に切り替えられます。

| 要素 | 内容 |
| --- | --- |
| Scope | `Showing: <spec>` / `Showing all specs`。クリックで切り替え |
| Active & waiting | `activity.state` が `running` / `waiting` で、15分以内の更新または対応する実行中 Run があるセッション |
| Past sessions | `stopped` / `unknown`、または記録上 `running` / `waiting` でも更新が古く有効な Run がないセッション（`unverified`） |
| Other specs | 選択中 Spec 以外に active / waiting がある場合の件数と全体表示への導線 |

セッション項目:

| 項目 | 内容 |
| --- | --- |
| ラベル | 最後の活動メッセージ（なければ工程名） |
| description | Spec 名 · 工程 · 実行状態 · 最終活動時刻 |
| 工程 | `kiro-impl` → Implementation、`kiro-validate-impl` → Verification など |
| ツールチップ | 開始時刻・最終活動・最後のメッセージ・トークン（補助）・id / file |
| クリック | `ccSdd.previewSession` で読み取り専用プレビュー |
| インライン（active + run あり） | `ccSdd.openSessionRun` で関連 Run を開く |
| インライン（history） | `ccSdd.resumeSession` で再開メニュー |

状態の扱い:

- `activity` はトランスクリプト末尾から記録された値を使い、**更新がない時間だけでは停止と推測しない**
- セッションの終了や最終メッセージだけで Spec の完了・検証成功を確定しない
- 関連 Run は `sessionId` が一致する場合だけ紐付ける（名前や時刻では紐付けない）
- 同じ Spec の複数セッションを1件にまとめない
- 実行中セッションには resume を出さず、履歴セッションだけ再開導線を出す

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

## 使用量の集計

セッションのトークン量・コストは、CLI がターンごとに書き出す **`cost-state` エントリ**(`totalCostUSD` / `modelUsage` / `totalAPIDuration` / `totalToolDuration` / 行数)の**最新値**を使います(`readSessionUsage`)。`cost-state` が無い古いログでは、assistant メッセージの usage(メッセージ ID で重複排除)と `result.total_cost_usd` の合計にフォールバックします。ファイルの mtime/size でキャッシュします。

- Sessions ツリー: `2h ago · 120k tok · ~$0.88` のように表示
- ツールチップ: 入力 / 出力 / cache read / cache write / 推定コスト / API 時間・ツール時間 / 追加・削除行数
- プレビュー: `SESSION USAGE` カードに同じ内訳を表示

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
- **完了済みセッションは停止状態で表示される**: Sessions には残り、`activity` が `stopped` として扱われる
- **再開は履歴を送る**ため、巨大セッションの resume はトークン消費が大きくなります(必要ならプレビューで内容を確認してから)
- セッションの読み取りはローカルファイルのみ。ネットワーク送信はしません
- マルチルートは他機能と同じく**先頭フォルダ**基準です
- ディレクトリ名のエンコード規則は Claude Code 側の実装に依存します。変更された場合は `encodeProjectDir` を修正してください
