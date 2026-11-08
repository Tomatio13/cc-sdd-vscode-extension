# 開発・ビルド・リリース

## 前提環境

- Node.js(CI は 24)
- VS Code `^1.90.0`
- `claude` CLI(`claude-console` / Sessions の再開を使う場合。ログイン済みであること)
- npm

## セットアップ

```bash
npm install
npm test            # vitest(94 tests)
npm run check       # 型チェック
npm run package     # VSIX 作成
```

拡張の動作確認は VS Code で **F5**(`.vscode/launch.json` の「Run cc-sdd Extension」)。Extension Development Host が起動します。`.kiro/specs` を含むフォルダを開き、`ccSdd.agent` を切り替えて試します。

## スクリプト

| コマンド | 内容 |
| --- | --- |
| `npm run build` | `out/` を削除して **esbuild で単一バンドル**(`out/extension.js`) |
| `npm run watch` | 同上を watch |
| `npm run check` | `tsc --noEmit`(型チェックのみ。emit しない) |
| `npm test` | vitest(1 回) |
| `npm run test:watch` | vitest(watch) |
| `npm run package` | `npm run build` + `vsce package --no-dependencies` |

### バンドル構成(esbuild)

```bash
esbuild src/extension.ts --bundle --platform=node --format=cjs \
  --external:vscode --outfile=out/extension.js \
  "--define:import.meta.url=__filename"
```

理由:

- Claude Agent SDK を実行時依存にしない(`vsce package --no-dependencies` を維持)
- SDK は ESM で `createRequire(import.meta.url)` を使うため、CJS バンドルでは
  `--define:import.meta.url=__filename` で置換する(これが無いと起動時に落ちる)
- `out/` を毎回削除するので、古い tsc 出力が VSIX に混入しない

`tsc` は型チェック専用(`check`)です。

## テスト方針

- `src/core/` は **vscode 非依存**の純粋ロジックなので、そのまま vitest でテスト
  - `spec` / `tasks` / `validation` / `repository`(一時ディレクトリで FS を実際に使う)/ `sessions` / `roadmap` / `overview`
  - `overview` は run 状態の列分類、セッションの重複排除、承認カード、当日コストの集計を検証
  - `sessions` はトランスクリプト末尾からの `activity` 判定(停止マーカー / `AskUserQuestion` / 60 秒フォールバック)も検証
- `run/claudeRunner.ts` はイベント変換(`eventsFromClaudeLine`)・履歴変換・質問抽出・実行パス解決をテスト
- Webview / Tree の見た目は自動テスト対象外。開発時は Webview の HTML を生成してヘッドレスブラウザで
  レンダリング確認(過去にレイアウト崩れ・エスケープ事故を検出)

## パッケージ

- `.vscodeignore` で `src/` `test/` `docs/` `assets/` `README.md` `README_ja.md` `*.ts` `node_modules/` などを除外
- 成果物: `cc-sdd-vscode-<version>.vsix`(実行に必要な `out/` `media/` `schemas/` `package.json` と `README.marketplace.md` のみ)
- Marketplace 用 README は `README.marketplace.md`(画像なし)。GitHub 用 `README.md` / `README_ja.md` は画像あり、VSIX には含めない
- `package.json` の `private: true` は Marketplace 公開を前提にしないため(GitHub Releases 配布)

## CI / リリース

### CI(`.github/workflows/ci.yml`)

`main` push / PR / 手動。`npm ci` → `check` → `test` → `build`。

### Release(`.github/workflows/release.yml`)

**タグ `v*` の push** で起動:

1. タグ名と `package.json` の `version` が一致するか検証(不一致は失敗)
2. `npm ci` → `check` → `test` → `build` → `package`
3. `gh release create vX.Y.Z cc-sdd-vscode-X.Y.Z.vsix --generate-notes`
   (既存リリースなら `gh release upload --clobber` にフォールバック)

リリース手順:

```bash
npm version minor        # 例: 0.8.1 → 0.9.0(package.json/lock を更新してコミット・タグ作成)
git push origin main
git push origin v0.9.0   # これで Release まで自動
```

## 既知の落とし穴

