# cc-sdd VS Code 拡張機能化プラン

## 目的

cc-sdd を「エージェントの TUI / Claude Code 拡張の上で使うスキル集」から、VS Code 上で完結する
Spec-Driven Development のワークベンチに引き上げる。最終的には Kiro IDE のような
「Specs / Steering / Approval Gate / Task Board」を持つ体験を、VS Code 拡張として提供する。

## 結論

実現可能。しかも cc-sdd は拡張機能と相性が良い。

cc-sdd の実体はエージェント本体ではなく、次の 4 つだけである。

- 17 個のスキル（Markdown）
- `.kiro/specs/<feature>/spec.json` のフェーズ状態
- `requirements.md` / `design.md` / `tasks.md` という成果物
- `.kiro/settings/` のテンプレートとルール

したがって、必要なのは **「状態ファイル + Markdown + スキル」に対する UI と状態機械**であり、
モデルやツール実行を自前で持つ必要はない。ここが拡張機能化の最大の追い風になる。

## 実装レベル

| 層 | 拡張が担うもの | エージェント | 目安 | リスク |
|---|---|---|---|---|
| **L1: Spec Explorer** | 一覧・状態表示・承認・コマンド起動 | 既存のホストに任せる | 1〜2 週 | 低 |
| **L2: VS Code ネイティブ連携** | agent plugin（スキル同梱）＋ LM tool / MCP ＋ custom agents | Copilot / Claude Code | 2〜4 週 | 中 |
| **L3: 自前オーケストレータ** | フェーズ実行、サブエージェント、レビュー、再開 | Claude Agent SDK（ローカル CLI を利用） | 1〜3 ヶ月 | 中 |
| **L4: Code OSS fork** | エディタ本体ごと Kiro 化 | 自前 | 数ヶ月〜 | 非常に高 |

推奨は **L1 + L2**。L3 は認証・モデル課金・権限・コンテキスト管理・サンドボックスを
すべて抱えることになり、cc-sdd の「ホスト非依存」という強みを自分で壊しがち。
L4 は UX 自体が製品でない限り割に合わない。

ただし 0.7.0 では、L3 のうち **Claude Code の headless 実行・進捗ストリーミング・セッション再開**を
Claude Agent SDK 経由で実装した。認証・課金・モデルは SDK / ローカル CLI に委譲するため、
当初懸念した「自前で抱える」問題は回避している（詳細は Phase 3 実装メモ）。

## 目標アーキテクチャ

```text
┌────────────────────────── VS Code / Kiro / Cursor ──────────────────────────┐
│ cc-sdd extension = UI + 状態機械 + ゲート強制                                │
│                                                                             │
│  Spec Explorer        Spec Editor            Task Board                     │
│  ├ spec.json 読取     ├ 承認ボタン           ├ (P) / _Depends:_             │
│  ├ phase 表示         ├ 差分レビュー         ├ _Boundary:_                  │
│  └ 未承認バッジ       └ ゲート前チェック     └ タスク起動                   │
│                                                                             │
│  Commands: Install / New Spec / Run Phase / Approve / Status                │
│  LM Tools & MCP: kiro_status, kiro_next_task, kiro_approve, kiro_validate    │
│                              │                                              │
│              ┌───────────────┴───────────────┐                              │
│              ▼                               ▼                              │
│   Copilot agent plugin              External agent CLI                      │
│   (17 kiro skills)                  (claude -p / codex exec / opencode)     │
└─────────────────────────────────────────────────────────────────────────────┘
```

設計の肝は **「生成はエージェント、承認と状態遷移は拡張」** に分けること。

- `spec.json` を唯一の状態源にする（拡張とエージェントの二重書き込みを避けるため、
  atomic write と JSON Schema を用意する）
  - 実装: `src/core/repository.ts` の atomic write、`schemas/spec.schema.json` の
    JSON Schema（`jsonValidation` でエディタに適用）
- 拡張は「承認」だけを書き、`requirements.md` の必須セクション欠落や
  `tasks.md` の boundary 不整合などはゲートで弾く
- スキルの配布は既存の `npx cc-sdd@latest --copilot-skills`（`.github/skills`）を
  そのまま使える。拡張はインストーラを呼ぶだけ
