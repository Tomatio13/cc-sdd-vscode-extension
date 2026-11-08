# cc-sdd Specs

A VS Code workbench for [cc-sdd](https://github.com/gotalab/cc-sdd) specs. It reads `.kiro/specs/` directly and adds the missing UI layer for spec-driven development.

- **Specs, Tasks, Sessions** — track phase approvals, next actions, task progress, steering context, and resumable Claude Code sessions from the sidebar.
- **Runs** — stream tool calls, markdown output, and progress in one panel. Answer permission prompts and `AskUserQuestion` there.
- **Overview** — see waiting workers, live runs, today's spend, and spec progress in one board.
- **Approval gates** — validate artifacts before recording approvals. Missing sections and unresolved placeholders block approval.
- **Phase launcher** — run cc-sdd phases in Claude Code, the Claude Code for VS Code panel, the headless Runs console, Codex, Copilot Chat, OpenCode, a custom command, or the clipboard.

## Requirements

- VS Code 1.90 or higher

## Docs

See the [documentation](https://github.com/Tomatio13/cc-sdd-vscode-extension/blob/main/docs/README.md) for architecture, state model, commands, and development notes.
