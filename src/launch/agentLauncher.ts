import * as vscode from 'vscode';
import {
  buildInvocation,
  type AgentConfig,
} from '../core/invocation';

export type { AgentConfig, AgentKind, Invocation } from '../core/invocation';

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

export const runSkill = async (
  config: AgentConfig,
  workspaceRoot: string,
  feature: string,
  skill: string,
): Promise<void> => {
  const invocation = buildInvocation(config, skill, feature);

  if (config.agent === 'copilot') {
    await openCopilotChat(invocation.prompt);
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