- 同じ拡張を Kiro / Cursor / Windsurf / VSCodium に Open VSX で配れる。
  Kiro は Code OSS ベースで VS Code 拡張を読めるので、Kiro を fork しなくても
  Kiro の中で動く

## Kiro との距離感

Kiro の正体は「Code OSS fork ＋ 独自の Specs / Steering / Hooks UI ＋ エージェント実行基盤」。
Specs を一級市民として扱う体験、フェーズゲート、タスク実行の見た目は、
拡張機能の Tree View / Custom Editor / Webview でかなり再現できる。

fork が必要になるのは、チャット UI やエージェントセッション管理、認証、課金まで
workbench 自体に埋め込みたいとき。まず拡張で 8 割の体験を取り、必要なら後から fork を
検討する順序が現実的。

## 状態モデル

`spec.json` の既存フィールドをそのまま使う。

```json
{
  "feature_name": "photo-albums",
  "language": "en",
  "phase": "tasks-generated",
  "approvals": {
    "requirements": { "generated": true, "approved": true },
    "design": { "generated": true, "approved": true },
    "tasks": { "generated": true, "approved": false }
  },
  "ready_for_implementation": false
}
```

- `phase` は既存の `initialized` / `requirements-generated` / `design-generated` /
  `tasks-generated` を維持する（新しい値を勝手に増やさない）
- 拡張は `approvals.*.approved` と `ready_for_implementation` のみ更新する
- `ready_for_implementation` は 3 フェーズすべてが approved のときに true

## チェックリスト

### Phase 0: 計画

- [x] 実装レベル（L1〜L4）を整理する
- [x] 推奨アーキテクチャを決める
- [x] `spec.json` を状態源にする方針を決める
- [x] この `plan.md` を残す

### Phase 1: L1 MVP（Spec Explorer + 承認ゲート）

- [x] `tools/cc-sdd-vscode` に拡張機能の scaffold を作る
- [x] `spec.json` / `tasks.md` を読む純粋ロジックを実装する
- [x] `spec.json` の JSON Schema を追加し、エディタで検証できるようにする
- [x] Spec Explorer（spec → phase のツリー）を実装する
- [x] フェーズ承認コマンドとゲート検証を実装する
- [x] 承認取消コマンドを実装する
- [x] フェーズ実行コマンド（Claude Code / Codex / Copilot / OpenCode / custom）を実装する
- [x] 実装フェーズ起動コマンド（`/kiro-impl`）を実装する
- [x] Task Board（`tasks.md` のチェックボックス / `(P)` / `_Depends:_` / `_Boundary:_`）を実装する
- [x] タスクのチェックボックスを拡張から切り替えられるようにする
- [x] ステータスバーにアクティブ spec と次のアクションを表示する
- [x] ファイル監視で `spec.json` / 成果物の変更を自動反映する
- [x] インストーラ起動コマンド（`npx cc-sdd@latest`）を実装する
- [x] 新規 spec 起動コマンド（`/kiro-spec-init`）を実装する
- [x] 純粋ロジックのユニットテストを追加する
- [x] `tsc` ビルドとテストを通す

### Phase 2: L2（VS Code ネイティブ連携）※ 0.6.0 で撤去（上記 Phase 2 実装メモ参照）

- [x] 17 スキルを agent plugin として同梱する → 実装・検証後に撤去
- [x] `kiro_status` / `kiro_next_task` / `kiro_approve` を MCP サーバーとして公開する → 実装・検証後に撤去
- [x] Copilot の custom agent（implementer / reviewer）を定義する → 実装後に撤去
- [x] Human-in-the-loop の承認を chat からも行えるようにする → MCP ごと撤去
- [ ] Open VSX への公開（`vsce package` は通過済み。`ovsx publish` はアカウント設定後に実施）

### Phase 3: L3（自前オーケストレータ）

