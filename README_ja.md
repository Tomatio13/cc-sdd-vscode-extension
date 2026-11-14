# cc-sdd Specs（VS Code 拡張機能）

[cc-sdd](https://github.com/gotalab/cc-sdd) の specs を VS Code 上で扱うワークベンチです。`.kiro/specs/` を直接読み取り、足りなかった UI レイヤー（spec explorer、承認ゲート、フェーズランチャー、タスクボード、headless な **Runs** コンソール、Claude Code セッションの再開、Spec の進捗を俯瞰する **Overview** ポートフォリオ）を追加します。

<div align="center" style="margin-bottom: 1rem; font-size: 1.1rem;"><sub>
<a href="./README.md">English</a> | 日本語
</sub></div>

![cc-sdd Specs ワークベンチ: Specs / Tasks / Sessions のサイドバー、中央の cc-sdd Runs コンソール、右の cc-sdd Overview ポートフォリオ](./assets/workbench.png)

このワークベンチは、実装タスクを統合した Specs ビューと Sessions 履歴タイムライン、2つのパネルで構成されます。

- **Specs / Sessions** — 作業対象の Spec を選び、Requirements → Design → Tasks → Implementation → Verification の工程、実行状態、タスク、セッション再開を対応するビューで扱います。
- **Runs** — ツール呼び出し・Markdown 出力・進捗を1つのパネルにストリーミング表示。権限確認と `AskUserQuestion` も同じパネルで回答できます。
- **Overview** — 進行中 Spec の工程・タスク・実行状態、明示的なブロック、依存候補、最近の更新、検証済みの完了をまとめた PM 向けポートフォリオです。

設計・内部構造のドキュメント: **[docs/](./docs/README.md)**

Specs は、工程を点と線でつなぐサイドバーのタイムラインです。実装タスクの進捗、承認・実行操作、このウィンドウの最近の Run（最大5件）を表示します。実装タスクは各 Spec の Implementation 配下に統合し、完了分は折りたたみます。独立した Tasks ビューは廃止し、Sessions も同じモノクロのタイムライン表示です。実行中を上部、過去の履歴を最終活動の新しい順に並べ、詳細と再開操作は展開時に表示します。更新時は展開状態と閲覧位置を保持します。

## フローの対応範囲

Discovery → Steering → spec 生成 → 承認 → 実装 → 検証、までを VS Code の UI から完結できます。

| cc-sdd のフロー | 拡張での対応 |
| --- | --- |
| `/kiro-discovery` | ✅ Specs ビューの 🧭 ボタン / `cc-sdd: Run Discovery`（説明を入力 → 実行。空で Enter なら既存 brief / roadmap からの再開をスキルに任せる） |
| Steering（product / tech / structure） | ✅ Specs タイムラインの Steering 行。未生成ならクリックで `/kiro-steering` 実行、生成済みならクリックで product.md を開く。Run ボタンでいつでも再実行 |
| `/kiro-spec-init` | ✅ `cc-sdd: New Spec` |
| `/kiro-spec-requirements` / `design` / `tasks` | ✅ Run Phase（フェーズノードの ▶）。生成物の状態表示とファイルオープン |
| 承認ゲート | ✅ ✓ Approve / 取消。承認フラグと `ready_for_implementation` のみ書き込む |
| `/kiro-impl` | ✅ Run Implementation。Spec 全体または「このタスク」「ここから残り」を実行。進捗は tasks の `[x]` から表示 |
| `/kiro-validate-impl` | ✅ Specs の Verification 工程 / Tasks の検証セクション / `cc-sdd: Run Implementation Validation` |
| `/kiro-spec-status` | ✅ `cc-sdd: Show Spec Status`（Markdown レポートを開く） |
| `/kiro-validate-gap` / `validate-design` | ✅ spec 右クリックから実行 |
| セッション再開 | ✅ **Sessions** ビュー。選択中 Spec に絞り、active / history を分けて表示。履歴は resume、実行中は関連 Run を開く |
| 並列作業の全体監視 | ✅ **Overview** ポートフォリオ。Spec / レビュー待ち / 実装中 / 完了 / タスク進捗を 1 画面に集約。ローカル run は Runs コンソール、セッションは Sessions ビューで確認 |
| `/kiro-spec-batch` | ⚠️ roadmap.md の依存順で Spec 一覧を並べ替え・依存表示までは対応。batch 実行自体はスキル側 |
| `/kiro-spec-quick` / `review` / `debug` / `verify-completion` | ⚠️ 起動 UI なし。セッション内で完結するワークフローのため、拡張からは起動しない |

## 何ができるか

- **Spec Explorer** — `.kiro/specs/<feature>` を Requirements → Design → Tasks → Implementation → Verification の番号付きパイプラインとして一覧表示。次アクションを1つに絞り、状態はアイコンと文言で表示。実装完了と Spec 完了は別で、現在の成果物に対する `impl-validation.md` の `GO` がある場合だけ完了。並びは既定で新しい spec が上（`created_at`、なければ `updated_at`）。`ccSdd.specSort: roadmap` にすると roadmap の依存順になります。`deps:` バッジ付き
- **Steering / Roadmap ノード** — `.kiro/steering/` の生成状況と roadmap.md への入口。生成済みの Steering はRun ボタンから再実行できる。roadmap.md は `## Specs (dependency order)` をパースする
- **Approval gates** — 承認前に成果物を検証。必須セクションの欠落や未解決の `{{PLACEHOLDER}}` は承認をブロックし、より軽い問題は明示的な確認が必要
- **Phase launcher** — `/kiro-spec-requirements`、`/kiro-spec-design`、`/kiro-spec-tasks`、`/kiro-impl`、`/kiro-validate-*` を Claude Code / Codex / Copilot Chat / OpenCode / カスタムコマンド / クリップボードで実行
- **Overview ポートフォリオ** — リポジトリ上の Spec 進捗を俯瞰するリーダー / PM 向け画面。進行中 / ブロック / レビュー待ち / 検証待ち / 完了の KPI フィルター、工程と実行状態を分けた進行中テーブル、明示的なブロック理由と roadmap の依存候補、最近の更新、折りたたみ式の完了セクションを表示。検証は `impl-validation.md` が現在の成果物に対して `GO` のときだけ「検証済み」と判定。ローカル run は Runs コンソールに分離し、このウィンドウの記録であることを明記
- **Task board** — 選択中 Spec 名を常時表示。実装タスクと Verification セクション（検証結果・チェック項目・開始/再検証/レポートを開く）を分離。完了タスクは折りたたみ、次の候補・実行中・依存待ちを区別。タスク単体 / ここから残りを実行、tasks.md の該当行を開く、実行中の Run を開く操作に対応
- **Sessions** — 初期表示は選択中 Spec。全 Spec に切り替え可能。active / waiting と history を分け、Spec・工程（検証を含む）・状態・最終活動を表示。履歴は resume、実行中は関連 Run を開く
- **Status bar** — アクティブ spec と共通の next action を常時表示。run 実行中は `N waiting · M running` も表示
- **Auto refresh** — `.kiro/` 配下を監視し、変更時に再読込。フォーカス復帰時と spec 配下の保存時にも再検証
- **Installer** — 好きな統合を選んで `npx cc-sdd@latest` を実行
- **JSON Schema** — `.kiro/specs/*/spec.json` の編集を検証

検証起動時は、`DECISION` 行を含む根拠レポートを `impl-validation.md` に保存するよう指定します。`spec.json` の validation フィールドだけの場合は保存未確認と表示して再検証へ誘導し、Run の正常終了だけでは完了にしません。

## 状態モデル

拡張は `spec.json` を唯一の状態源として扱い、書き込むのは承認状態だけです。

```json
{
  "phase": "tasks-generated",
  "approvals": {
    "requirements": { "generated": true, "approved": true },
    "design": { "generated": true, "approved": true },
    "tasks": { "generated": true, "approved": false }
  },
  "ready_for_implementation": false
}
```

- 既存の `phase` 値（`initialized`、`requirements-generated`、`design-generated`、`tasks-generated`）は維持
- 3 つの承認がすべて `true` になると `ready_for_implementation` が `true`
- 任意の `blocked_reason` / `blockers` は明示的なブロックとして表示。更新の古さや過去の run からブロックを推測しない
- Overview の検証は `impl-validation.md` の `DECISION: GO | NO-GO | MANUAL_VERIFY_REQUIRED` を読む。成果物より古い結果は `stale` とし、検証済みとは表示しない
- 書き込みは一時ファイル + rename のため、中断されても `spec.json` が壊れない

## コマンド

| コマンド | 説明 |
| --- | --- |
| `cc-sdd: Refresh` | specs と tasks を再読込 |
| `cc-sdd: Run Discovery` | 説明を入力して `/kiro-discovery` を起動 |
| `cc-sdd: Run Steering` | `/kiro-steering` を起動（Steering ノードをクリックでも可。生成済みならRun ボタンで再実行） |
| `cc-sdd: Validate against Codebase (Gap)` | 選択中 spec で `/kiro-validate-gap` を起動（spec 右クリック） |
| `cc-sdd: Validate Design` | `/kiro-validate-design` を起動（spec 右クリック） |
| `cc-sdd: New Spec` | 説明を入力して `/kiro-spec-init` を起動 |
| `cc-sdd: Install Skills` | 統合先を選んで `npx cc-sdd@latest` を実行 |
| `cc-sdd: Select Active Spec` | Tasks ビューが追従する spec を選択 |
| `cc-sdd: Show Spec Status` | フェーズと承認の Markdown サマリを開く |
| `cc-sdd: Open Overview` | リーダー / PM 向けの Spec ポートフォリオを開く（Specs / Tasks / Sessions のタイトルバーのダッシュボードアイコンからも起動） |
| Approve / Revoke Phase | フェーズノードのコンテキストアクション |
| Run Phase | 未生成 / draft / review のフェーズのコンテキストアクション |
| Run Implementation | 実装可能な spec のコンテキストアクション（🚀） |
| Run Implementation Validation | `/kiro-validate-impl` を起動 |
| Toggle Task / Open Task | `tasks.md` のチェックボックスをツリーから切替 / 該当行を開く |

内部コマンド（`ccSdd.openArtifact`、`ccSdd.openTask` など）はコマンドパレットから隠してあり、ツリービューが使用します。

## 設定

| 設定 | 既定値 | 説明 |
| --- | --- | --- |
| `ccSdd.kiroDir` | `.kiro` | `specs/` と `settings/` を含むディレクトリ |
| `ccSdd.agent` | `claude` | `claude` / `claude-vscode` / `claude-console` / `codex` / `copilot` / `opencode` / `custom` / `clipboard` |
| `ccSdd.customCommand` | 空 | `custom` 時のターミナルコマンドテンプレート。`${prompt}`、`${skill}`、`${feature}` が使用可 |
| `ccSdd.consolePermissionMode` | `default` | `claude-console`(headless 実行)の既定権限モード(`default` / `acceptEdits` / `bypassPermissions` / `plan`)。`default` は Runs コンソール内で確認する。実行ごとに選択画面が出る |
| `ccSdd.claudePath` | `claude` | headless 実行で使う claude CLI のパス |
| `ccSdd.installLanguage` | 空 | インストーラに渡す `--lang` 値（例: `ja`） |
| `ccSdd.autoRefresh` | `true` | specs ディレクトリの変更を監視 |

### エージェント呼び出し

| エージェント | 動作 |
| --- | --- |
| `claude` | ターミナルで `claude "/kiro-… <feature>"` を実行 |
| `claude-vscode` | Claude Code for VS Code のパネルにプロンプトを補完。拡張側の preferred location（サイドバー or エディタタブ）に追従。Enter で実行 |
| `claude-console` | Claude Agent SDK 経由で headless 実行し、**cc-sdd Runs** コンソールに進捗をストリーミング表示。権限確認と `AskUserQuestion` はコンソール内のボタンで回答できる(requirements / design の質問も VS Code 内で完結) |
| `copilot` | Copilot Chat にプロンプトを流し込む |
| `opencode` | ターミナルで `opencode run "/kiro-… <feature>"` を実行 |
| `custom` | `ccSdd.customCommand` のテンプレートを実行 |
| `clipboard` | プロンプトをコピー（エージェントを別画面で使う場合） |

Copilot Chat を開けない場合は、プロンプトをクリップボードにコピーします。

### Sessions

**Sessions** ビューは `~/.claude/projects/<encoded-workspace>/*.jsonl` を読み、記録された `cwd` が現在のワークスペースと一致するセッションだけを新しい順に表示します。ホバーで最後のアシスタント発話を確認でき、**クリックするとトランスクリプト全体の読み取り専用プレビュー**が Runs コンソールに開きます。同じカード内の継続メッセージ入力欄と権限モード選択から **Resume in console** を押すと、**その場で**ライブ実行に切り替わります(追加ダイアログなし)。**Terminal** ボタンは `claude --resume` を起動します。右クリックメニューには以下もあります:

- **Resume in Runs console** — 同じセッションを headless で継続(Claude Agent SDK の `resume`)。権限モードは通常どおり選択。保存済みのトランスクリプトは **Session history** ブロックとして表示され、過去のやり取りがそのまま読めます
- **Resume in terminal** — `claude --resume <session-id>` を対話ターミナルで起動
- **Open raw transcript** / **Copy session id** — 調査・スクリプト用

### Overview ポートフォリオ

`cc-sdd: Open Overview`（または各ビューのタイトルバーのダッシュボードアイコン）で、チーム向けの Spec ポートフォリオを開きます。

- **集計範囲** — ヘッダーにプロジェクト名、最終取得時刻、データ範囲を表示。Spec はこのワークスペース、実行状態はこの VS Code ウィンドウで取得できた記録
- **プロジェクト概況** — 進行中 / ブロック / レビュー待ち / 検証待ち / 完了のクリック可能な件数。相互排他的ではないため、サブテキストで内訳を表示
- **進行中の Spec** — 工程、タスク進捗、現在の状況、停止理由、最終更新を表で表示。工程と実行状態は分離し、実装工程でも実行記録がなければ `No run record` と表示
- **依存関係・着手候補** — `roadmap.md` に記録された依存だけを使い、待機・後続影響・着手候補・検証結果の古さを表示。roadmap がない場合は「依存情報なし」と表示し、着手可能とは判定しない
- **最近の更新** — Spec 更新、ローカル run の開始・完了・失敗、検証レポートの記録を表示。タスク完了や工程変更の履歴は、タイムスタンプから捏造しない
- **完了済み Spec** — 初期状態は折りたたみ。全タスク完了かつ現在の成果物に対する `GO` 検証がある場合だけ完了扱い。タスク完了だけでは検証済みにしない
- **フィルター・折りたたみ・スクロール** — 自動更新後も維持

ローカル実行の監視は **Runs コンソール**、セッション履歴は **Sessions** ビューが担当します。ステータスバーはローカルの実行中ワーカーを表示し、Runs コンソールを開きます。

## ワークスペースのスコープ

MVP は最初のワークスペースフォルダに追従します。同じフォルダ内の別の specs ルートには `ccSdd.kiroDir` を使用してください。マルチルート対応は将来の候補です。

## ソースから実行

```bash
git clone https://github.com/Tomatio13/cc-sdd-vscode-extension.git
cd cc-sdd-vscode-extension
npm install
npm run build
npm test
```

VS Code でリポジトリのフォルダを開き <kbd>F5</kbd> を押すと、同梱の `.vscode/launch.json` が Extension Development Host を起動します。

試すには `.kiro/specs/<feature>/spec.json` を含むフォルダを開いてください。拡張はそのフォルダを直接読むため、このリポジトリである必要はありません。

VSIX の作成:

```bash
npm run package
```

## 設計の境界

- **生成はエージェントの仕事。** 拡張はモデルを呼ばず、スキルを起動し、ツール・権限・モデルの選択はホストに任せる
- **承認は拡張の仕事。** ゲート検証は決定的でローカルに完結する
- **ストレージ形式は共有。** Kiro、Claude Code、Codex、Copilot など cc-sdd ホストは同じ `.kiro/specs` を使い続けられる
- **VS Code 互換。** 公開 API と Copilot Chat 用の組み込みコマンドを使うため、Kiro / Cursor / Windsurf / VSCodium でも Open VSX 経由で動作する

## 未対応

[plan.md](https://github.com/gotalab/cc-sdd/blob/main/plan.md) のロードマップ: Codex / OpenCode の headless アダプタ、拡張内でのサブエージェント実行制御、クロスウィンドウを正確に扱う run 履歴の永続化、タスク単位の Kanban、Code OSS fork の検討。

## ライセンス

MIT
