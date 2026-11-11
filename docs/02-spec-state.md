# 状態モデルと承認ゲート

## `.kiro` の構造

```text
.kiro/                      ← ccSdd.kiroDir(既定)
├─ steering/
│  ├─ product.md            ← 存在チェック + 表示
│  ├─ tech.md
│  ├─ structure.md
│  └─ roadmap.md            ← "## Specs (dependency order)" を解析
└─ specs/<feature>/
   ├─ spec.json             ← 唯一の状態源
   ├─ requirements.md
   ├─ design.md
   └─ tasks.md
```

## `spec.json` の扱い

拡張が読む主なフィールド:

| フィールド | 用途 |
| --- | --- |
| `feature_name` | 表示名(無ければディレクトリ名) |
| `language` | 承認ゲートの言語判定(`en` 以外は構造チェック) |
| `phase` | 表示のみ。**拡張は書き換えない** |
| `approvals.requirements/design/tasks` | `{ generated, approved }`。拡張は `approved` を更新する |
| `ready_for_implementation` | 3 フェーズすべて approved のとき true(拡張が再計算) |
| `blocked_reason` / `blockers` | 任意。明示的な停止理由とブロック項目。Overview はこれがある場合だけ Blocked と表示する |

### 検証レポート

- `impl-validation.md` が存在する場合、Overview は `DECISION: GO | NO-GO | MANUAL_VERIFY_REQUIRED` 行を読む
- レポートの mtime が `spec.json` / requirements / design / tasks より新しい場合だけ、現在の成果物に対応する結果として扱う
- 古い場合は `stale`、判定行がない場合は `unconfirmed` とし、検証済みとは表示しない

### 書き込みルール

- 拡張が書くのは `approvals.*.approved` と `ready_for_implementation`、`updated_at` のみ(`core/spec.ts` の `withApproval`)
- 書き込みは**原子的**(`repository.ts` の `writeAtomically`): 一時ファイル → `rename`
- `spec.json` が不正 JSON の場合は `SpecRecord.specError` に理由を持ち、承認操作は失敗する
- ディレクトリ ID は `^[A-Za-z0-9._-]+$` のみ許可(パストラバーサル防止)

### 状態の派生

| 関数 | 意味 |
| --- | --- |
| `phaseStatus(spec, phase, exists)` | `missing` → `draft` → `generated` → `approved` |
| `nextAction(spec)` | 次に行うこと: `Generate <phase>` / `Review and approve <phase>` / `Ready for implementation` |
| `nextStepState(spec, tasks)` | Specs ツリー / Overview 共通の next step。実装完了後は `done` |
| `allApproved(spec)` | 3 フェーズすべて approved か |

`core/progress.ts` の `buildSpecProgress` が Specs / Tasks / Overview 共通の工程・状態・完了判定を持ちます。
完了は「実装タスク完了」だけでは確定せず、**現在の成果物に対する `impl-validation.md` の GO** が必要です。

Overview は `phaseStatus` と `approvals` から「承認待ちフェーズ」(`reviewPhases`)を求め、`Review pending` KPI とポートフォリオの絞り込みに使います。承認操作そのものは Specs ツリー / ゲート検証を経由します。

## 承認ゲート(`core/validation.ts`)

承認操作の直前に `validateArtifact(phase, content, language)` を実行します。

- **error** … 承認をブロック(モーダルでファイルを開ける)
- **warning** … 確認ダイアログで「Approve anyway」を選んだ場合のみ承認

チェック内容:

| 対象 | error | warning |
| --- | --- | --- |
| 共通 | ファイル無し / 40 文字未満 / `{{PLACEHOLDER}}` 残存 / トップレベル見出し無し | — |
| requirements | 番号付き `###` 見出しが無い(言語非依存) | 英語: `## Requirements` / `## Introduction` / `#### Acceptance Criteria` 欠落。英語以外: h2 / h4 が無い |
| design | 英語: `## Overview` と `## Architecture` or `## Components and Interfaces` が無い。英語以外: h2 が 2 未満 | 英語: `## File Structure Plan` / `## Boundary Commitments` / `## Requirements Traceability` 欠落。英語以外: h2 が 4 未満 |
| tasks | チェックボックスが 0 件 | タスク ID 重複 / `(P)` なのに `_Boundary:_` が無い / 葉タスクに `_Requirements:_` が無い |

