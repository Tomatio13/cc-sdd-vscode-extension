# cc-sdd Specs

A VS Code workbench for [cc-sdd](https://github.com/gotalab/cc-sdd) specs. It reads `.kiro/specs/` directly and adds the missing UI layer for spec-driven development.

- **Specs, Tasks, Sessions** — select a spec, follow its Requirements → Design → Tasks → Implementation → Verification pipeline, run individual or remaining tasks, and resume the matching sessions.
- **Runs** — stream tool calls, markdown output, and progress in one panel. Answer permission prompts and `AskUserQuestion` there.
- **Overview** — A repository progress snapshot for reporting: total / in-progress / review / verification / attention / verified counts, recorded concerns, spec stages and implementation progress, and collapsed verified completions. Copy progress summary exports the current snapshot. Approvals and execution remain in Specs.
- **Approval gates** — validate artifacts before recording approvals. Missing sections and unresolved placeholders block approval.
- **Phase launcher** — run cc-sdd phases in Claude Code, the Claude Code for VS Code panel, the headless Runs console, Codex, Copilot Chat, OpenCode, a custom command, or the clipboard.

Specs uses a theme-aware sidebar timeline with connected stage markers, implementation task progress, approval/run actions, and the five most recent runs in this window. Implementation tasks are embedded under each spec’s Implementation stage, with completed tasks folded away. The standalone Tasks view has been removed; Sessions uses the same monochrome timeline style: active sessions first, then history ordered by last activity, with details and resume actions on expansion. Expansion and reading position are preserved on refresh.

Verification launches explicitly request an `impl-validation.md` evidence report with a `DECISION` line. A `spec.json` validation field alone remains unconfirmed and offers revalidation; a finished run alone does not mark a spec complete.

Runs uses one editor tab per run, titled with its spec and stage. Reopening a run or session reuses its tab. Closing a tab keeps the run available and does not cancel execution; use Cancel to stop it. `cc-sdd: Show Runs Console` opens a run picker with waiting runs first (or the only run directly). Session history also opens in its own tab.

## Requirements

- VS Code 1.90 or higher

## Docs

See the [documentation](https://github.com/Tomatio13/cc-sdd-vscode-extension/blob/main/docs/README.md) for architecture, state model, commands, and development notes.
