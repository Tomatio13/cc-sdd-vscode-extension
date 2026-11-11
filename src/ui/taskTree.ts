import * as vscode from 'vscode';
import {
  buildSpecProgress,
  verificationLabel,
  type SpecProgress,
  type VerificationItem,
} from '../core/progress';
import type { SpecRecord, ValidationFile } from '../core/repository';
import { buildTaskTree, type ParsedTask } from '../core/tasks';
import type { RunState } from '../run/claudeRunner';

type GroupKind = 'implementation' | 'completed' | 'verification';

export type TaskTreeNode =
  | {
      kind: 'header';
      record: SpecRecord;
      progress: SpecProgress;
      runs: RunState[];
    }
  | {
      kind: 'group';
      group: GroupKind;
      record: SpecRecord;
      progress: SpecProgress;
      tasks?: ParsedTask[];
    }
  | {
      kind: 'task';
      record: SpecRecord;
      progress: SpecProgress;
      task: ParsedTask;
      running: boolean;
      next: boolean;
      waiting: string[];
      remaining: number;
    }
  | {
      kind: 'verification';
      record: SpecRecord;
      progress: SpecProgress;
    }
  | {
      kind: 'verificationItem';
      item: VerificationItem;
    }
  | {
      kind: 'verificationAction';
      record: SpecRecord;
      progress: SpecProgress;
      action: 'open' | 'run';
    }
  | { kind: 'message'; label: string; description?: string };

const activeRuns = (record: SpecRecord, runs: RunState[]): RunState[] =>
  runs.filter(
    (run) =>
      run.feature === record.id &&
      run.status !== 'preview' &&
      (run.pending !== undefined || run.status === 'running'),
  );

const taskIdsFromRun = (run: RunState, knownIds: Set<string>): string[] => {
  const matches = run.prompt.match(/(?:^|\s)(\d+(?:\.\d+)*)(?=\s|$)/g) ?? [];
  return matches
    .map((match) => match.trim())
    .filter((id) => knownIds.has(id));
};

const runningTaskIds = (runs: RunState[], tasks: ParsedTask[]): Set<string> => {
  const knownIds = new Set(tasks.map((task) => task.id));
  const ids = new Set<string>();
  for (const run of runs) {
    for (const id of taskIdsFromRun(run, knownIds)) {
      ids.add(id);
    }
  }
  return ids;
};

const unresolvedDependencies = (task: ParsedTask, tasks: ParsedTask[]): string[] => {
  if (task.depends.length === 0) {
    return [];
  }
  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  return task.depends.filter((id) => byId.get(id)?.checked !== true);
};

const nextCandidate = (tasks: ParsedTask[]): string | undefined => {
  const leaves = tasks.filter((task) => task.children.length === 0 && !task.checked);
  const done = new Set(tasks.filter((task) => task.checked).map((task) => task.id));
  return leaves.find((task) => task.depends.every((id) => done.has(id)))?.id;
};

const specIcon = (progress: SpecProgress): vscode.ThemeIcon => {
  if (progress.completed) {
    return new vscode.ThemeIcon('pass-filled');
  }
  if (progress.stage === 'verification') {
    if (progress.verification.status === 'failed') {
      return new vscode.ThemeIcon('error');
    }
    return new vscode.ThemeIcon('clock');
  }
  if (progress.stage === 'implementation') {
    return new vscode.ThemeIcon(progress.tasksTotal === 0 ? 'warning' : 'rocket');
  }
  if (progress.reviewPhases.length > 0) {
    return new vscode.ThemeIcon('clock');
  }
  return new vscode.ThemeIcon('circle-outline');
};

const verificationIcon = (progress: SpecProgress): vscode.ThemeIcon => {
  if (!progress.implementationComplete) {
    return new vscode.ThemeIcon('circle-slash');
  }
  switch (progress.verification.status) {
    case 'verified':
      return new vscode.ThemeIcon('pass-filled');
    case 'failed':
      return new vscode.ThemeIcon('error');
    case 'error':
      return new vscode.ThemeIcon('warning');
    case 'none':
      return new vscode.ThemeIcon('circle-outline');
    default:
      return new vscode.ThemeIcon('clock');
  }
};