- [x] Claude Code の headless CLI アダプタを実装する（0.7.0: Claude Agent SDK 経由）
- [ ] Codex の headless CLI アダプタを実装する
- [ ] OpenCode の headless CLI アダプタを実装する
- [x] フェーズ実行の進捗を拡張内でストリーミング表示する（0.7.0: cc-sdd Runs コンソール）
- [ ] サブエージェント（implementer / reviewer / debugger）の実行制御を実装する（現状は `/kiro-impl` スキル内の Agent ツールに委譲）
- [x] 中断を実装する（0.7.0: Runs コンソールの Cancel）
- [x] 再開を実装する（0.7.0: Sessions / `resume`、履歴を引き継いで同一カードで再開）
- [x] 並列 run の俯瞰ビュー（Overview ボード）を実装する（KPI / Kanban / spec ポートフォリオ）
- [ ] 自動リトライを実装する（現状は Re-run ボタンによる手動再実行のみ）

### Phase 4: L4（Kiro 型 IDE）

- [ ] Code OSS fork の要否を判断する
- [ ] チャット UI / セッション管理 / 認証を workbench に統合する
- [ ] 配布・自動更新・テレメトリを設計する

## Phase 1 実装メモ

Phase 1（L1 MVP）は `tools/cc-sdd-vscode` に実装済み。

```text
tools/cc-sdd-vscode/
  src/
    extension.ts              # コマンド登録、ファイル監視、ステータスバー
    core/
      spec.ts                 # spec.json の型・正規化・承認・次アクション
      tasks.ts                # tasks.md のパース、ツリー化、チェック切替
      validation.ts           # 承認ゲート（英語は見出し、他言語は構造で検証）
      repository.ts           # spec 一覧、成果物読み書き、atomic write
      phases.ts               # フェーズとスキルの対応
      invocation.ts           # エージェント別の呼び出しプロンプト生成
    ui/
      specTree.ts             # Spec Explorer
      taskTree.ts             # Task Board
      statusBar.ts            # アクティブ spec と次アクション
    launch/
      agentLauncher.ts        # Claude / Codex / Copilot / OpenCode / custom
  test/                       # ユニット + 統合テスト
```

確認済み:

- `npm run build`（`tsc`）が通る
- `npm test` が 69 tests で通る
- `npm run package` で VSIX を作成できる（plugin 同梱 / 69 files）
- 作成した VSIX を一時的な `--extensions-dir` にインストールできる
- リポジトリ内の実 spec（英語・日本語）で承認ゲートがエラー 0 になる

Phase 1 の設計判断:

- `spec.json` の `phase` は増やさず、`approvals` と `ready_for_implementation` だけ更新する
- 承認ゲートは言語非依存の構造チェックを基本にし、英語のみ見出し名も検査する
  （Kiro 互換の翻訳済み spec をブロックしないため）
- タスクのトレーサビリティ警告は葉タスクのみに限定する
  （親タスクは子タスクにメタデータを委譲できるため）
- エージェント起動は `ccSdd.agent` で切り替え、拡張自身はモデルを呼ばない

## Phase 2 実装メモ（0.6.0 で撤去）

Phase 2（L2: VS Code ネイティブ連携）として Agent plugin / MCP サーバー / サブエージェントを
実装・検証したが、**0.6.0 で撤去した**。

撤去の判断根拠:

- 17 スキルは cc-sdd インストーラ（`npx cc-sdd@latest --claude-skills`）が配布するもので、
  plugin による同梱は**配布経路の二重化**になる。両方入れると `/kiro-impl`（プロジェクト）と
  `/cc-sdd:kiro-impl`（plugin）が併存し、ドリフトの元になる
- implementer / reviewer サブエージェントも、`/kiro-impl` スキルが Agent ツール経由で
  内部生成するものと重複する
- MCP サーバーは状態閲覧が `/kiro-spec-status` と重複し、書き込みは拡張 UI のゲートと重複。
  既定 OFF にした後も「使わないコード」であることに変わりなかった
- 拡張は `.kiro/specs` の UI に専念するのが責務。cc-sdd 本体のスキル配布は cc-sdd に任せる

将来 cc-sdd 本体が Claude Code plugin 形式での配布を望む場合は、このリポジトリルートの
`.claude-plugin/marketplace.json` + `plugin/` 構成として復活させる（このセクションと
git 履歴に実装の知見がある。`claude plugin validate` での検証方法、
`scripts/sync-plugin.mjs` によるテンプレートからの生成手順など）。

以下は実装当時の記録（参考）。

### Agent plugin（`plugin/`、Claude Code プラグイン形式）

