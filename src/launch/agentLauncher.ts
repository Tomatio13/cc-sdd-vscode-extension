import * as vscode from 'vscode';
import {
  buildInvocation,
  type AgentConfig,
} from '../core/invocation';

export type { AgentConfig, AgentKind, Invocation } from '../core/invocation';

export interface ConsoleLaunchMeta {
  skill: string;
  feature: string;
}

export interface RunSkillOptions {
  // Present only when the host wires the Runs console; agent 'claude-console' requires it.
  consoleLauncher?: (prompt: string, meta: ConsoleLaunchMeta) => Promise<void>;
  /** Extra arguments appended after the feature (for example task IDs). */
  args?: string;
}

const openCopilotChat = async (prompt: string): Promise<void> => {
  try {
    await vscode.commands.executeCommand('workbench.action.chat.open', {
      query: prompt,
      isPartialQuery: true,
    });
  } catch {
    await vscode.env.clipboard.writeText(prompt);
    void vscode.window.showWarningMessage(
      `Could not open Copilot Chat. The prompt was copied to the clipboard: ${prompt}`,
    );
  }
};

// Delivers the prompt to the Claude Code for VS Code panel. The prompt is
// pre-filled in the composer — not sent — so the user presses Enter to run it.
const sendToClaudeVscodePanel = async (prompt: string): Promise<void> => {
  try {
    await vscode.commands.executeCommand(
      'claude-vscode.editor.open',
      undefined, // sessionId: start a new conversation
      prompt, // initialPrompt
      undefined, // viewColumn
      undefined, // new session group
      undefined, // fullEditor
      { programmatic: 'honor-preferred-location' },
    );
  } catch {
    await openClaudeVscodeViaUri(prompt);
  }
};

const openClaudeVscodeViaUri = async (prompt: string): Promise<void> => {
  try {
    await vscode.env.openExternal(
      vscode.Uri.parse(
        `vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(prompt)}`,
      ),
    );
  } catch {
    await vscode.env.clipboard.writeText(prompt);
    void vscode.window.showWarningMessage(
      `Could not reach Claude Code for VS Code. The prompt was copied to the clipboard: ${prompt}`,
    );
  }
};

export const runSkill = async (
  config: AgentConfig,
  workspaceRoot: string,
  feature: string,
  skill: string,
  options: RunSkillOptions = {},
): Promise<void> => {
  const invocation = buildInvocation(config, skill, feature, options.args);

  if (config.agent === 'copilot') {
    await openCopilotChat(invocation.prompt);
    return;
  }

  if (config.agent === 'claude-vscode') {
    await sendToClaudeVscodePanel(invocation.prompt);
    return;
  }

  if (config.agent === 'claude-console') {
    if (!options.consoleLauncher) {
      void vscode.window.showWarningMessage('cc-sdd: the Runs console is not available.');
      return;
    }
    await options.consoleLauncher(invocation.prompt, { skill, feature });
    return;
  }

  if (config.agent === 'clipboard' || !invocation.command) {
    await vscode.env.clipboard.writeText(invocation.prompt);
    void vscode.window.showInformationMessage(
      `Prompt copied to the clipboard: ${invocation.prompt}`,
    );
    return;
  }

  const terminal = vscode.window.createTerminal({
    name: `cc-sdd: ${feature || skill}`,
    cwd: workspaceRoot,
  });
  terminal.show();
  terminal.sendText(invocation.command, true);
};

export const runInstall = (
  workspaceRoot: string,
  args: string,
  language: string,
): void => {
  const command = `npx cc-sdd@latest ${args}${language ? ` --lang ${language}` : ''}`.trim();
  const terminal = vscode.window.createTerminal({
    name: 'cc-sdd install',
    cwd: workspaceRoot,
  });
  terminal.show();
  terminal.sendText(command, true);
};