| 症状 | 原因 / 対策 |
| --- | --- |
| VSIX に古いコードが入る | `vsce package` は `out/` をそのまま梱包する。**必ず build してから package**(現在の script は build を含む) |
| Webview が真っ白 / `Invalid or unexpected token` | TypeScript の**テンプレートリテラル内**の JS で `\n` / `\s` / `\d` が TS に解釈される。Webview 用コードでは `\\n` のように二重エスケープする |
| 起動直後に `createRequire` で落ちる | SDK(ESM)を CJS バンドルする際の `import.meta.url`。esbuild の `--define:import.meta.url=__filename` を外さない |
| 権限 UI が出ない | `permissionMode: 'bypassPermissions'` では SDK が `canUseTool` を呼ばない(仕様) |
| 実行ログが `session …` の連続になる | `system` イベントは `subtype === 'init'` 以外(hook 等)を無視する。init 判定を外すとノイズが溢れる |
| 更新が重い | 履歴を `state` スナップショットに含めない。`history` は別メッセージで 1 回だけ送る。更新は 80ms で合流 |
| Overview の Running が完了後も残る | セッションの mtime だけを見ると、`cost-state` 等のメタ行で更新されるため誤判定する。`readSessionTailInfo()` の `activity`(停止マーカー / `tool_use` / 60 秒フォールバック)を使う |
| Overview が重い | セッション一覧は 5 秒キャッシュ。runs は `getRuns()` のスナップショット(`history` なし)。更新は 350ms デバウンス |
| Sessions が空 | ワークスペースのパスと `~/.claude/projects/<encoded>` が一致しているか確認。`cwd` 不一致のセッションは意図的に除外 |
| resume が高い | 履歴全体を送るため。プレビュー(課金なし)で確認してから再開する |

## 拡張の追加手順(例)

### 新しいエージェントを足す

1. `core/invocation.ts` の `AgentKind` と `buildInvocation` に追加
2. `launch/agentLauncher.ts` の `runSkill` に分岐を追加
3. `package.json` の `ccSdd.agent` の `enum` / `enumDescriptions` に追加
4. `test/invocation.test.ts` にプロンプト生成のテストを追加
5. README(英日)の表を更新

### 新しいビューを足す

1. `package.json` の `contributes.views.ccSdd` に追加
2. `src/ui/<name>Tree.ts` に `TreeDataProvider` を実装
3. `extension.ts` で `registerTreeDataProvider`、必要なら `refresh()` に組み込む
4. `menus`(`view/title` / `view/item/context`)にコマンドを追加

### Runs の事後アクションを増やす

`RunsConsoleOptions.getPhaseActions()`(`src/extension.ts` 内)が返す `PhaseActions` を拡張し、
`ui/runsConsole.ts` の `renderActions()` にボタンを追加します。

### Overview の指標 / カードを増やす

1. `core/overview.ts` の `OverviewModel` / `buildOverview()` に入力と集計を追加
2. `test/overview.test.ts` に純粋ロジックのテストを追加
3. `ui/overviewPanel.ts` の `renderKpi()` / `renderCard()` / `renderSpec()` に表示を追加
4. クリック操作が必要なら Webview メッセージ(`OverviewMessage`)と `OverviewPanelOptions` を追加

### README を更新する

- GitHub 用: `README.md` / `README_ja.md`。キャプチャは `assets/` に置き、VSIX には含めない
- Marketplace 用: `README.marketplace.md`。画像なしの短い説明を保つ
- `npm run package` で VSIX を作り直す

## デバッグ

- **Runs コンソール**: コマンド `cc-sdd: Show Runs Console` で再表示。Webview の DOM はコマンドパレットの
  `Developer: Open Webview Developer Tools` で調査可能
- **Overview**: コマンド `cc-sdd: Open Overview`。表示が古い場合は `Refresh` を押すか、一度パネルを隠して再表示する(可視時のみ自動更新)
- **CLI 自体の確認**: ターミナルで `claude -p "Reply OK" --output-format stream-json --verbose` を実行
- **実行ログ**: `claude-console` の失敗はコンソールの `Run failed` サマリに表示される
  (バイナリが見つからない場合は `ccSdd.claudePath` を確認)