- Claude Code プラグイン形式（`.claude-plugin/plugin.json`）。VSIX に同梱し、リポジトリにもコミット
- ターゲットは **Claude Code**（ターミナル / VS Code 拡張）。Copilot 向け Agent Plugins 形式は不採用
- `scripts/sync-plugin.mjs` が cc-sdd テンプレートの `claude-code-skills` から 17 スキルを生成
  - `{{KIRO_DIR}}` を `.kiro` に描画化
  - SKILL.md フロントマターの `metadata.shared-rules` に従い、共有ルールを各スキルの `rules/` にコピー（インストーラと同じレイアウト）
  - `.claude-plugin/` / `agents/` / `mcp/` は静的ファイルとして手で管理
- サブエージェント: `kiro-implementer`（1タスクずつ TDD 実装）と `kiro-reviewer`（読み取り専用レビュー、`VERDICT: PASS / NEEDS_FIXES / RETURN_TO_DESIGN`）
- 配布: リポジトリルートの `.claude-plugin/marketplace.json` がマーケットプレイスを兼ねる
  - `/plugin install cc-sdd --marketplace gotalab/cc-sdd`（Claude Code 2.1.275+）
  - 開発時は `claude --plugin-dir tools/cc-sdd-vscode/plugin`
- `claude plugin validate` を plugin と marketplace の両方で通過済み（アイコンなしの警告のみ）

### MCP サーバー（`src/mcp-server.ts` + `src/mcp/tools.ts`）— オプトイン

- 依存ゼロの Node スクリプト。stdio 上の newline-delimited JSON-RPC 2.0
- **既定では無効**（0.3.1 で plugin から `.mcp.json` を削除）。状態の閲覧は
  `/kiro-spec-status` と拡張 UI で足りるため。`plugin/.mcp.json` を作ると有効化できる
- ワークスペース解決: `--workspace` → `CC_SDD_WORKSPACE` → `process.cwd()`（`--kiro-dir` / `CC_SDD_KIRO_DIR` は `.kiro` の上書き）
- ツール（すべて `structuredContent` 付きで応答、失敗は `isError: true`）:
  - `kiro_list_specs` — spec 一覧とフェーズ / 承認状況
  - `kiro_status` — 承認状態 + ゲート検証（errors/warnings）+ タスク進捗
  - `kiro_next_task` — 次の未完了タスク。未承認のときは blocked ガイダンス
  - `kiro_approve` — 拡張と同じゲート検証を実行してから書込。警告は `confirmWarnings: true` が必要
  - `kiro_toggle_task` — タスク ID で `tasks.md` のチェックを切替
- ゲートロジックは拡張 UI と `src/core/validation.ts` を共有。MCP と UI のどちらから書いても状態は一つ

### 拡張機能の追加

- `cc-sdd: Copy Agent Plugin Path` コマンド（plugin フォルダのパスをコピーし、README を開ける）

### フィードバック反映（0.3.1 〜 0.5.0）

※この節の機能は 0.6.0 で撤去されたものを含む（Gate Findings と Tasks Webview は差し戻し済み、
plugin / MCP は本节上部の撤去記録を参照）。

- **MCP を既定で無効化**: plugin から `.mcp.json` を外し、skills + サブエージェントのみ同梱。
  状態の閲覧は `/kiro-spec-status` と拡張 UI で足りるという判断。
  chat からゲート付きの `kiro_approve` / `kiro_toggle_task` が必要になったら、
  `plugin/.mcp.json` を作って opt-in（README にスニペットあり）
- **UI に状態と次アクションを集約**:
  - Spec ノードの description に次アクションを表示
    （例: `design-generated · 2/3 approved · approve tasks`、全承認時は `ready → /kiro-impl`）
  - Tasks フェーズノードに進捗を表示（例: `review · 12/41 done · next 4.1`）
  - ツールチップにも Next を追記
