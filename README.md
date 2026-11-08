# cc-sdd Specs (VS Code extension)

<div align="center" style="margin-bottom: 1rem; font-size: 1.1rem;"><sub>
English | <a href="./README_ja.md">日本語</a>
</sub></div>

A VS Code workbench for [cc-sdd](https://github.com/gotalab/cc-sdd) specs. It reads `.kiro/specs/` directly and adds the missing UI layer: a spec explorer, approval gates, phase launchers, a task board, a headless **Runs** console, and resumable Claude Code sessions.

![cc-sdd Specs workbench: Specs, Tasks, and Sessions in the sidebar, with the cc-sdd Runs console streaming a /kiro-impl run](./assets/workbench.png)

<div align="center"><sub>Specs, Tasks, and Sessions on the left. The cc-sdd Runs console on the right streams tool calls, markdown output, and progress — permission prompts and <code>AskUserQuestion</code> appear as buttons in the same panel.</sub></div>

This is the **L1 + L2** implementation from [plan.md](https://github.com/gotalab/cc-sdd/blob/main/plan.md), plus the first slice of L3. Approval and state transitions stay in the extension; skill invocations go to the agent you already use — a terminal, the Claude Code for VS Code panel, or the built-in headless Runs console (Claude Agent SDK). The cc-sdd skills themselves come from the cc-sdd installer (`npx cc-sdd@latest --claude-skills`); the extension is the UI layer on top of them.

Architecture and internals (Japanese): **[docs/](./docs/README.md)**

## What it does

![Specs, Tasks, and Sessions: steering state, next actions, task progress, and resumable Claude Code sessions](./assets/spec-explorer.png)

- **Full flow entry points** — `Run Discovery` starts `/kiro-discovery` (the correct entry for new work); the spec tree shows Steering presence (click to generate) and roadmap.md order/dependencies when they exist.
- **Spec Explorer** — lists every `.kiro/specs/<feature>` with phase and approval status, ordered by roadmap when available.
- **Approval gates** — validates the artifact before recording an approval. Missing sections and unresolved `{{PLACEHOLDER}}` tokens block approval; softer issues require explicit confirmation.
- **Phase launcher** — runs `/kiro-spec-requirements`, `/kiro-spec-design`, `/kiro-spec-tasks`, and `/kiro-impl` in Claude Code, the Claude Code for VS Code panel, the headless Runs console, Codex, Copilot Chat, OpenCode, a custom command, or the clipboard.
- **Task board** — parses `tasks.md` checkboxes, `(P)` markers, `_Boundary:_`, `_Depends:_`, and `_Requirements:_`. Toggle a task from the tree without leaving the editor.
- **Sessions** — lists the Claude Code sessions recorded for the current workspace (titles come from the original `/kiro-…` prompt) with token totals and estimated cost, and resumes them in the Runs console or an interactive terminal. Sessions from other projects are never shown.
- **Run insights** — token usage (input / output / cache), per-turn metrics, permission denials, and a one-click trace export (`.kiro/runs/*.json`) for debugging.
- **Status bar** — shows the active spec and the next action.
- **Auto refresh** — watches the specs directory and reloads on changes.
- **Installer** — runs `npx cc-sdd@latest` with the integration you pick.
- **JSON Schema** — validates `.kiro/specs/*/spec.json` while you edit it.

## State model

The extension treats `spec.json` as the single source of truth and only writes approval state:

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

- Existing `phase` values (`initialized`, `requirements-generated`, `design-generated`, `tasks-generated`) are preserved.
- `ready_for_implementation` becomes `true` when all three approvals are `true`.
- Writes use a temporary file and rename, so an interrupted save does not truncate `spec.json`.

## Commands

| Command | Description |
| --- | --- |
| `cc-sdd: Refresh` | Reload specs and tasks. |
| `cc-sdd: Run Discovery` | Describe the work and launch `/kiro-discovery` (the flow entry point). |
| `cc-sdd: Run Steering` | Launch `/kiro-steering` (also offered from the Steering node when missing). |
| `cc-sdd: Validate against Codebase (Gap)` | Launch `/kiro-validate-gap` for the active/selected spec (right-click a spec). |
| `cc-sdd: Validate Design` | Launch `/kiro-validate-design` (right-click a spec). |
| `cc-sdd: New Spec` | Ask for a description and launch `/kiro-spec-init`. |
| `cc-sdd: Install Skills` | Pick an agent integration and run `npx cc-sdd@latest`. |
| `cc-sdd: Select Active Spec` | Choose which spec the Tasks view follows. |
| `cc-sdd: Show Spec Status` | Open a Markdown summary of phases and approvals. |
| Approve / Revoke Phase | Context actions on a phase node. |
| Run Phase | Context action on a missing/draft/generated phase. |
| Run Implementation | Context action on a ready spec. |
| Toggle Task | Flip a `tasks.md` checkbox from the tree. |

Internal commands (`ccSdd.openArtifact`, `ccSdd.openTask`, and so on) are hidden from the Command Palette and used by the tree views.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `ccSdd.kiroDir` | `.kiro` | Directory containing `specs/` and `settings/`. |
| `ccSdd.agent` | `claude` | `claude`, `claude-vscode`, `claude-console`, `codex`, `copilot`, `opencode`, `custom`, or `clipboard`. |
| `ccSdd.customCommand` | empty | Terminal template for `custom`. Placeholders: `${prompt}`, `${skill}`, `${feature}`. |
| `ccSdd.consolePermissionMode` | `default` | Preselected permission mode for `claude-console` runs (`default` / `acceptEdits` / `bypassPermissions` / `plan`). `default` asks in the Runs console. A picker still asks per run. |
| `ccSdd.claudePath` | `claude` | Path to the claude CLI used for headless runs. |
| `ccSdd.installLanguage` | empty | Optional `--lang` value for the installer. |
| `ccSdd.autoRefresh` | `true` | Watch the specs directory for changes. |

### Agent invocation

| Agent | What the extension does |
| --- | --- |
| `claude` | Opens a terminal and runs `claude "/kiro-… <feature>"`. |
| `claude-vscode` | Prefills the prompt in the Claude Code for VS Code panel. It follows the extension's preferred location (sidebar or editor tab). Press Enter to run it. |
| `claude-console` | Runs headless via the Claude Agent SDK and streams progress in the **cc-sdd Runs** console. Permission requests and `AskUserQuestion` prompts appear as buttons inside the console, so requirements/design questions can be answered without leaving VS Code. |
| `codex` | Opens a terminal and runs `codex "$kiro-… <feature>"`. |
| `copilot` | Prefills the prompt in Copilot Chat (`workbench.action.chat.open`). |
| `opencode` | Opens a terminal and runs `opencode run "/kiro-… <feature>"`. |
| `custom` | Runs the `ccSdd.customCommand` template. |
| `clipboard` | Copies the prompt. Useful when the agent runs elsewhere. |

If Copilot Chat cannot be opened, the prompt is copied to the clipboard instead. The same fallback applies when the `claude-vscode` panel cannot be reached.

### Sessions

The **Sessions** view reads `~/.claude/projects/<encoded-workspace>/*.jsonl`, so only sessions whose recorded `cwd` matches the current workspace are listed (newest first). Hovering shows the last assistant message to jog your memory; clicking a session opens a **read-only preview** of the full transcript in the Runs console. The same card has a continuation input and a permission-mode selector: **Resume in console** continues the session **in place** (no extra dialogs), and **Terminal** launches `claude --resume`. The context-menu action also offers:

- **Resume in Runs console** — continues the same session headlessly (Claude Agent SDK `resume`), with the usual permission picker. The stored transcript is replayed as a **Session history** block above the live output.
- **Resume in terminal** — runs `claude --resume <session-id>` interactively.
- **Open raw transcript** / **Copy session id** — for inspection or scripting.

## Workspace scope

The MVP follows the first workspace folder. Use `ccSdd.kiroDir` to point at a different specs root inside that folder. Multi-root support is a Phase 2 candidate.

## Run from source

```bash
cd tools/cc-sdd-vscode
npm install
npm run build
npm test
```

Then open `tools/cc-sdd-vscode` as the workspace folder in VS Code and press <kbd>F5</kbd>. The included `.vscode/launch.json` starts an Extension Development Host.

To try it against a project, open a folder that contains `.kiro/specs/<feature>/spec.json`. The repository itself has `photo-albums-en` and `vercel-ai-chatui-research-agent-ja` under `.kiro/specs/` that you can use as fixtures.

Package a VSIX with:

```bash
npm run package
```

## Design boundaries

- **Generation belongs to the agent.** The extension never calls a model. It invokes the skill and lets the host own tools, permissions, and model choice.
- **Approval belongs to the extension.** The gate validation is deterministic and local.
- **The storage format is shared.** Kiro, Claude Code, Codex, Copilot, and the other cc-sdd hosts can keep using the same `.kiro/specs` directory.
- **VS Code compatible.** The extension uses public VS Code APIs plus a guarded built-in command for Copilot Chat, so it can also run in Kiro, Cursor, Windsurf, and VSCodium via Open VSX.

## Not yet implemented

Phase 3 and later in [plan.md](https://github.com/gotalab/cc-sdd/blob/main/plan.md): headless CLI runners with streaming progress (Claude Code / Codex / OpenCode adapters), subagent execution control inside the extension, and the Code OSS fork evaluation.

## License

MIT
