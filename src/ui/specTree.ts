import * as vscode from 'vscode';
import { PHASE_META } from '../core/phases';
import type {
  RoadmapInfo,
  SpecRecord,
  SteeringStatus,
} from '../core/repository';
import {
  PHASES,
  nextAction,
  phaseStatus,
  type PhaseKey,
  type PhaseStatus,
} from '../core/spec';
import { parseTasks, type ParsedTask } from '../core/tasks';
import {
  countLabel,
  phaseStateIcon,
  phaseStateLabel,
  taskStateIcon,
  taskStateLabel,
} from './treeState';

export interface TasksProgress {
  done: number;
  total: number;
  nextId?: string;
}

export type SpecTreeNode =
  | { kind: 'spec'; record: SpecRecord; deps?: string[] }
  | { kind: 'steering'; status: SteeringStatus }
  | { kind: 'roadmap'; info: RoadmapInfo }
  | {
      kind: 'state';
      record: SpecRecord;
      label: string;
      description?: string;
      icon: string;
      contextValue: string;
    }
  | {
      kind: 'action';
      record: SpecRecord;
      label: string;
      detail?: string;
      icon: string;
      command?: vscode.Command;
    }
  | { kind: 'phase'; record: SpecRecord; phase: PhaseKey; status: PhaseStatus; tasksProgress?: TasksProgress }
  | { kind: 'task'; record: SpecRecord; task: ParsedTask; remaining: number }
  | { kind: 'message'; label: string; description?: string };

const summarizeTasks = (content: string | undefined): TasksProgress | undefined => {
  if (content === undefined) {
    return undefined;
  }
  const tasks = parseTasks(content);
  if (tasks.length === 0) {
    return undefined;
  }
  const done = tasks.filter((task) => task.checked).length;
  const next = tasks.find((task) => !task.checked);
  return { done, total: tasks.length, nextId: next?.id };
};

const nextActionLabel = (record: SpecRecord): string => {
  if (!record.spec) {
    return 'spec.json missing';
  }
  const action = nextAction(record.spec);
  if (action.kind === 'implement') {
    return 'implement';
  }
  return `${action.kind === 'generate' ? 'generate' : 'review'} ${action.phase}`;
};

const specItem = (record: SpecRecord, deps?: string[]): vscode.TreeItem => {
  const ready = record.spec?.ready_for_implementation === true;
  const label = record.spec?.feature_name?.trim() || record.id;
  const approvedCount = record.spec
    ? PHASES.filter((phase) => record.spec?.approvals[phase].approved).length
    : 0;

  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
  item.id = `spec:${record.id}`;
  item.contextValue = ready ? 'spec-ready' : 'spec';
  item.description = record.spec
    ? [`${approvedCount}/3 approved`, ready ? 'ready' : `next: ${nextActionLabel(record)}`].join(
        ' · ',
      )
    : record.specError
      ? 'spec.json invalid'
      : 'spec.json missing';
  item.iconPath = new vscode.ThemeIcon('book');
  item.command = {
    command: 'ccSdd.selectSpec',
    title: 'Select Spec',
    arguments: [record],
  };

  const tooltip = new vscode.MarkdownString();
  tooltip.supportThemeIcons = true;
  tooltip.appendMarkdown(`**${label}**\n\n`);
  tooltip.appendMarkdown(`Path: \`${record.dir}\`\n\n`);
  if (deps && deps.length > 0) {
    tooltip.appendMarkdown(`After: ${deps.join(', ')}\n\n`);
  }
  if (record.spec) {
    tooltip.appendMarkdown(`Next: ${nextActionLabel(record)}\n\n`);
    tooltip.appendMarkdown(
      `Approvals: ${PHASES.map((phase) => {
        const approval = record.spec?.approvals[phase];
        const mark = approval?.approved
          ? '$(pass-filled)'
          : approval?.generated
            ? '$(diff)'
            : '$(circle-outline)';
        return `${mark} ${PHASE_META[phase].label}`;
      }).join('  ')}\n\n`,
    );
  }
  if (record.specError) {
    tooltip.appendMarkdown(`$(error) ${record.specError}\n`);
  }
  item.tooltip = tooltip;

  return item;
};