- **Status ペインを追加**（0.3.2）: Specs / Tasks に続く第 3 ビュー。
  アクティブ spec の「現在の状況」と「次にやること」を常に表示する。
  実装・テスト段階で Spec ツリーだけでは分からない先を見せるのが目的
  - 状態ノード: `Implementation in progress (12/41 done)` /
    `Awaiting approval — 2/3 approved` / `Implementation complete (41/41)`
  - Next ノード（クリックで実行可能）:
    - 未承認時: `Next: approve tasks`（クリックでゲート検証 → 承認）/ `Next: Generate tasks`（クリックで実行）
    - 実装中: `Next: 4.1 タイトル`（クリックで tasks.md の該当行、✓ で完了切替）+
      `Continue /kiro-impl`（クリックで実装再開）
    - 全完了: `Validate implementation`（クリックで `/kiro-validate-impl` を実行）
  - フェーズごとの進捗ノード（approved / review / 12/41 done など、クリックで成果物を開く）
  - Gate findings ノード: ゲート検証の warnings / errors を一覧（クリックで該当ファイルを開く）
  - 新コマンド: `cc-sdd: Run Implementation Validation`（`/kiro-validate-impl` を起動）
- **Status ビューを Specs に統合**（0.3.3）: 単独の Status ビューは削除。
  Spec ノードを展開すると Spec ツリー内に同じ内容
  （状態 → Next アクション → フェーズ進捗）が出る。
  次タスクノードはクリックで tasks.md の該当行、✓ で完了切替が可能。
  Tasks ビュー（タスク一覧）は従来どおり残す
- **Gate Findings を削除**（0.3.5）: cc-sdd の情報のみ表示する方針に統一。
  拡張独自のゲート検証は cc-sdd 側のテンプレート/ルール変更のたびに追従が必要になるため、
  ツリー表示からは外した。cc-sdd v3 のテンプレート/スキルには Error/Warning セクションや
  検証レポート成果物が存在しないことを確認済み（`kiro-validate-*` はセッション内で返すだけ）。
  承認時のゲート検証（`src/core/validation.ts`）は誤承認防止のため存続
- **再検証の強化**（0.3.4）: ウィンドウフォーカス復帰時と spec 配下ファイルの保存時に
  ツリーを再読込（外部プロセスによる変更の取りこぼし対策）
- **Specs の Next 行から ✓ を削除**（0.3.6）: 誤クリックでタスクを完了にしてしまう事故の防止。
  タスクの完了切替は Tasks ビューに限定
- **Tasks ビューの Webview 化と差し戻し**（0.4.0 → 0.4.1）:
  フォントサイズ設定（`ccSdd.fontSize`）向けに Tasks ビューを Webview 化したが、
  見た目がネイティブツリーと合わないため差し戻し。0.3.6 時点のネイティブツリーに戻した。
  トレードオフとして、ネイティブツリーの文字サイズは拡張から個別指定できないため、
  全体ズーム（`Ctrl`/`Cmd` + `+`/`-` または `window.zoomLevel`）で調整することになる。
  今後ツリー表示のスタイルを変えたい場合は、表示そのものではなく
  情報の粒度・バッジで調整する
- **フロー全体の入口を UI に追加**（0.5.0）: cc-sdd の全フローを拡張から起動できるようにした
  - `cc-sdd: Run Discovery`: 機能説明を入力 → `/kiro-discovery` を実行（New Spec の正しい上位入口。
    空欄 Enter なら既存 brief/roadmap からの再開もスキルに任せる）
  - **Steering ノード**: `.kiro/steering/`（product / tech / structure / roadmap）の有無を表示。
    未生成なら「not generated」でクリック起動、生成済みならクリックで product.md を開く
  - **roadmap.md 対応**: `.kiro/steering/roadmap.md` の `## Specs (dependency order)` をパースし、
    spec を依存順に並べ替え + spec ノードに `deps:` バッジ。Roadmap ノードでファイルを開ける
  - **validate-gap / validate-design**: spec 右クリックから実行（アクティブ spec にフォールバック）
  - ファイル監視範囲を `.kiro` 全体（steering / roadmap / specs）に拡大
- **plugin / MCP を撤去**（0.6.0）: 上記 Phase 2 実装メモ冒頭の判断根拠どおり。
  これにより「スキル配布は cc-sdd インストーラ、状態 UI は拡張」という責務分離が完成。
  テストは 73 → 49（plugin sync / MCP ツール / stdio 試験を削除）

### ビルド / テスト

- `npm run build` = `tsc`（拡張） + `tsc -p tsconfig.mcp.json`（`plugin/mcp/` へ出力） + sync
- `npm run sync` で plugin/skills のみ再生成
- テストは 69 個（plugin sync の生成検証、MCP ツール、stdio 上の JSON-RPC 実プロセス試験を含む）

