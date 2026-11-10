# Overview ボード（リーダー / PM 向け）

複数のワーカー（人 / エージェント）が並行して動いているとき、リーダーや PM が
「いま何が動いていて、誰が止まっていて、どこまで進んだか」を 1 画面で見るためのボードです。

`cc-sdd: Open Overview`（Specs / Tasks / Sessions のタイトルバーのダッシュボードアイコン、Runs コンソールの **Overview** ボタン）で開きます。

## 何を集約しているか

Overview は新しい状態ファイルを持たず、既存の 3 つの情報源を突き合わせます。

| 情報源 | 使うもの | 強み / 制約 |
| --- | --- | --- |
| Runs コンソール(`ui/runsConsole.ts`) | このウィンドウの `RunState[]` | 正確な pending / 権限 / エラー / コスト。再起動で消える |
| Sessions(`core/sessions.ts`) | `~/.claude/projects/<encoded-cwd>/*.jsonl` の末尾 | 別ウィンドウ / ターミナルの作業も見える。状態はトランスクリプト末尾から推定 |
| Specs / Tasks(`core/repository.ts` / `core/tasks.ts`) | `spec.json` の承認、`tasks.md` のチェックボックス | 承認ゲートと実装進捗。エージェントの実行状態は持たない |

### 相関ルール

- 同じ `sessionId` を持つ run とセッションは **run を優先**（二重表示しない）
- run にまだ `sessionId` が無い場合は `feature + skill` が一致するセッションを除外
- セッションは `updatedAt` が **3 分以内**で、かつ `activity` が「作業中」のときだけボードに出す
  - 末尾が assistant の `tool_use`（未完了）→ `Running` / `Active elsewhere`
  - 未回答の `AskUserQuestion` → `Needs you` / `Question elsewhere`
  - `system stop_hook_summary` / `turn_duration` / `result` などの停止マーカーがある → **出さない**（完了 / 待機中）
  - 停止マーカーが無い古い形式は、assistant テキストの最終更新から 60 秒で停止扱い
- それより古いセッションはボードに出さない（履歴は Sessions ビュー / Runs コンソールの役割）

## 画面構成

### KPI ストリップ

| KPI | 意味 |
| --- | --- |
| Needs you | pending（権限 / 質問）の run + 承認待ちフェーズ + 質問待ちセッション |
| Running | このウィンドウの実行中 run + トランスクリプト末尾が作業中のセッション |
| Failed today | 当日に error で終わった run |
| Tasks done | 全 spec の `tasks.md` の完了 / 総数 |
| Spend today | 当日のセッションコスト（run の値が先行していれば大きい方） |

KPI をクリックすると、その列にフォーカスします（もう一度クリックで解除）。`Needs you` は
**承認待ちカードも含む**ため、KPI の件数と `Needs you` 列の件数が一致します。

### Kanban

| 列 | 内容 |
| --- | --- |
| Needs you | `pending` がある run、質問待ちセッション、承認待ちのフェーズ |
| Running | 実行中の run、トランスクリプト末尾が作業中のセッション |
| Done | 正常終了した run |
| Failed | error / cancelled の run |

カードは 1 ワーカー（run / セッション）または 1 承認。feature、skill、経過時間、
直近のツール / 発話、トークン、コストを表示します。クリックで run タブ、
セッションプレビュー、または成果物を開きます。

### ステータスバー

run が動いている間は `$(dashboard) N waiting · M running` を表示します。クリックで Overview を開きます。
待ち件数は `RunsConsole.onDidChange` のたびに `getRuns()` から数え直すため、Overview を閉じていても最新です。

### Spec ポートフォリオ

全 spec を新しい順（`spec.json` の `created_at`、なければ `updated_at` / ファイル時刻）で並べます。
Specs ツリーと同じ next step 判定を使い、実装完了後は `Next` を表示しません。
フェーズ、承認 3 段階、`tasks.md` の進捗バー、当日コスト、最終更新時刻を表示し、
クリックで `tasks.md` を開きます。最終更新は `spec.json`・成果物・run・session のうち最新の時刻で、
相対表示（ホバーで絶対時刻）になります。

