import * as vscode from 'vscode';
import * as path from 'node:path';
import { IMPLEMENTATION_SKILL, PHASE_META, VALIDATE_IMPL_SKILL } from '../core/phases';
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

export interface TasksProgress {
  done: number;
  total: number;
  nextId?: string;
}

export type SpecTreeNode =
  | { kind: 'spec'; record: SpecRecord; deps?: string[] }
  | { kind: 'steering'; status: SteeringStatus }
  | { kind: 'roadmap'; info: RoadmapInfo }
  | { kind: 'state'; record: SpecRecord; label: string; icon: string; contextValue: string }
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
    return 'ready → /kiro-impl';
  }
  return `${action.kind === 'generate' ? 'generate' : 'approve'} ${action.phase}`;
};

const statusLabel = (status: PhaseStatus): string => {
  switch (status) {
    case 'missing':
      return 'not generated';
    case 'draft':
      return 'draft';
    case 'generated':
      return 'review';
    case 'approved':
      return 'approved';
  }
};

const statusIcon = (status: PhaseStatus): string => {
  switch (status) {
    case 'missing':
      return 'circle-slash';
    case 'draft':
      return 'circle-outline';
    case 'generated':
      return 'diff';
    case 'approved':
      return 'pass-filled';
  }
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
  item.description = [
    record.spec ? record.spec.phase ?? 'unknown' : null,
    `${approvedCount}/3 approved`,
    deps && deps.length > 0 ? `deps: ${deps.join(', ')}` : null,
    nextActionLabel(record),
  ]
    .filter(Boolean)
    .join(' · ');
  item.iconPath = new vscode.ThemeIcon(ready ? 'rocket' : 'beaker');
  item.command = {
    command: 'ccSdd.selectSpec',
    title: 'Select Spec',
    arguments: [record],
  };

  const tooltip = new vscode.MarkdownString();
  tooltip.supportThemeIcons = true;
  tooltip.appendMarkdown(`**${label}**\n\n`);
  tooltip.appendMarkdown(`Path: \`${record.dir}\`\n\n`);
  if (record.spec) {
    tooltip.appendMarkdown(`Phase: \`${record.spec.phase ?? 'unknown'}\`\n\n`);
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

  const description = [statusLabel(status)];
  if (tasksProgress) {
    description.push(`${tasksProgress.done}/${tasksProgress.total} done`);
    if (tasksProgress.nextId) {
      description.push(`next ${tasksProgress.nextId}`);
    }
  }
  item.description = description.join(' · ');
  item.iconPath = new vscode.ThemeIcon(statusIcon(status));
  item.tooltip = `${meta.description}\n\n${record.artifacts[phase]}\n\nSkill: /${meta.skill}`;
  if (tasksProgress) {
    item.tooltip += `\n\nProgress: ${tasksProgress.done}/${tasksProgress.total} done`;
  }

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
  item.iconPath = new vscode.ThemeIcon(task.checked ? 'pass-filled' : 'circle-outline');

  const badges: string[] = [`${remaining - 1} after this`];
  if (task.parallel) {
    badges.push('(P)');
  }
  if (task.boundary) {
    badges.push(`boundary: ${task.boundary}`);
  }
  if (task.requirements.length > 0) {
    badges.push(`req: ${task.requirements.join(', ')}`);
  }
  item.description = badges.join(' · ');
  item.command = {
    command: 'ccSdd.openTask',
    title: 'Open Task',
    arguments: [{ record, task }],
  };

  const tooltip = new vscode.MarkdownString();
  tooltip.supportThemeIcons = true;
  tooltip.appendMarkdown(`**${task.id}. ${task.title}**\n\n`);
  tooltip.appendMarkdown(`Click to open in tasks.md (line ${task.line + 1}).\n\n`);
  if (task.depends.length > 0) {
    tooltip.appendMarkdown(`Depends: \`${task.depends.join(', ')}\`\n\n`);
  }
  tooltip.appendMarkdown(task.checked ? '$(pass-filled) Done' : '$(circle-outline) Not started');
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
    item.description = 'product · tech · structure';
  } else if (partial) {
    item.description = `partial — missing: ${status.missing.join(', ')}`;
  } else {
    item.description = 'not generated — run /kiro-steering';
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
    allPresent ? 'Click to open product.md' : 'Click to run /kiro-steering',
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
  item.description = `${info.order.length} spec(s) · ${info.path.split(path.sep).pop()}`;
  item.iconPath = new vscode.ThemeIcon('map');
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
    const approvedCount = PHASES.filter((phase) => spec.approvals[phase].approved).length;
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
          label: 'Ready for implementation, but tasks.md is missing',
          icon: 'warning',
          contextValue: 'status-ready',
        });
      } else if (!nextTask) {
        nodes.push({
          kind: 'state',
          record,
          label: `Implementation complete (${done}/${tasks.length})`,
          icon: 'pass-filled',
          contextValue: 'status-complete',
        });
      } else {
        nodes.push({
          kind: 'state',
          record,
          label: `Implementation in progress (${done}/${tasks.length} done)`,
          icon: 'run-all',
          contextValue: 'status-ready',
        });
      }
    } else {
      nodes.push({
        kind: 'state',
        record,
        label:
          action.kind === 'review'
            ? `Awaiting approval — ${approvedCount}/3 approved`
            : `Awaiting generation — ${approvedCount}/3 approved`,
        icon: 'pause',
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
          detail: `/${PHASE_META.tasks.skill} ${record.id}`,
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
          label: `Continue /${IMPLEMENTATION_SKILL}`,
          detail: `${tasks.length - done} task(s) remaining`,
          icon: 'rocket',
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
          detail: `/${VALIDATE_IMPL_SKILL} ${record.id}`,
          icon: 'shield',
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
      const verb = action.kind === 'generate' ? 'Generate' : 'Review and approve';
      nodes.push({
        kind: 'action',
        record,
        label: `Next: ${verb} ${meta.label.toLowerCase()}`,
        detail: exists ? `/${meta.skill} ${record.id} · ${meta.file}` : `/${meta.skill} ${record.id}`,
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