const phaseItem = (
  record: SpecRecord,
  phase: PhaseKey,
  status: PhaseStatus,
  tasksProgress?: TasksProgress,
): vscode.TreeItem => {
  const meta = PHASE_META[phase];
  const item = new vscode.TreeItem(meta.label, vscode.TreeItemCollapsibleState.None);
  item.id = `phase:${record.id}:${phase}`;
  item.contextValue = `phase-${status}`;

  const description: string[] = [];
  if (tasksProgress) {
    description.push(`${tasksProgress.done}/${tasksProgress.total} done`);
    if (tasksProgress.nextId) {
      description.push(`next ${tasksProgress.nextId}`);
    }
  } else {
    description.push(phaseStateLabel(status));
  }
  item.description = description.join(' · ');
  item.iconPath = new vscode.ThemeIcon(phaseStateIcon(status));

  const details = [
    meta.description,
    record.artifacts[phase],
    `Skill: /${meta.skill}`,
    `Status: ${phaseStateLabel(status)}`,
  ];
  if (tasksProgress) {
    details.push(`Progress: ${tasksProgress.done}/${tasksProgress.total} done`);
    if (tasksProgress.nextId) {
      details.push(`Next task: ${tasksProgress.nextId}`);
    }
  }
  item.tooltip = details.join('\n\n');

  item.command =
    status === 'missing'
      ? { command: 'ccSdd.runPhase', title: 'Run Phase', arguments: [{ record, phase }] }
      : { command: 'ccSdd.openArtifact', title: 'Open Artifact', arguments: [{ record, phase }] };
  return item;
};

const taskItem = (record: SpecRecord, task: ParsedTask, remaining: number): vscode.TreeItem => {
  const item = new vscode.TreeItem(
    `Next: ${task.id}. ${task.title}`,
    vscode.TreeItemCollapsibleState.None,
  );
  item.id = `task:${record.id}:${task.line}:${task.id}`;
  item.contextValue = task.checked ? 'task-done' : 'task-todo';
  item.iconPath = new vscode.ThemeIcon(taskStateIcon(task.checked));

  const description = [`${countLabel(remaining, 'task')} left`];
  if (task.parallel) {
    description.push('parallel');
  }
  item.description = description.join(' · ');
  item.command = {
    command: 'ccSdd.openTask',
    title: 'Open Task',
    arguments: [{ record, task }],
  };

  const tooltip = new vscode.MarkdownString();
  tooltip.supportThemeIcons = true;
  tooltip.appendMarkdown(`**${task.id}. ${task.title}**\n\n`);
  tooltip.appendMarkdown(`Open in tasks.md at line ${task.line + 1}.\n\n`);
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
  tooltip.appendMarkdown(
    `${task.checked ? '$(pass-filled)' : '$(circle-outline)'} ${taskStateLabel(task.checked)}`,
  );
  item.tooltip = tooltip;
  return item;
};

const steeringItem = (status: SteeringStatus): vscode.TreeItem => {
  const allPresent = status.generated;
  const partial = !allPresent && status.files.some((file) => file.exists);

  const item = new vscode.TreeItem('Steering', vscode.TreeItemCollapsibleState.None);
  item.id = 'workspace:steering';
  item.contextValue = allPresent ? 'steering-ready' : 'steering-missing';
  if (allPresent) {
    item.description = 'product, tech, structure';
  } else if (partial) {
    item.description = `partial · missing ${status.missing.join(', ')}`;
  } else {
    item.description = 'not started';
  }
  item.iconPath = new vscode.ThemeIcon(
    allPresent ? 'pass-filled' : partial ? 'circle-outline' : 'circle-slash',
  );
  item.tooltip = [
    'Project context for spec generation (product, tech, structure).',
    '',
    ...status.files.map(
      (file) => `${file.exists ? '$(pass-filled)' : '$(circle-slash)'} ${file.name}`,
    ),
    '',
    allPresent ? 'Open product.md' : 'Run /kiro-steering',
  ].join('\n');

  item.command = allPresent
    ? { command: 'ccSdd.openPath', title: 'Open Path', arguments: [status.files[0].path] }
    : { command: 'ccSdd.runSteering', title: 'Run Steering' };
  return item;
};

