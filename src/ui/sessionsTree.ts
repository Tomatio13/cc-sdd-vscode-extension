import * as vscode from 'vscode';
import {
  formatTokenCount,
  formatWhen,
  type SessionActivityState,
  type SessionRecord,
} from '../core/sessions';

const SKILL_LABELS: Record<string, string> = {
  'kiro-impl': 'impl',
  'kiro-spec-requirements': 'requirements',
  'kiro-spec-design': 'design',
  'kiro-spec-tasks': 'tasks',
  'kiro-steering': 'steering',
  'kiro-discovery': 'discovery',
  'kiro-spec-init': 'new spec',
  'kiro-validate-impl': 'validation',
  'kiro-validate-gap': 'gap check',
  'kiro-validate-design': 'design check',
};

const skillLabel = (skill: string | undefined): string | undefined =>
  skill ? SKILL_LABELS[skill] ?? skill.replace(/^kiro-/, '') : undefined;

const sessionLabel = (session: SessionRecord): string => {
  const feature = session.feature?.trim();
  if (feature) {
    return feature;
  }
  const skill = skillLabel(session.skill);
  if (skill && session.title === `/${session.skill}`) {
    return skill;
  }
  return session.title || session.id.slice(0, 8);
};

const oneLine = (value: string, max = 180): string => {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** A transcript that stopped writing long ago is history, not a live run. */
const LIVE_WINDOW_MS = 15 * 60_000;

const activityState = (session: SessionRecord): SessionActivityState | undefined => {
  const state = session.activity?.state;
  if (state === undefined || state === 'stopped' || state === 'unknown') {
    return state;
  }
  return Date.now() - session.updatedAt < LIVE_WINDOW_MS ? state : 'stopped';
};

const activityLabel = (state: SessionActivityState): string => {
  switch (state) {
    case 'running':
      return 'Running';
    case 'waiting':
      return 'Waiting for input';
    case 'stopped':
      return 'No active run';
    default:
      return 'Unknown';
  }
};

const activityIcon = (state: SessionActivityState | undefined): vscode.ThemeIcon => {
  switch (state) {
    case 'running':
      return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
    case 'waiting':
      return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.yellow'));
    case 'stopped':
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
};

export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionRecord> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly load: () => Promise<SessionRecord[]>) {}

  refresh(): void {
    this.changed.fire();
  }

  getChildren(element?: SessionRecord): vscode.ProviderResult<SessionRecord[]> {
    if (element) {
      return [];
    }
    return this.load();
  }

  getTreeItem(session: SessionRecord): vscode.TreeItem {
    const label = sessionLabel(session);
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `session:${session.id}`;

    const tokens = session.usage
      ? session.usage.inputTokens + session.usage.outputTokens
      : 0;
    const state = activityState(session);
    const description: string[] = [];
    const skill = skillLabel(session.skill);
    if (skill && skill !== label) {
      description.push(skill);
    }
    if (state === 'running') {
      description.push('running');
    } else if (state === 'waiting') {
      description.push('waiting');
    }
    description.push(formatWhen(session.updatedAt));
    if (tokens > 0) {
      description.push(`${formatTokenCount(tokens)} tokens`);
    }
    item.description = description.join(' · ');

    item.iconPath = activityIcon(state);
    item.contextValue = 'session';

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${label}**\n\n`);
    if (session.title !== label) {
      tooltip.appendMarkdown(`Command: \`${session.title}\`\n\n`);
    }
    if (state) {
      tooltip.appendMarkdown(`Status: ${activityLabel(state)}\n\n`);
    }
    if (session.lastMessage) {
      tooltip.appendMarkdown(`> ${oneLine(session.lastMessage)}\n\n`);
    }

    const details: string[] = [];
    if (session.usage) {
      details.push(
        `- tokens: in ${formatTokenCount(session.usage.inputTokens)} · out ${formatTokenCount(
          session.usage.outputTokens,
        )} · cache read ${formatTokenCount(
          session.usage.cacheReadTokens,
        )} · cache write ${formatTokenCount(session.usage.cacheCreationTokens)}`,
      );
    }
    if (session.costUsd) {
      details.push(`- estimated cost: $${session.costUsd.toFixed(2)}`);
    }
    if (session.apiMs !== undefined) {
      details.push(
        `- duration: api ${(session.apiMs / 1000).toFixed(1)}s · tools ${(
          (session.toolMs ?? 0) / 1000
        ).toFixed(1)}s`,
      );
    }
    if (session.linesAdded !== undefined || session.linesRemoved !== undefined) {
      details.push(`- lines: +${session.linesAdded ?? 0} / -${session.linesRemoved ?? 0}`);
    }
    details.push(`- id: \`${session.id}\``);
    details.push(`- updated: ${new Date(session.updatedAt).toLocaleString()}`);
    if (session.cwd) {
      details.push(`- cwd: \`${session.cwd}\``);
    }
    details.push(`- file: \`${session.filePath}\``);
    tooltip.appendMarkdown(details.join('\n'));
    item.tooltip = tooltip;

    item.command = {
      command: 'ccSdd.previewSession',
      title: 'Preview Session',
      arguments: [session],
    };
    return item;
  }
}