確認済み:

- `npm run check` / `npm test`（69 tests） / `npm run build` が通る
- `npm run package` で plugin 同梱の VSIX を作成できる（0.3.1: 65 files / 約 138 KB、`.mcp.json` は含めない）
- 作成した VSIX を一時的な `--extensions-dir` にインストールし、インストール先の plugin が
  `claude plugin validate` を通ること、`plugin/mcp/mcp-server.js` が実リポジトリに対して
  `kiro_list_specs` を正しく返すことを確認（0.3.0 時点）
- リポジトリ内の実 spec に対して `kiro_next_task` / `kiro_status` が正しい状態を返すことを確認

Phase 2 で残す作業:

- Open VSX への公開（`ovsx publish`。publisher アカウント設定後）
- Claude Code での plugin インストールと実使用確認（`/cc-sdd:kiro-*`、サブエージェント、MCP ツール）
- plugin のアイコン追加（`claude plugin validate` の ICON_MISSING 警告対応）

## Phase 3 実装メモ（0.7.0）

L3（自前オーケストレータ）の最初のスライスを 0.7.0 で実装した。
認証・課金・サンドボックスは抱えず、**Claude Agent SDK に実行を委譲**する。設計・内部構造は `docs/`（日本語）を参照。

### エージェントモード

- `ccSdd.agent` に `claude-vscode` と `claude-console` を追加（既存の `claude` / codex / copilot / opencode / custom / clipboard は維持）
- `claude-vscode`: Claude Code for VS Code の composer にプロンプトを補完（自動送信はしない。公開 API が無いため）
- `claude-console`: 内蔵 Runs コンソールで headless 実行

### Runs コンソール（`src/ui/runsConsole.ts` + `src/run/claudeRunner.ts`）

- Claude Agent SDK の `query()` を利用。`permissionMode` / `canUseTool` / `resume` / `pathToClaudeCodeExecutable` を指定
- ストリーミング表示: ツール呼び出し（種別チップ + 折りたたみ結果）、Markdown（見出し・表・コード）、進捗バー・経過時間
- 権限確認: Allow once / Always allow <tool> / Deny をコンソール内に表示。既定は `default`（都度確認）
- `AskUserQuestion` を選択肢ボタンで回答し、`updatedInput.answers` として返送（requirements の質疑が VS Code 内で完結）
- 並列実行: run ごとのカード / 専用タブ（New tab）/ 個別 Close。更新は 80ms で合流
- 完了サマリ: コスト・ターン数・実行時間。承認済みフェーズでは Approve / Run next / Run implementation を提示
- 実行ログ上限: segment 600 / tool result 1,200 文字 / final result 4,000 文字

### Sessions（`src/core/sessions.ts` + `src/ui/sessionsTree.ts`）

- `~/.claude/projects/<encoded-workspace>/*.jsonl` を読み、**cwd が現在のワークスペースと一致するセッションだけ**表示
- タイトルは元の `/kiro-*` プロンプトから抽出。ツールチップに最後のアシスタント発話
- クリックで**読み取り専用プレビュー**（課金なし・履歴展開済み）。同一カード内の入力欄 + 権限モード選択から resume
- 履歴は `Session history` として保持し、ターミナル resume（`claude --resume <id>`）も選択可能

### ビルド / リリース

- esbuild で単一バンドル（`out/extension.js`）。SDK の ESM / `import.meta.url` は `--define:import.meta.url=__filename` で対応
- `vsce package --no-dependencies` を維持（実行時 node_modules なし）
- `.github/workflows/release.yml`: タグ `v*` → バージョン一致検証 → check / test / build / package → GitHub Releases に VSIX 添付
- テストは **78 tests**（SDK イベント変換・権限/質問抽出・セッション解析を追加）

### 実機検証（0.7.0）

- SDK スモーク: 通常実行 / `AskUserQuestion` 往復 / 権限承認往復 / `resume` の文脈引き継ぎ
- Runs コンソールのレンダリング（ツール・表・質問カード・プレビュー・履歴）をヘッドレスブラウザで確認
- v0.7.0 を GitHub Releases で配布
- 設計ドキュメント `docs/`（日本語）を追加

