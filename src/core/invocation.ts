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

const quote = (value: string): string => `"${value.replace(/(["\\$`])/g, '\\$1')}"`;

export const buildInvocation = (
  config: AgentConfig,
  skill: string,
  feature = '',
  args = '',
  validationReportPath?: string,
): Invocation => {
  const suffix = [feature, args]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => ` ${part}`)
    .join('');
  const invocation = config.agent === 'codex' ? `$${skill}${suffix}` : `/${skill}${suffix}`;
  const reportPath = validationReportPath ?? `.kiro/specs/${feature}/impl-validation.md`;
  const prompt =
    skill === 'kiro-validate-impl' && feature.trim()
      ? `${invocation}\n\nVS Code verification report contract:\n` +
        `Perform the skill's validation, then save the full evidence report to ${JSON.stringify(reportPath)}.\n` +
        'Include a standalone line exactly DECISION: GO, DECISION: NO-GO, or DECISION: MANUAL_VERIFY_REQUIRED, matching the evidence.\n' +
        'Record checks, commands, results, coverage, limitations, and unresolved blockers. Do not infer GO from tests alone.\n' +
        'If validation cannot be completed, record MANUAL_VERIFY_REQUIRED and the missing steps.\n' +
        'Finish any spec/artifact updates before writing the report last so its timestamp applies to the final artifacts.\n' +
        'A chat response or spec.json validation field alone does not persist verification for this extension. Preserve existing metadata; do not invent a completion phase.\n' +
        'If the report cannot be saved, explicitly say verification report was not saved; do not claim completion.'
      : invocation;

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
          .replace(/\$\{feature\}/g, feature)
          .replace(/\$\{args\}/g, args),
      };
    }
    default:
      return { prompt };
  }
};