const specHeaderItem = (
  node: Extract<TaskTreeNode, { kind: 'header' }>,
): vscode.TreeItem => {
  const { record, progress } = node;
  const label = record.spec?.feature_name?.trim() || record.id;
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.id = `tasks:${record.id}:header`;
  item.contextValue = 'spec-header';
  item.description = progress.stateLabel;
  item.iconPath = specIcon(progress);
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**${label}**\n\n`);
  tooltip.appendMarkdown(`Stage: ${progress.stageLabel}\n\n`);
  tooltip.appendMarkdown(`State: ${progress.stateLabel}\n\n`);
  tooltip.appendMarkdown(
    `Implementation: ${progress.tasksDone}/${progress.tasksTotal} tasks\n\n`,
  );
  tooltip.appendMarkdown(`Verification: ${verificationLabel(progress.verification)}\n\n`);
  tooltip.appendMarkdown(`Path: \`${record.dir}\``);
  item.tooltip = tooltip;
  return item;
};

const groupItem = (node: Extract<TaskTreeNode, { kind: 'group' }>): vscode.TreeItem => {
  const { group, progress, tasks } = node;
  if (group === 'implementation') {
    const item = new vscode.TreeItem(
      'Implementation',
      vscode.TreeItemCollapsibleState.Expanded,
    );
    item.id = `tasks:${node.record.id}:implementation`;
    item.contextValue = 'task-group-implementation';
    item.description = `${progress.tasksDone}/${progress.tasksTotal}`;
    item.iconPath = new vscode.ThemeIcon(
      progress.implementationComplete ? 'pass-filled' : 'rocket',
    );
    item.tooltip =
      progress.tasksTotal === 0
        ? 'tasks.md has no tasks yet.'
        : `${progress.tasksTotal - progress.tasksDone} task(s) remaining.`;
    return item;
  }

  if (group === 'completed') {
    const item = new vscode.TreeItem(
      'Completed tasks',
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = `tasks:${node.record.id}:completed`;
    item.contextValue = 'task-group-completed';
    item.description = `${tasks?.length ?? 0} task(s)`;
    item.iconPath = new vscode.ThemeIcon('check');
    item.tooltip = 'Completed tasks are folded here so the remaining work stays visible.';
    return item;
  }

  const item = new vscode.TreeItem(
    'Verification',
    vscode.TreeItemCollapsibleState.Expanded,
  );
  item.id = `tasks:${node.record.id}:verification`;
  item.contextValue = 'task-group-verification';
  item.description = !progress.implementationComplete
    ? 'waiting for implementation'
    : progress.verification.status === 'none' && !progress.verification.conditionsDefined
      ? 'conditions undefined'
      : progress.verification.items.length > 0
        ? `${progress.verification.items.length} check(s)`
        : verificationLabel(progress.verification);
  item.iconPath = verificationIcon(progress);
  item.tooltip = progress.verification.detail ?? 'Verification state and recorded checks.';
  return item;
};

const taskItem = (node: Extract<TaskTreeNode, { kind: 'task' }>): vscode.TreeItem => {
  const { record, task, running, next, waiting, remaining } = node;
  const collapsible =
    task.children.length > 0
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;

  const item = new vscode.TreeItem(`${task.id}. ${task.title}`, collapsible);
  item.id = `task:${record.id}:${task.line}:${task.id}`;
  item.contextValue = task.checked
    ? 'task-done'
    : running
      ? 'task-running'
      : waiting.length > 0
        ? 'task-waiting'
        : 'task-todo';

  const description: string[] = [];
  if (running) {
    description.push('running');
  } else if (waiting.length > 0) {
    description.push(`waiting: ${waiting.join(', ')}`);
  } else if (next && !task.checked) {
    description.push('next');
  }
  if (task.parallel) {
    description.push('parallel');
  }
  if (task.requirements.length > 0) {
    const [first, ...rest] = task.requirements;
    description.push(`req ${first}${rest.length > 0 ? ` +${rest.length}` : ''}`);
  }
  if (!task.checked && !running && waiting.length === 0) {
    description.push(`${remaining} left`);
  }
  item.description = description.join(' · ');
  item.iconPath = new vscode.ThemeIcon(
    task.checked
      ? 'pass-filled'
      : running
        ? 'sync'
        : waiting.length > 0
          ? 'lock'
          : 'circle-outline',
  );

  item.command = {
    command: 'ccSdd.openTask',
    title: 'Open Task',
    arguments: [{ record, task }],
  };

  const tooltip = new vscode.MarkdownString();
  tooltip.supportThemeIcons = true;
  tooltip.appendMarkdown(`**${task.id}. ${task.title}**\n\n`);
  tooltip.appendMarkdown(`Line: \`${task.line + 1}\`\n\n`);
  if (running) {
    tooltip.appendMarkdown('Status: running in this window\n\n');
  } else if (waiting.length > 0) {
    tooltip.appendMarkdown(`Waiting on: \`${waiting.join(', ')}\`\n\n`);
  } else if (next && !task.checked) {
    tooltip.appendMarkdown('Status: next candidate\n\n');
  }
  if (task.parallel) {
    tooltip.appendMarkdown('Parallel task\n\n');
  }
  if (task.boundary) {
    tooltip.appendMarkdown(`Boundary: \`${task.boundary}\`\n\n`);
  }
  if (task.depends.length > 0) {
    tooltip.appendMarkdown(`Depends: \`${task.depends.join(', ')}\`\n\n`);
  }
  if (task.requirements.length > 0) {
    tooltip.appendMarkdown(`Requirements: \`${task.requirements.join(', ')}\`\n\n`);
  }
  item.tooltip = tooltip;
  return item;
};

const verificationItem = (node: Extract<TaskTreeNode, { kind: 'verification' }>): vscode.TreeItem => {
  const { record, progress } = node;
  const verification = progress.verification;
  const label = !progress.implementationComplete
    ? 'Waiting for implementation'
    : verification.status === 'none' && !verification.conditionsDefined
      ? 'Verification conditions undefined'
      : verificationLabel(verification);
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  item.id = `tasks:${record.id}:verification-status`;
  item.contextValue = 'verification-status';
  item.iconPath = verificationIcon(progress);
  item.description =
    verification.status === 'none'
      ? 'Run validation to record checks'
      : verification.at
        ? new Date(verification.at).toLocaleString()
        : undefined;
  item.tooltip = [
    `Verification: ${verificationLabel(verification)}`,
    record.validationPath,
    verification.detail,
  ]
    .filter(Boolean)
    .join('\n\n');
  if (record.validationExists) {
    item.command = {
      command: 'ccSdd.openValidation',
      title: 'Open Validation',
      arguments: [record],
    };
  }
  return item;
};

const verificationCheckItem = (
  node: Extract<TaskTreeNode, { kind: 'verificationItem' }>,
): vscode.TreeItem => {
  const { item } = node;
  const treeItem = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
  treeItem.id = `verification-check:${item.label}`;
  treeItem.contextValue = 'verification-check';
  treeItem.description = item.value;
  treeItem.iconPath = new vscode.ThemeIcon(
    item.status === 'pass'
      ? 'pass-filled'
      : item.status === 'fail'
        ? 'error'
        : item.status === 'unknown'
          ? 'question'
          : 'info',
  );
  treeItem.tooltip = `${item.label}: ${item.value}`;
  return treeItem;
};

const verificationActionItem = (
  node: Extract<TaskTreeNode, { kind: 'verificationAction' }>,
): vscode.TreeItem => {
  const { record, progress, action } = node;
  const run = action === 'run';
  const item = new vscode.TreeItem(
    run
      ? progress.verification.status === 'none'
        ? 'Start verification'
        : 'Revalidate'
      : 'Open verification report',
    vscode.TreeItemCollapsibleState.None,
  );
  item.id = `tasks:${record.id}:verification-${action}`;
  item.contextValue = 'verification-action';
  item.iconPath = new vscode.ThemeIcon(run ? 'shield' : 'file');
  item.description = run ? 'impl-validation.md' : 'Recorded checks';
  item.command = run
    ? {
        command: 'ccSdd.runValidateImpl',
        title: 'Run Implementation Validation',
        arguments: [record],
      }
    : {
        command: 'ccSdd.openValidation',
        title: 'Open Validation',
        arguments: [record],
      };
  item.tooltip = run
    ? 'Run implementation validation and record the result in impl-validation.md.'
    : 'Open the current implementation validation report.';
  return item;
};

export class TaskTreeProvider implements vscode.TreeDataProvider<TaskTreeNode> {
  private readonly changed = new vscode.EventEmitter<TaskTreeNode | undefined | void>();

  private active: SpecRecord | undefined;

  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly readTasks: (record: SpecRecord) => Promise<string | undefined>,
    private readonly readValidation: (record: SpecRecord) => Promise<ValidationFile>,
    private readonly getRuns: () => RunState[],
  ) {}

  setActive(record: SpecRecord | undefined): void {
    this.active = record;
    this.changed.fire();
  }

  refresh(): void {
    this.changed.fire();
  }

  async getChildren(element?: TaskTreeNode): Promise<TaskTreeNode[]> {
    if (!this.active) {
      return [{ kind: 'message', label: 'No spec selected', description: 'Choose one in Specs' }];
    }

    if (!element) {
      return this.buildRoot(this.active);
    }

    if (element.kind === 'group') {
      if (element.group === 'implementation') {
        return element.tasks && element.tasks.length > 0
          ? element.tasks.map((task) => this.toTaskNode(element.record, element.progress, task))
          : [{ kind: 'message', label: 'All tasks complete', description: 'See Completed tasks' }];
      }
      if (element.group === 'completed') {
        return element.tasks && element.tasks.length > 0
          ? element.tasks.map((task) => this.toTaskNode(element.record, element.progress, task))
          : [{ kind: 'message', label: 'No completed tasks' }];
      }
      return this.verificationChildren(element);
    }

    if (element.kind === 'task') {
      return element.task.children.map((task) =>
        this.toTaskNode(element.record, element.progress, task),
      );
    }

    return [];
  }

  getTreeItem(node: TaskTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'header':
        return specHeaderItem(node);
      case 'group':
        return groupItem(node);
      case 'task':
        return taskItem(node);
      case 'verification':
        return verificationItem(node);
      case 'verificationItem':
        return verificationCheckItem(node);
      case 'verificationAction':
        return verificationActionItem(node);
      case 'message': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.description = node.description;
        item.contextValue = 'message';
        return item;
      }
    }
  }

  private async buildRoot(record: SpecRecord): Promise<TaskTreeNode[]> {
    const [content, validation] = await Promise.all([
      this.readTasks(record),
      this.readValidation(record),
    ]);
    const progress = buildSpecProgress(record, content, validation);
    const runs = activeRuns(record, this.getRuns());
    const allTasks = progress.tasks;
    const roots = buildTaskTree(allTasks);
    const completedRoots = roots.filter((task) => task.checked);
    const openRoots = roots.filter((task) => !task.checked);

    const nodes: TaskTreeNode[] = [
      { kind: 'header', record, progress, runs },
      {
        kind: 'group',
        group: 'implementation',
        record,
        progress,
        tasks: openRoots,
      },
    ];

    if (completedRoots.length > 0) {
      nodes.push({
        kind: 'group',
        group: 'completed',
        record,
        progress,
        tasks: completedRoots,
      });
    }

    nodes.push({
      kind: 'group',
      group: 'verification',
      record,
      progress,
    });

    return nodes;
  }

  private toTaskNode(
    record: SpecRecord,
    progress: SpecProgress,
    task: ParsedTask,
  ): Extract<TaskTreeNode, { kind: 'task' }> {
    const allTasks = progress.tasks;
    const running = runningTaskIds(
      activeRuns(record, this.getRuns()),
      allTasks,
    );
    const waiting = unresolvedDependencies(task, allTasks);
    const next = nextCandidate(allTasks) === task.id;
    const remaining = allTasks.filter((candidate) => !candidate.checked).length;
    return {
      kind: 'task',
      record,
      progress,
      task,
      running: running.has(task.id),
      next,
      waiting,
      remaining,
    };
  }

  private verificationChildren(
    group: Extract<TaskTreeNode, { kind: 'group' }>,
  ): TaskTreeNode[] {
    const { record, progress } = group;
    const nodes: TaskTreeNode[] = [{ kind: 'verification', record, progress }];

    for (const item of progress.verification.items) {
      nodes.push({ kind: 'verificationItem', item });
    }
    if (progress.verification.items.length === 0 && progress.implementationComplete) {
      nodes.push({
        kind: 'message',
        label: 'No itemized checks recorded',
        description: 'The report may still contain the overall decision.',
      });
    }

    if (!progress.implementationComplete) {
      return nodes;
    }

    if (record.validationExists) {
      nodes.push({
        kind: 'verificationAction',
        record,
        progress,
        action: 'open',
      });
    }
    if (progress.verification.status !== 'verified') {
      nodes.push({
        kind: 'verificationAction',
        record,
        progress,
        action: 'run',
      });
    }
    return nodes;
  }
}