## Overview ボード（リーダー / PM 向け）

複数のワーカー（人 / エージェント）が並行して動くとき、リーダーや PM が全体を
1 画面で見るための **Overview** ボードを追加した。新しい状態ファイルは持たず、
既存の Runs / Sessions / Specs を突き合わせる。

- **KPI**: 対応待ち（pending + 承認待ち）、実行中、当日の失敗、タスク完了率、当日コスト
- **Kanban**: `Needs you` / `Running` / `Done` / `Failed`。1 カード = 1 run または直近セッション
- **Spec ポートフォリオ**: フェーズ、承認 3 段階、`tasks.md` 進捗、稼働数、次のアクション
- **相関**: 同一 `sessionId` は run を優先。別ウィンドウはセッションのトランスクリプト末尾で
  「作業中 / 質問待ち / 停止」を判定する（`system stop_hook_summary` 等の停止マーカーを利用）。
  完了済みセッションはボードに出さない
- **入口**: `cc-sdd: Open Overview`、Specs / Tasks / Sessions のタイトルバー、
  Runs コンソールのヘッダー
- **実装**: `core/overview.ts`（純粋集約）+ `ui/overviewPanel.ts`（Webview）+
  `runsConsole.getRuns()` / `onDidChange`。テストは `test/overview.test.ts`

制約:

- ライブ状態はこのウィンドウの Runs コンソールが持つ。再起動で run 履歴は消える
- 別ウィンドウの状態はトランスクリプト末尾からの推定。停止マーカーが無い古い形式では
  assistant テキストの最終更新から 60 秒で停止扱いにする
- pending への回答 / Cancel は run タブで行う（Overview からは open のみ）

次の一手は **SF-1（実行の永続化）**。run 状態を `.kiro/runs/` に書き出せば、
Overview は複数ウィンドウ / 再起動後も正確なワーカー状態を表示できる。

## ソフトウェアファクトリーとしての位置づけ（2026-11）

