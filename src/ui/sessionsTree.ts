import * as vscode from 'vscode';
import {
  formatTokenCount,
  formatWhen,
  type SessionActivityState,
  type SessionRecord,
} from '../core/sessions';
import type { SpecRecord } from '../core/repository';
import type { RunState } from '../run/claudeRunner';

const SKILL_STAGES: Record<string, string> = {
  'kiro-impl': 'Implementation',
  'kiro-spec-requirements': 'Requirements',
  'kiro-spec-design': 'Design',
  'kiro-spec-tasks': 'Task planning',
  'kiro-steering': 'Steering',
  'kiro-discovery': 'Discovery',
  'kiro-spec-init': 'Spec init',
  'kiro-validate-impl': 'Verification',
  'kiro-validate-gap': 'Gap check',
  'kiro-validate-design': 'Design check',
};

const stageLabel = (skill: string | undefined): string => {
  if (!skill) {
    return 'Session';
  }
  return SKILL_STAGES[skill] ?? skill.replace(/^kiro-/, '');
};

/** A transcript is only treated as active when it is recent or a run is live. */
const ACTIVE_WINDOW_MS = 15 * 60_000;

type SessionViewState = 'running' | 'waiting' | 'stale' | 'stopped' | 'unknown';

const oneLine = (value: string, max = 90): string => {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const recordedActivityState = (session: SessionRecord): SessionActivityState | undefined =>
  session.activity?.state;

const isActiveViewState = (state: SessionViewState): boolean =>
  state === 'running' || state === 'waiting';

const activityLabel = (state: SessionViewState): string => {
  switch (state) {
    case 'running':
      return 'Running';
    case 'waiting':
      return 'Waiting for input';
    case 'stale':
      return 'Not confirmed active in this window';
    case 'stopped':
      return 'No active run';
    case 'unknown':
      return 'Unknown';
  }
};

const activityIcon = (state: SessionViewState): vscode.ThemeIcon => {
  switch (state) {
    case 'running':
      return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
    case 'waiting':
      return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.yellow'));
    case 'stale':
      return new vscode.ThemeIcon('question');
    case 'stopped':
    case 'unknown':
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
};

export type SessionTreeNode =
  | { kind: 'scope'; all: boolean; label?: string }
  | { kind: 'other'; count: number }
  | { kind: 'group'; group: 'active' | 'history'; count: number; sessions: SessionRecord[] }
  | {
      kind: 'session';
      session: SessionRecord;
      specLabel?: string;
      stage: string;
      viewState: SessionViewState;
      active: boolean;
      hasRun: boolean;
      showSpec: boolean;
    }
  | { kind: 'message'; label: string; description?: string };

export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionTreeNode> {
  private readonly changed = new vscode.EventEmitter<void>();

  private activeSpecId: string | undefined;
  private allSpecs = false;
  private labels = new Map<string, string>();
  private activeRunSessionIds = new Set<string>();

  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly load: () => Promise<SessionRecord[]>,
    private readonly loadSpecs: () => Promise<SpecRecord[]>,
    private readonly getRuns: () => RunState[],
  ) {}

  setActive(record: SpecRecord | undefined): void {
    const nextId = record?.id;
    const changed = this.activeSpecId !== nextId;
    this.activeSpecId = nextId;
    if (changed) {
      this.allSpecs = nextId === undefined;
    }
    this.changed.fire();
  }

  toggleScope(): void {
    if (!this.activeSpecId) {
      return;
    }
    this.allSpecs = !this.allSpecs;
    this.changed.fire();
  }

  refresh(): void {
    this.changed.fire();
  }

  async getChildren(element?: SessionTreeNode): Promise<SessionTreeNode[]> {
    if (!element) {
      return this.buildRoot();
    }
    if (element.kind === 'group') {
      return element.sessions.map((session) =>
        this.toSessionNode(session, element.group === 'active', !this.activeSpecId || this.allSpecs),
      );
    }
    return [];
  }

  getTreeItem(node: SessionTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'scope':
        return this.scopeItem(node);
      case 'other':
        return this.otherItem(node);
      case 'group':
        return this.groupItem(node);
      case 'session':
        return this.sessionItem(node);
      case 'message': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.description = node.description;
        item.contextValue = 'message';
        return item;
      }
    }
  }

  private async buildRoot(): Promise<SessionTreeNode[]> {
    const [sessions, specs] = await Promise.all([this.load(), this.loadSpecs()]);
    const labels = new Map(
      specs.map((record) => [record.id, record.spec?.feature_name?.trim() || record.id]),
    );
    this.labels = labels;
    this.activeRunSessionIds = new Set(
      this.getRuns()
        .filter(
          (run) =>
            run.sessionId !== undefined &&
            (run.pending !== undefined || run.status === 'running'),
        )
        .map((run) => run.sessionId as string),
    );
    const all = this.allSpecs || !this.activeSpecId;
    const selectedLabel = this.activeSpecId ? labels.get(this.activeSpecId) ?? this.activeSpecId : undefined;
    const nodes: SessionTreeNode[] = [
      { kind: 'scope', all, label: selectedLabel },
    ];

    const activeSessions = sessions.filter((session) =>
      isActiveViewState(this.viewStateFor(session)),
    );
    if (!all && this.activeSpecId) {
      const otherActive = activeSessions.filter(
        (session) => session.feature !== this.activeSpecId,
      );
      if (otherActive.length > 0) {
        nodes.push({ kind: 'other', count: otherActive.length });
      }
    }

    const visible = all
      ? sessions
      : this.activeSpecId
        ? sessions.filter((session) => session.feature === this.activeSpecId)
        : sessions;

    if (visible.length === 0) {
      nodes.push({
        kind: 'message',
        label: all ? 'No sessions found' : 'No sessions for this spec',
        description: 'Runs started with claude-console are recorded here.',
      });
      return nodes;
    }

    const active = visible.filter((session) => isActiveViewState(this.viewStateFor(session)));
    const history = visible.filter((session) => !isActiveViewState(this.viewStateFor(session)));

    if (active.length > 0) {
      nodes.push({ kind: 'group', group: 'active', count: active.length, sessions: active });
    }
    if (history.length > 0) {
      nodes.push({ kind: 'group', group: 'history', count: history.length, sessions: history });
    }
    return nodes;
  }

  private viewStateFor(session: SessionRecord): SessionViewState {
    const recorded = recordedActivityState(session);
    if (recorded !== 'running' && recorded !== 'waiting') {
      return recorded ?? 'unknown';
    }
    if (this.activeRunSessionIds.has(session.id)) {
      return recorded;
    }
    return Date.now() - session.updatedAt <= ACTIVE_WINDOW_MS ? recorded : 'stale';
  }

  private toSessionNode(
    session: SessionRecord,
    active: boolean,
    showSpec: boolean,
  ): SessionTreeNode {
    const hasRun = this.getRuns().some((run) => run.sessionId === session.id);
    const viewState = this.viewStateFor(session);
    return {
      kind: 'session',
      session,
      specLabel: session.feature
        ? this.labels.get(session.feature) ?? session.feature
        : undefined,
      stage: stageLabel(session.skill),
      viewState,
      active,
      hasRun,
      showSpec,
    };
  }

  private scopeItem(node: Extract<SessionTreeNode, { kind: 'scope' }>): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.all ? 'Showing all specs' : `Showing: ${node.label ?? 'selected spec'}`,
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = 'sessions:scope';
    item.contextValue = 'sessions-scope';
    item.iconPath = new vscode.ThemeIcon('filter');
    item.description = node.all ? 'all specs' : 'selected spec';
    item.tooltip = node.all
      ? 'Showing sessions from every spec. Click to return to the selected spec.'
      : 'Showing sessions for the selected spec. Click to show all specs.';
    item.command = {
      command: 'ccSdd.toggleSessionScope',
      title: 'Toggle Sessions Scope',
    };
    return item;
  }

  private otherItem(node: Extract<SessionTreeNode, { kind: 'other' }>): vscode.TreeItem {
    const item = new vscode.TreeItem(
      `${node.count} active in other specs`,
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = 'sessions:other-active';
    item.contextValue = 'sessions-other';
    item.iconPath = new vscode.ThemeIcon('info');
    item.description = 'Show all sessions';
    item.command = {
      command: 'ccSdd.toggleSessionScope',
      title: 'Show All Sessions',
    };
    item.tooltip = 'There are active or waiting sessions outside the selected spec.';
    return item;
  }

  private groupItem(node: Extract<SessionTreeNode, { kind: 'group' }>): vscode.TreeItem {
    const active = node.group === 'active';
    const item = new vscode.TreeItem(
      active ? 'Active & waiting' : 'Past sessions',
      vscode.TreeItemCollapsibleState.Expanded,
    );
    item.id = `sessions:${node.group}`;
    item.contextValue = `sessions-group-${node.group}`;
    item.description = `${node.count} session${node.count === 1 ? '' : 's'}`;
    item.iconPath = new vscode.ThemeIcon(active ? 'pulse' : 'history');
    item.tooltip = active
      ? 'Sessions whose transcript tail says they are running or waiting for input.'
      : 'Stopped or unknown sessions. Resume or inspect from here.';
    return item;
  }

  private sessionItem(node: Extract<SessionTreeNode, { kind: 'session' }>): vscode.TreeItem {
    const { session, specLabel, stage, active, hasRun, showSpec, viewState } = node;
    const item = new vscode.TreeItem(stage, vscode.TreeItemCollapsibleState.None);
    item.id = `session:${session.id}`;
    item.contextValue = active
      ? hasRun
        ? 'session-active-run'
        : 'session-active'
      : 'session-history';
    const description: string[] = [];
    if (showSpec) {
      description.push(specLabel ?? 'Unlinked');
    }
    if (active) {
      description.push(viewState === 'waiting' ? 'waiting' : 'running');
    } else if (viewState === 'stale') {
      description.push('unverified');
    }
    description.push(formatWhen(session.updatedAt));
    const tokens = session.usage
      ? session.usage.inputTokens + session.usage.outputTokens
      : 0;
    if (tokens > 0) {
      description.push(`${formatTokenCount(tokens)} tokens`);
    }
    item.description = description.join(' · ');
    item.iconPath = activityIcon(viewState);

    const tooltip = new vscode.MarkdownString();
    tooltip.supportThemeIcons = true;
    tooltip.appendMarkdown(`**${stage}**\n\n`);
    tooltip.appendMarkdown(`Spec: ${specLabel ?? 'unlinked'}\n\n`);
    tooltip.appendMarkdown(`Status: ${activityLabel(viewState)}\n\n`);
    if (viewState === 'stale') {
      tooltip.appendMarkdown(
        `Recorded state: ${session.activity?.state ?? 'unknown'} (not confirmed active)\n\n`,
      );
    }
    if (session.lastMessage) {
      tooltip.appendMarkdown(`> ${oneLine(session.lastMessage, 240)}\n\n`);
    }
    tooltip.appendMarkdown(`Started: ${new Date(session.startedAt ?? session.updatedAt).toLocaleString()}\n\n`);
    tooltip.appendMarkdown(`Last activity: ${new Date(session.updatedAt).toLocaleString()}\n\n`);
    if (session.usage) {
      const tokens = session.usage.inputTokens + session.usage.outputTokens;
      tooltip.appendMarkdown(
        `Tokens: ${formatTokenCount(tokens)} (in ${formatTokenCount(
          session.usage.inputTokens,
        )} · out ${formatTokenCount(session.usage.outputTokens)})\n\n`,
      );
    }
    if (session.costUsd) {
      tooltip.appendMarkdown(`Estimated cost: $${session.costUsd.toFixed(2)}\n\n`);
    }
    tooltip.appendMarkdown(`Id: \`${session.id}\`\n\n`);
    tooltip.appendMarkdown(`File: \`${session.filePath}\``);
    item.tooltip = tooltip;

    item.command = {
      command: 'ccSdd.previewSession',
      title: 'Preview Session',
      arguments: [session],
    };
    return item;
  }
}