設計判断: 見出し名の厳密チェックは英語のみ。翻訳済み spec(Kiro 互換)を不当にブロックしないため、他言語は構造(見出しレベル・数)で検査します。

## `tasks.md` のパース(`core/tasks.ts`)

対象形式の例:

```markdown
- [ ] 2. Source readers
  - [x] 2.1. Read CPU ticks and load average
    - _Boundary:_ `sources.py`
    - _Depends:_ 1.2
    - _Requirements:_ 1.1, 2.1
```

- チェックボックス行をタスクとして抽出(`- [ ]` / `* [x]`、ID は `1.2.3` 形式。無い場合は `line-N`)
- `(P)` を並列マーカーとして認識
- 直後のインデント付きメタ行から `_Boundary:_` / `_Depends:_` / `_Requirements:_` を読む
- インデントで親子関係を構築(`buildTaskTree`)、行番号を持つ
- チェック反転は**行番号指定**で `tasks.md` を書き換え(`toggleTaskInMarkdown` + 原子的書き込み)

## Steering / roadmap

- `readSteering`: `product.md` / `tech.md` / `structure.md` の有無
- `readRoadmap`: `## Specs (dependency order)` セクションから
  `- [ ] feature -- 説明. Dependencies: a, b` を読み、表示順と依存を抽出
- Specs ツリーの並びは既定で `created_at` の新しい順（なければ `updated_at` → spec.json のファイル時刻 → spec id 順）
- `ccSdd.specSort: "roadmap"` にすると roadmap があればその依存順に並べる。roadmap に載っていない spec は新しい順
- spec ノードには roadmap 上の依存 (`deps:`) を表示

## ビューのノード構成

### Specs(`ui/specTree.ts`)

| ノード | 内容 |
| --- | --- |
| `steering` | Steering の生成状況。未生成ならクリックで `/kiro-steering`。生成済みならクリックで product.md を開き、インラインの ⟳ ボタンで再実行できる |
| `roadmap` | roadmap.md を開く |
| `spec` | feature ノード。工程・現在の状態・実行状態・検証状態を description に表示 |
| `action` | 次にやることを1件だけ表示する「Next: ...」ノード。生成・レビュー・実装開始・実行を開く・検証開始・再検証・検証結果を開くを状態に応じて切り替える。完了後は表示しない |
| `stage` | Requirements / Design / Tasks / Implementation / Verification を 1→5 で表示。現在の工程は矢印、完了はチェック、承認待ちは時計、未着手は空の円で示す |
| `message` | 空状態・spec.json エラーなどの案内 |

色は使わず、アイコンの形と文言で状態を表します。他のツリーと同じ見た目を保つためです。
アクティブな spec は description の先頭に `active` が付き、Tasks / Sessions ビューとの対応が分かるようにしています。

### Tasks(`ui/taskTree.ts`)

選択中 Spec の作業台です。

| ノード | 内容 |
| --- | --- |
| `header` | 選択中 Spec 名と `Stage · State`。ビュー上部に対象を常時表示 |
| `implementation` | 実装タスクのツリー。`完了数/総数` を表示し、未完了の親タスクを展開できる |
| `completed` | 完了したルートタスク。初期状態は折りたたみ |
| `task` | 次の候補 / 実行中 / 待ち / 完了の状態。`next`、`running`、`waiting: 1.1` を表示 |
| `verification` | 検証状態（未実施・成功・失敗・stale・条件未定義など） |
| `verificationItem` | `impl-validation.md` に記録された検証項目と結果 |
| `verificationAction` | 検証開始 / 再検証 / 検証レポートを開く |

タスクの操作:

- 該当行を開く
- このタスクを実行する（`/kiro-impl <feature> <task-id>`）
- ここから残りを実行する（選択位置以降の未完了タスク）
- 実行中のタスクは対応する Run を開く
- 検証レポート / 検証開始 / 再検証

実行中の対象への重複開始は拡張側で防ぎ、有効な Run があればそれを開きます。
検証結果は `impl-validation.md` を正とし、tasks.md のチェックボックスや検証タスクの完了だけでは検証成功としません。

### StatusBar(`ui/statusBar.ts`)

アクティブ spec の `feature_name` と次アクションを表示。クリックで `cc-sdd: Select Active Spec`。

### RunsStatusBar(`ui/runsStatusBar.ts`)

run が動いている間だけ `N waiting · M running` を表示。クリックで
`cc-sdd: Show Runs Console`。`RunsConsole.onDidChange` のたびに更新します。