> 参照: [AI駆動開発の次の段階: ソフトウェアファクトリー](https://qiita.com/Syoitu/items/9364a0a175893bb15219)（Qiita / @Syoitu、KDDIアジャイル開発センター）

この記事で紹介された用語集（Matt Pocock 氏の `software-factory` スキル）の定義
（チケット・PR・スケジュールを入力として、マージ済みのコードを生産するエージェントの仕組み。
リモートのインフラ上で動き、1 回の実行は人の介入を待たずに終わる）と、現在の拡張を比較した。

### 構成パーツ別のカバー状況

| パーツ | カバー | 現状 / 不足 |
| --- | --- | --- |
| タスク | ○ | スキル + フェーズ（spec 生成・実装・検証）として定義。レビュー / ラチェット / 保守のタスクは未定義 |
| トリガー | ✕ | 人間のクリックと UI 更新のみ。Issue / PR / スケジュール / 実行連鎖のトリガーなし |
| 実行 | ○ | headless 実行・キャンセル・サマリ・並列実行。記録はメモリのみ（再起動で消える） |
| ランナー | ✕ | ローカルマシン。使い捨て / リモート / サンドボックスなし |
| チケットトラッカー | △ | `spec.json` と成果物が作業単位と状態を担う。コメント・ラベル・双方向会話はなし（実行中の質疑は AskUserQuestion） |
| チケットソース | ✕ | フィードバック / 監視 / エラートラッカー連携なし |
| Git ホスト | ✕ | ブランチ / PR / マージ連携なし（エージェント内部の git のみ） |
| オーケストレーター | △ | Runs コンソールがローカルで状態管理。トリガー受信 / キュー / 自動リトライ / 永続化なし |
| オブザーバビリティ | ○ | 実行のストリーミング、コスト / ターン表示、セッション履歴。外部トレース連携なし |

### ブレーキ（記事で重視）

| ブレーキ | カバー | 現状 |
| --- | --- | --- |
| 自動チェック | ○ | 承認ゲート（構造検証・プレースホルダ検出）+ validate スキル。CI 必須化は未接続 |
| 自動レビュー | △ | validate-gap / design / impl はあるが、PR 起点の自動レビュー・修正ループなし |
| 人のレビュー | ◎ | フェーズ承認ゲート（検証付き承認 / 取消）が中核。ファクトリーの「人の判断」に相当 |

**総合: 定義全体の約 30〜35%。** 現状は「ファクトリーの制御盤・検品場」であり、
自動生産ライン（トリガー → 実行 → PR → レビュー → マージ）は未実装。
一方、記事が重視する「ブレーキを先に整える」観点では、承認ゲートが既にあるのは強み。

### ソフトウェアファクトリー化ロードマップ

- [ ] **SF-1: 実行の永続化** — run 履歴を `.kiro/runs/*.json`（または SQLite）に保存し、リロード後も一覧 / 再開 / リトライ可能にする
- [ ] **SF-2: トリガー層** — Issue ラベル / `spec.json` のフェーズ変化 / スケジュールから実行を開始する
- [ ] **SF-3: Git 連携** — 実装完了でブランチ + ドラフト PR を作成し、マージを人間のブレーキにする
- [ ] **SF-4: 自動レビュータスク** — PR 作成時に validate スキルを自動実行し、指摘があれば修正タスクを連鎖
- [ ] **SF-5: リモート / 使い捨てランナー** — GitHub Actions / devcontainer / サンドボックスに実行を移し、拡張は制御盤に徹する
- [ ] **SF-6: チケットソース** — 監視 / エラートラッカー / フィードバックから Issue を自動作成

順序の推奨: **SF-1 → SF-2 → SF-3 → SF-4 → SF-5 → SF-6**。
「サービスは買い、タスクは作る」に合わせ、タスク定義（cc-sdd スキル + フェーズマッピング）は
引き続きこの拡張と cc-sdd 側で持ち、チケット / Git / ランナーは既製品を接続する。

## リスクと対策

| リスク | 対策 |
|---|---|
| Chat Participant API が deprecated | agent plugin / LM tool / MCP に寄せる。participant は使わない |
| Claude Code 拡張を API で操作できない | headless CLI（`claude -p`）または VS Code Language Model API を使う |
| 拡張とエージェントが `spec.json` を同時更新する | 更新は拡張経由に寄せる。書込は atomic write + 再読込 |
| Copilot 前提になる | `clipboard` / custom command / 外部 CLI を最初から用意する |
| Kiro の商標 | 拡張名に「Kiro」を使わない（例: `cc-sdd Specs`） |
| マルチルート workspace | 初期版はシングルルート。`ccSdd.kiroDir` で相対パスを指定 |
| Claude Code CLI が前提になる（claude-console / Sessions） | `ccSdd.claudePath` でパス指定可。未検出時はコンソールにガイダンスを表示。他エージェントは従来どおり利用可 |
| SDK をバンドルした CJS 化で起動時に落ちる | esbuild の `--define:import.meta.url=__filename` を維持。CI の起動スモーク追加を検討 |
| セッション保存形式（`~/.claude/projects`）の変更 | 読み取りを `src/core/sessions.ts` に閉じ込め、エンコード規則・JSONL 形式の変化に追従 |
| 大きなセッションの resume でトークンを消費する | 先にプレビュー（課金なし）で確認。履歴は 1,500 エントリで上限 |
| `bypassPermissions` の誤用 | 既定は `default`（コンソールで都度承認）。`bypassPermissions` は実行ごとに明示選択 |

## 次の一歩

Phase 1（L1 UI）、フロー入口（0.5.0）、L3 の最初のスライス（0.7.0: headless 実行 / Runs コンソール / Sessions）が実装済み。
plugin / MCP は 0.6.0 で撤去済み（スキル配布は cc-sdd インストーラに一元）。

残る作業:

1. Open VSX への公開（publisher アカウント設定後、`npx ovsx publish`）。GitHub Releases は release workflow で自動化済み
2. 実使用（example-test の impl フロー）でのフィードバック反映
3. ソフトウェアファクトリー化: SF-1（実行の永続化）→ SF-2（トリガー）→ SF-3（Git/PR）の順で拡張
4. 余力があれば Codex / OpenCode の headless アダプタと、サブエージェント制御

設計・内部構造は `docs/`（日本語）を参照。Phase 4（Code OSS fork）は拡張で 8 割の体験を確認してから判断する。
