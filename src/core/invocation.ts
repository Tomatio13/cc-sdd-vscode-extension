export type AgentKind =
  | 'claude'
  | 'claude-vscode'
  | 'claude-console'
  | 'codex'
  | 'copilot'
  | 'opencode'
  | 'custom'
  | 'clipboard';

export interface AgentConfig {
  agent: AgentKind;
  customCommand: string;
}

export interface Invocation {
  prompt: string;
  command?: string;
}

const quote = (value: string): string =>
  `"${value.replace(/(["\\$`])/g, '\\$1')}"`;

export const buildInvocation = (
  config: AgentConfig,
  skill: string,
  feature = '',
): Invocation => {
  const suffix = feature ? ` ${feature}` : '';
  const prompt = config.agent === 'codex' ? `$${skill}${suffix}` : `/${skill}${suffix}`;

  switch (config.agent) {
    case 'claude':
      return { prompt, command: `claude ${quote(prompt)}` };
    case 'claude-vscode':
      // agentLauncher delivers the prompt to the Claude Code for VS Code panel.
      return { prompt };
    case 'codex':
      return { prompt, command: `codex ${quote(prompt)}` };
    case 'opencode':
      return { prompt, command: `opencode run ${quote(prompt)}` };
    case 'custom': {
      const template = config.customCommand.trim();
      if (!template) {
        return { prompt };
      }
      return {
        prompt,
        command: template
          .replace(/\$\{prompt\}/g, prompt)
          .replace(/\$\{skill\}/g, skill)
          .replace(/\$\{feature\}/g, feature),
      };
    }
    default:
      return { prompt };
  }
};