## 実装

| ファイル | 役割 |
| --- | --- |
| `src/core/overview.ts` | 純粋な集約ロジック。`OverviewModel` / KPI / Kanban / ポートフォリオを生成（テスト対象） |
| `src/core/sessions.ts` | `SessionRecord.activity` を生成（`readSessionTailInfo`） |
| `src/ui/overviewPanel.ts` | Webview パネル。KPI / Kanban / ポートフォリオの描画 |
| `src/ui/overviewStatusBar.ts` | `N waiting · M running` のステータスバー |
| `src/extension.ts` | spec / tasks / sessions / runs を読み、`buildOverview` に渡す。コマンド登録 |
| `src/ui/runsConsole.ts` | `getRuns()` / `onDidChange` / `openRun()` を公開。ヘッダーから Overview を開く |
| `test/overview.test.ts` | 列分類・承認カード・重複排除・コスト集計のテスト |

### データモデル

```text
OverviewInput
  ├─ specs:   { record: SpecRecord, tasks?: string }[]
  ├─ runs:    RunState[]        (このウィンドウ)
  ├─ sessions: SessionRecord[]  (activity を含む)
  └─ now:     number
        ↓ buildOverview()
OverviewModel
  ├─ kpi:     OverviewKpi
  ├─ columns: Record<'attention'|'running'|'done'|'failed', OverviewCard[]>
  └─ specs:   OverviewSpec[]
```

- `OverviewCard.source`: `live` / `session` / `review`
- `OverviewSpec.reviewPhases`: 承認待ちフェーズ。ここから `attention` カードを生成
- `OverviewSpec.createdAt`: ポートフォリオの並び順に使う作成時刻
- `OverviewSpec.nextKind` / `nextLabel`: Specs ツリーと共通の next step 判定。完了時は `nextLabel` なし
- `OverviewSpec.updatedAt`: `spec.json` / 成果物 / run / session のうち最新の更新時刻
- 各列は 20 件まで。`needsYou` は切り詰める前の件数

### 更新の流れ

```text
run event → RunsConsole.updateAll (80ms 合流) → onDidChange
          → OverviewStatusBar.update
          → OverviewPanel.scheduleRefresh (350ms debounce)
          → loadOverview (specs + tasks + sessions 5s cache + runs)
          → buildOverview → webview へ state 送信
```

ファイル監視（`.kiro/` と sessions）からの `refresh()` でも同じ経路で更新します。
経過時間は webview 側の 1 秒タイマーで進め、ホストは再計算しません。

## 制約と次の一手

- ライブ状態は**このウィンドウの Runs コンソール**が持つ。別ウィンドウの run は
  トランスクリプト末尾からの推定で、完了直後はボードから消える（Sessions には残る）
- 停止マーカーが書かれない古い CLI 形式では、assistant テキストが 60 秒更新されなければ
  停止扱いにするフォールバックを使う
- 別ウィンドウの権限待ちはトランスクリプトに専用の印が無いため、`Running` として見える
  （`AskUserQuestion` は `waiting` として `Needs you` に出せる）
- 各列は 20 件まで。KPI は切り詰める前の件数を表示する
- 再起動すると run の履歴は失われる（Sessions には残る）
- 次の一手は [plan.md](../plan.md) の **SF-1: 実行の永続化**。`run` の状態を
  `.kiro/runs/` に書き出せば、Overview は複数ウィンドウ / 再起動後も正確な
  ワーカー状態を表示できる
- pending への回答や Cancel は現状 run タブで行う。Overview から直接操作する場合は
  `runsConsole` のメッセージハンドラを共有する必要がある
- Marketplace 用 README は画像なし。GitHub 用のスクリーンショットは VSIX に含めない
