# Overview ポートフォリオ（チーム / Spec 進捗）

複数の担当者がそれぞれの Spec を進めているとき、チームリーダーが
「どの Spec がどこまで進み、何が止まり、次に何ができるか」を俯瞰するための画面です。

`cc-sdd: Open Overview`（Specs / Tasks / Sessions のタイトルバーのダッシュボードアイコン）で開きます。
設計の背景と受け入れ条件は [overview-improvement-design.md](./overview-improvement-design.md) を参照してください。
サイドバー側の作業フローは [worker-sidebar-redesign.md](./worker-sidebar-redesign.md) と共通の完了判定を使います。

## 集計範囲

Overview は **このワークスペースのリポジトリ状態** と、
**この VS Code ウィンドウで取得できた run 記録** を表示します。

- Spec / 承認 / タスク / 検証結果: このワークスペース
- 実行状態: この VS Code ウィンドウの Runs コンソールが持つ記録

ローカルの run をチーム全体の稼働状況としては表示しません。ヘッダーにもこの範囲を明記します。
ローカル実行の監視は **Runs コンソール**、会話履歴は **Sessions ビュー** が担当します。

## 画面構成

上から次の順に並びます。

1. ヘッダー（プロジェクト名・最終取得時刻・更新・集計範囲）
2. プロジェクト概況（KPI）
3. 進行中の Spec
4. 依存関係・着手候補
5. 最近の更新
6. 完了済み Spec（初期状態は折りたたみ）

### プロジェクト概況

| KPI | 意味 |
| --- | --- |
| In progress | 完了扱いになっていない Spec。Blocked / Verification pending を含む |
| Blocked | 明示的な停止理由、または未完了の依存を持つ Spec |
| Review pending | 承認待ちフェーズを持つ Spec |
| Verification pending | 実装タスクは完了したが、現在の成果物に対する検証完了を確認できていない Spec |
| Done | 実装完了かつ、現在の成果物に対する検証が GO の Spec |

KPI をクリックすると一覧を絞り込みます。件数は相互排他的ではないため、
サブテキストで内訳（explicit / dependency、failed など）を表示します。
全タスクの合計進捗は参考値として表示し、プロジェクト全体の完成率には換算しません。

### 進行中の Spec

Spec を横断して比較できる表です。

| 列 | 内容 |
| --- | --- |
| Spec | 表示名と識別子 |
| Stage | Requirements / Design / Tasks / Implementation / Verification |
| Tasks | 完了数 / 総数（参考の進捗バー付き） |
| Current status | 実行中、入力待ち、承認待ち、検証待ち、停止理由など |
| Updated | Spec の最終更新時刻（ホバーで絶対時刻） |
| Action | 関連する Run を開く |

工程と実行状態は分離しています。実装工程でも、実行記録がなければ `No run record` と表示し、
`Running` とは表示しません。

並び順:

1. 明示的なブロック、または直近の Run 失敗
2. 実行中
3. 入力待ち・承認待ち
4. その他の未完了

同じ区分内は、Spec の更新または run の開始 / 終了が新しい順です。自動更新時はスクロール位置とフィルター、
折りたたみ状態を維持します。狭い画面では表を縦型の行に切り替えます。

### 依存関係・着手候補

`roadmap.md` の `## Specs (dependency order)` に記録された依存だけを使います。

- 他の Spec の完了待ち
- 後続 Spec が待っている未完了の依存
- 依存条件を満たし、まだ着手していない Spec
- 検証結果が現在の成果物より古い Spec（再検証の候補）

`roadmap.md` がない場合は「依存情報なし」と表示します。「依存なし」「着手可能」とは判定しません。
依存先の Spec が一覧にない場合は `Dependency status unknown` と表示し、明示的な Blocked とは区別します。

### 最近の更新

記録から確認できるイベントを新しい順に表示します。

- Spec の追加・更新（`spec.json` / 成果物の最終更新）
- Run の開始・完了・失敗・キャンセル（ローカル記録）
- 検証レポートの記録

初期表示は 10 件で、必要に応じて全件表示できます。
タスク完了や工程変更の履歴基盤はまだないため、更新時刻だけから変更内容を捏造しません。
その場合は中立的な `Spec updated` として表示します。

### 完了済み Spec

初期状態では折りたたみ、見出しに件数を表示します。展開すると次を表示します。

- Spec 名
- 検証結果（GO / NO-GO / MANUAL / stale / なし）
- 完了または最終更新時刻
- Spec 詳細へのリンク

## 状態の扱い

### 実装完了と検証完了

| 状態 | 判定 |
| --- | --- |
| 実装中 | 未完了の実装タスクがある |
| 実装完了 | すべての実装タスクが完了 |
| 検証待ち | 実装完了だが、現在の成果物に対する検証完了を確認できない |
| 検証失敗 | 現在の成果物に対応する検証結果が `NO-GO` |
| 検証済み | 現在の成果物に対応する検証結果が `GO` |

検証結果は Spec ディレクトリの `impl-validation.md` を読みます。
`DECISION: GO | NO-GO | MANUAL_VERIFY_REQUIRED` 行を認識し、
レポートの mtime が `spec.json` / requirements / design / tasks より古い場合は
「検証結果あり・現在の成果物への適用は未確認」として `stale` 扱いにします。
判定行がないレポートは `unconfirmed` とし、検証済みとは扱いません。

### 承認待ち

承認待ちは Spec の状態として表示します。チームリーダーを承認者として割り当てたり、
Overview 全体を承認依頼の受信箱として扱ったりはしません。

### 実行失敗とブロック

- Run の失敗は実行状態であり、Spec 全体のブロックではありません。
- 直近の Run が失敗した場合だけ `Last run failed` と表示します。
  古い失敗の後に成功 Run があれば失敗状態にはしません。
- Spec のブロックは `spec.json` の `blocked_reason` / `blockers`、
  または未完了の依存として明示された場合だけ表示します。更新が古いだけでは判定しません。

### 複数の実行

同じ Spec に複数の有効な Run がある場合は `2 running` のように件数を表示し、
Runs コンソールで一覧を確認できます。

## データ取得と実装

| ファイル | 役割 |
| --- | --- |
| `src/core/overview.ts` | 純粋な集約ロジック（KPI / 表 / 依存 / イベント） |
| `src/core/repository.ts` | `spec.json`・成果物・`impl-validation.md`・roadmap の読み取り |
| `src/core/spec.ts` | Specs ツリーと共通の next step 判定 |
| `src/ui/overviewPanel.ts` | Webview。表・依存・イベント・折りたたみ・フィルター |
| `src/extension.ts` | specs / tasks / validation / roadmap / runs を集約 |

### 更新の流れ

```text
.kiro/ のファイル変更 or Runs の更新
  → OverviewPanel.scheduleRefresh (350ms debounce)
  → loadOverview (specs + tasks + validation + roadmap + runs)
  → buildOverview → webview へ state 送信
```

Webview 側はフィルター、完了セクションの開閉、イベントの展開、
スクロール位置を保持したまま再描画します。

## 制約

- 表示できるのは **このワークスペースの checkout にある Spec** だけ。
  他メンバーの未マージ作業は見えない。共有は git（branch / PR / merge）に依存する
- 担当者（assignee）情報は持たない
- Run 状態はこの VS Code ウィンドウの記録のみ。別ウィンドウの実行は Sessions ビューで確認する
- タスク完了・工程変更の履歴はまだ保存していないため、最近の更新は
  Spec 更新・Run イベント・検証レポートに限定される
