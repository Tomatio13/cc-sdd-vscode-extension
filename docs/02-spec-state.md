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
| `allApproved(spec)` | 3 フェーズすべて approved か |

Overview ボードは `phaseStatus` と `approvals` から「承認待ちフェーズ」(`reviewPhases`)を求め、`Needs you` の承認カードとして表示します。承認操作そのものは Specs ツリー / ゲート検証を経由します。

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
- Specs ツリーは roadmap があればその順に並べ、spec ノードに `deps:` を表示

## ビューのノード構成

### Specs(`ui/specTree.ts`)

| ノード | 内容 |
| --- | --- |
| `steering` | Steering の生成状況。未生成ならクリックで `/kiro-steering` |
| `roadmap` | roadmap.md を開く |
| `spec` | feature ノード(フェーズ・承認数・次アクション・依存を description に表示) |
| `state` | 実装進捗 / 承認待ち / 完了の要約 |
| `action` | 「Continue /kiro-impl」「Next: approve tasks」などクリック可能な次アクション |
| `phase` | Requirements / Design / Tasks。状態とタスク進捗。実行・承認・取消のコマンドを持つ |
| `task` | 次の未完了タスク(tasks.md の行へジャンプ) |
| `message` | 空状態・spec.json エラーなどの案内 |

### Tasks(`ui/taskTree.ts`)

`tasks.md` のツリー表示。`contextValue` は `task-todo` / `task-done`、`(P)` と `boundary` をバッジ表示。
クリックで該当行を開き、インラインのチェックで完了を切り替えます。

### StatusBar(`ui/statusBar.ts`)

アクティブ spec の `feature_name` と次アクションを表示。クリックで `cc-sdd: Select Active Spec`。

### OverviewStatusBar(`ui/overviewStatusBar.ts`)

run が動いている間だけ `N waiting · M running` を表示。クリックで
`cc-sdd: Open Overview`。`RunsConsole.onDidChange` のたびに更新します。