const roadmapItem = (info: RoadmapInfo): vscode.TreeItem => {
  const item = new vscode.TreeItem('Roadmap', vscode.TreeItemCollapsibleState.None);
  item.id = 'workspace:roadmap';
  item.contextValue = 'roadmap';
  item.description = countLabel(info.order.length, 'spec');
  item.iconPath = new vscode.ThemeIcon('list-ordered');
  item.tooltip = `Dependency order from roadmap.md.\n\n${info.path}`;
  item.command = { command: 'ccSdd.openPath', title: 'Open Path', arguments: [info.path] };
  return item;
};

export class SpecTreeProvider implements vscode.TreeDataProvider<SpecTreeNode> {
  private readonly changed = new vscode.EventEmitter<SpecTreeNode | undefined | void>();

  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly load: () => Promise<SpecRecord[]>,
    private readonly readArtifact: (
      record: SpecRecord,
      phase: PhaseKey,
    ) => Promise<string | undefined>,
    private readonly workspaceInfo: () => Promise<{
      steering: SteeringStatus;
      roadmap: RoadmapInfo | undefined;
    }>,
  ) {}

  refresh(): void {
    this.changed.fire();
  }

  async getChildren(element?: SpecTreeNode): Promise<SpecTreeNode[]> {
    if (!element) {
      const [records, info] = await Promise.all([this.load(), this.workspaceInfo()]);
      const nodes: SpecTreeNode[] = [];

      if (info.roadmap) {
        nodes.push({ kind: 'roadmap', info: info.roadmap });
        const order = info.roadmap.order;
        const sorted = [...records].sort((left, right) => {
          const leftIndex = order.indexOf(left.id);
          const rightIndex = order.indexOf(right.id);
          if (leftIndex === -1 && rightIndex === -1) {
            return left.id.localeCompare(right.id);
          }
          if (leftIndex === -1) {
            return 1;
          }
          if (rightIndex === -1) {
            return -1;
          }
          return leftIndex - rightIndex;
        });
        for (const record of sorted) {
          nodes.push({
            kind: 'spec',
            record,
            deps: info.roadmap.deps[record.id],
          });
        }
      } else {
        for (const record of records) {
          nodes.push({ kind: 'spec', record });
        }
      }

      // Steering 収録は常に最後（Workspace 共通の文脈のため）。 未生成なら先頭で目立たせる。
      nodes.unshift({ kind: 'steering', status: info.steering });
      return nodes;
    }

    if (element.kind === 'spec') {
      return this.buildBody(element.record);
    }

    return [];
  }

  getTreeItem(node: SpecTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'spec':
        return specItem(node.record, node.deps);
      case 'steering':
        return steeringItem(node.status);
      case 'roadmap':
        return roadmapItem(node.info);
      case 'state': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.contextValue = node.contextValue;
        if (node.description) {
          item.description = node.description;
        }
        item.tooltip = node.record.dir;
        return item;
      }
      case 'action': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = `action:${node.record.id}:${node.label}`;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        if (node.detail) {
          item.description = node.detail;
        }
        if (node.command) {
          item.command = node.command;
        }
        item.tooltip = node.detail ? `${node.label}\n\n${node.detail}` : node.label;
        return item;
      }
      case 'phase':
        return phaseItem(node.record, node.phase, node.status, node.tasksProgress);
      case 'task':
        return taskItem(node.record, node.task, node.remaining);
      case 'message': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.description = node.description;
        item.contextValue = 'status-message';
        return item;
      }
    }
  }

  private async buildBody(record: SpecRecord): Promise<SpecTreeNode[]> {
    const spec = record.spec;
    if (!spec) {
      return [
        {
          kind: 'message',
          label: 'spec.json is missing or invalid',
          description: record.specError ?? 'Run /kiro-spec-init first',
        },
      ];
    }

    const nodes: SpecTreeNode[] = [];
    const action = nextAction(spec);
    const tasksContent = await this.readArtifact(record, 'tasks');
    const tasks = parseTasks(tasksContent ?? '');
    const done = tasks.filter((task) => task.checked).length;
    const nextTask = tasks.find((task) => !task.checked);

    // 1. Current state
    if (spec.ready_for_implementation === true) {
      if (tasksContent === undefined || tasks.length === 0) {
        nodes.push({
          kind: 'state',
          record,
          label: 'Tasks missing',
          description: 'tasks.md not found',
          icon: 'warning',
          contextValue: 'status-ready',
        });
      } else if (!nextTask) {
        nodes.push({
          kind: 'state',
          record,
          label: 'Implementation complete',
          description: `${done}/${tasks.length} done`,
          icon: 'pass-filled',
          contextValue: 'status-complete',
        });
      } else {
        nodes.push({
          kind: 'state',
          record,
          label: 'Implementation in progress',
          description: `${done}/${tasks.length} done`,
          icon: 'run-all',
          contextValue: 'status-ready',
        });
      }
    } else {
      const waitingLabel =
        action.kind === 'review'
          ? 'Awaiting review'
          : action.kind === 'generate'
            ? 'Awaiting generation'
            : 'Ready to implement';
      const waitingDetail =
        action.kind === 'implement'
          ? 'implementation'
          : PHASE_META[action.phase].label.toLowerCase();
      nodes.push({
        kind: 'state',
        record,
        label: waitingLabel,
        description: waitingDetail,
        icon: 'clock',
        contextValue: 'status-waiting',
      });
    }

    // 2. Next action
    if (spec.ready_for_implementation === true) {
      if (tasksContent === undefined || tasks.length === 0) {
        nodes.push({
          kind: 'action',
          record,
          label: 'Generate tasks',
          detail: `/${PHASE_META.tasks.skill}`,
          icon: 'play',
          command: {
            command: 'ccSdd.runPhase',
            title: 'Run Phase',
            arguments: [{ record, phase: 'tasks' as PhaseKey }],
          },
        });
      } else if (nextTask) {
        nodes.push({
          kind: 'task',
          record,
          task: nextTask,
          remaining: tasks.length - done,
        });
        nodes.push({
          kind: 'action',
          record,
          label: 'Continue implementation',
          detail: `${countLabel(tasks.length - done, 'task')} left`,
          icon: 'play',
          command: {
            command: 'ccSdd.runImpl',
            title: 'Run Implementation',
            arguments: [record],
          },
        });
      } else {
        nodes.push({
          kind: 'action',
          record,
          label: 'Validate implementation',
          detail: 'all tasks done',
          icon: 'check-all',
          command: {
            command: 'ccSdd.runValidateImpl',
            title: 'Run Implementation Validation',
            arguments: [record],
          },
        });
      }
    } else if (action.kind !== 'implement') {
      const meta = PHASE_META[action.phase];
      const exists = record.exists[action.phase];
      const verb = action.kind === 'generate' ? 'Generate' : 'Review';
      nodes.push({
        kind: 'action',
        record,
        label: `${verb} ${meta.label.toLowerCase()}`,
        detail: exists ? meta.file : `/${meta.skill}`,
        icon: action.kind === 'generate' ? 'play' : 'check',
        command: exists
          ? {
              command: 'ccSdd.approvePhase',
              title: 'Approve Phase',
              arguments: [{ record, phase: action.phase }],
            }
          : {
              command: 'ccSdd.runPhase',
              title: 'Run Phase',
              arguments: [{ record, phase: action.phase }],
            },
      });
    }

    // 3. Phase progress
    for (const phase of PHASES) {
      const status = phaseStatus(spec, phase, record.exists[phase]);
      const tasksProgress = phase === 'tasks' ? summarizeTasks(tasksContent) : undefined;
      nodes.push({ kind: 'phase', record, phase, status, tasksProgress });
    }

    return nodes;
  }
}
