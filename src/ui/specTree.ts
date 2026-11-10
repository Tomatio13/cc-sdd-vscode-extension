import * as vscode from 'vscode';
import { PHASE_META, nextStepLabel } from '../core/phases';
import { specCreatedAt, type RoadmapInfo, type SpecRecord, type SteeringStatus } from '../core/repository';
import {
  PHASES,
  nextAction,
  nextStepState,
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

type ImplementationState = 'missing-tasks' | 'in-progress' | 'complete';

export type SpecSort = 'newest' | 'roadmap';

export type SpecTreeNode =
  | { kind: 'spec'; record: SpecRecord; deps?: string[]; progress?: TasksProgress }
  | { kind: 'steering'; status: SteeringStatus }
  | { kind: 'roadmap'; info: RoadmapInfo }
  | {
      kind: 'action';
      record: SpecRecord;
      label: string;
      detail?: string;
      tooltip?: string;
      icon: string;
      command?: vscode.Command;
    }
  | {
      kind: 'phase';
      record: SpecRecord;
      phase: PhaseKey;
      status: PhaseStatus;
      order: number;
      current: boolean;
      tasksProgress?: TasksProgress;
    }
  | {
      kind: 'implementation';
      record: SpecRecord;
      state: ImplementationState;
      progress?: TasksProgress;
      nextTask?: ParsedTask;
      remaining: number;
    }
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

/** Newest first, matching the Overview portfolio. */
const compareNewest = (left: SpecRecord, right: SpecRecord): number => {
  const delta = specCreatedAt(right) - specCreatedAt(left);
  if (delta !== 0) {
    return delta;
  }
  return left.id.localeCompare(right.id);
};

const compareRoadmap = (
  roadmap: RoadmapInfo,
  left: SpecRecord,
  right: SpecRecord,
): number => {
  const leftIndex = roadmap.order.indexOf(left.id);
  const rightIndex = roadmap.order.indexOf(right.id);
  if (leftIndex === -1 && rightIndex === -1) {
    return compareNewest(left, right);
  }
  if (leftIndex === -1) {
    return 1;
  }
  if (rightIndex === -1) {
    return -1;
  }
  return leftIndex - rightIndex;
};

const approvedCount = (record: SpecRecord): number => {
  const spec = record.spec;
  return spec ? PHASES.filter((phase) => spec.approvals[phase].approved).length : 0;
};

const nextActionLabel = (record: SpecRecord, progress: TasksProgress | undefined): string | undefined => {
  if (!record.spec) {
    return undefined;
  }
  return nextStepLabel(nextStepState(record.spec, progress));
};

/** The single obvious next action, derived from the same state as the steps. */
const nextStep = (
  record: SpecRecord,
  progress: TasksProgress | undefined,
): {
  label: string;
  detail?: string;
  tooltip?: string;
  icon: string;
  command?: vscode.Command;
} | undefined => {
  const spec = record.spec;
  if (!spec) {
    return undefined;
  }

  const step = nextStepState(spec, progress);
  const label = nextStepLabel(step);
  if (!label) {
    return undefined;
  }

  if (step.kind === 'generate') {
    const meta = PHASE_META[step.phase];
    return {
      label: `Next: ${label}`,
      detail: step.phase === 'tasks' && !progress ? 'tasks.md missing' : `/${meta.skill}`,
      icon: 'play',
      command: {
        command: 'ccSdd.runPhase',
        title: 'Run Phase',
        arguments: [{ record, phase: step.phase }],
      },
    };
  }

  if (step.kind === 'review') {
    const meta = PHASE_META[step.phase];
    // Reviewing should open the artifact; approval stays on the step's inline button.
    return {
      label: `Next: ${label}`,
      detail: meta.file,
      tooltip: `Open ${meta.file}, then approve it from the check button on step ${
        PHASES.indexOf(step.phase) + 1
      }.`,
      icon: 'eye',
      command: {
        command: 'ccSdd.openArtifact',
        title: 'Open Artifact',
        arguments: [{ record, phase: step.phase }],
      },
    };
  }

  if (step.kind === 'implement') {
    return {
      label: `Next: ${label}`,
      detail: progress
        ? `${countLabel(progress.total - progress.done, 'task')} left`
        : undefined,
      icon: 'play',
      command: {
        command: 'ccSdd.runImpl',
        title: 'Run Implementation',
        arguments: [record],
      },
    };
  }

  return undefined;
};

const specIcon = (
  record: SpecRecord,
  progress: TasksProgress | undefined,
): vscode.ThemeIcon => {
  const spec = record.spec;
  if (!spec) {
    return new vscode.ThemeIcon('warning');
  }
  const action = nextAction(spec);
  if (action.kind === 'implement') {
    if (!progress) {
      return new vscode.ThemeIcon('warning');
    }
    return new vscode.ThemeIcon(progress.done >= progress.total ? 'pass-filled' : 'rocket');
  }
  return new vscode.ThemeIcon(action.kind === 'review' ? 'clock' : 'circle-outline');
};

const specDescription = (
  record: SpecRecord,
  active: boolean,
  progress: TasksProgress | undefined,
): string => {
  const parts: string[] = [];
  if (active) {
    parts.push('active');
  }

  const spec = record.spec;
  if (!spec) {
    parts.push(record.specError ? 'spec.json invalid' : 'spec.json missing');
    return parts.join(' · ');
  }

  const approved = `${approvedCount(record)}/3 approved`;
  const action = nextAction(spec);
  if (action.kind === 'implement') {
    if (!progress) {
      parts.push(approved, 'tasks missing');
    } else if (progress.done >= progress.total) {
      parts.push('done', `${progress.done}/${progress.total} tasks`);
    } else {
      parts.push(approved, `${progress.done}/${progress.total} tasks`);
    }
  } else {
    parts.push(approved, `next: ${PHASE_META[action.phase].label}`);
  }

  return parts.join(' · ');
};

const specItem = (
  record: SpecRecord,
  active: boolean,
  deps: string[] | undefined,
  progress: TasksProgress | undefined,
): vscode.TreeItem => {
  const spec = record.spec;
  const complete = progress !== undefined && progress.done >= progress.total;
  const label = spec?.feature_name?.trim() || record.id;

  const item = new vscode.TreeItem(
    label,
    complete ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
  );
  item.id = `spec:${record.id}`;
  item.contextValue = complete
    ? 'spec-complete'
    : spec && nextAction(spec).kind === 'implement'
      ? 'spec-ready'
      : 'spec';
  item.description = specDescription(record, active, progress);
  item.iconPath = specIcon(record, progress);
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
  if (spec) {
    const next = nextActionLabel(record, progress);
    if (next) {
      tooltip.appendMarkdown(`Next: ${next}\n\n`);
    }
    tooltip.appendMarkdown(
      `Steps: ${PHASES.map((phase) => {
        const approval = spec.approvals[phase];
        const mark = approval.approved
          ? '$(pass-filled)'
          : approval.generated
            ? '$(clock)'
            : '$(circle-outline)';
        return `${mark} ${PHASE_META[phase].label}`;
      }).join('  ')}\n\n`,
    );
    if (progress) {
      tooltip.appendMarkdown(`Tasks: ${progress.done}/${progress.total} done\n\n`);
    }
  }
  if (record.specError) {
    tooltip.appendMarkdown(`$(error) ${record.specError}\n`);
  }
  item.tooltip = tooltip;

  return item;
};

const phaseIcon = (status: PhaseStatus, current: boolean): vscode.ThemeIcon => {
  if (status === 'generated') {
    return new vscode.ThemeIcon('clock');
  }
  if (current) {
    return new vscode.ThemeIcon('arrow-circle-right');
  }
  return new vscode.ThemeIcon(phaseStateIcon(status));
};

const phaseItem = (
  record: SpecRecord,
  phase: PhaseKey,
  status: PhaseStatus,
  order: number,
  current: boolean,
  tasksProgress?: TasksProgress,
): vscode.TreeItem => {
  const meta = PHASE_META[phase];
  const item = new vscode.TreeItem(`${order}. ${meta.label}`, vscode.TreeItemCollapsibleState.None);
  item.id = `phase:${record.id}:${phase}`;
  item.contextValue = `phase-${status}`;
  item.description = tasksProgress
    ? `${tasksProgress.done}/${tasksProgress.total} done`
    : phaseStateLabel(status);
  item.iconPath = phaseIcon(status, current);

  const details = [
    `Step ${order} of ${PHASES.length} · ${meta.description}`,
    `Status: ${phaseStateLabel(status)}${current ? ' (next)' : ''}`,
    record.artifacts[phase],
    `Skill: /${meta.skill}`,
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

const implementationItem = (node: Extract<SpecTreeNode, { kind: 'implementation' }>): vscode.TreeItem => {
  const { record, state, progress, nextTask, remaining } = node;
  const collapsible = nextTask
    ? vscode.TreeItemCollapsibleState.Collapsed
    : vscode.TreeItemCollapsibleState.None;

  const item = new vscode.TreeItem('4. Implementation', collapsible);
  item.id = `implementation:${record.id}`;
  item.contextValue = `impl-${state}`;

  if (state === 'missing-tasks') {
    item.description = 'tasks.md missing';
    item.iconPath = new vscode.ThemeIcon('warning');
  } else if (!progress || state === 'complete') {
    item.description = progress ? `${progress.done}/${progress.total} done` : 'complete';
    item.iconPath = new vscode.ThemeIcon('pass-filled');
  } else {
    item.description = `${progress.done}/${progress.total} done`;
    item.iconPath = new vscode.ThemeIcon('rocket');
  }

  const details = ['Step 4 · implementation after all phases are approved'];
  if (progress) {
    details.push(`Progress: ${progress.done}/${progress.total} done`);
  }
  if (nextTask) {
    details.push(`Next task: ${nextTask.id}. ${nextTask.title}`);
    details.push(`Remaining: ${countLabel(remaining, 'task')}`);
    details.push('Expand to open the next task.');
  } else if (state === 'complete') {
    details.push('Validation is an optional quality gate; run it from the inline button or context menu.');
  }
  item.tooltip = details.join('\n\n');

  if (state === 'missing-tasks') {
    item.command = {
      command: 'ccSdd.runPhase',
      title: 'Run Phase',
      arguments: [{ record, phase: 'tasks' as PhaseKey }],
    };
  } else if (state === 'complete') {
    item.command = {
      command: 'ccSdd.openArtifact',
      title: 'Open Artifact',
      arguments: [{ record, phase: 'tasks' as PhaseKey }],
    };
  }

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
  // Keep steering visually distinct from specs.
  item.iconPath = new vscode.ThemeIcon('globe');
  item.tooltip = [
    'Project context for spec generation (product, tech, structure).',
    '',
    ...status.files.map(
      (file) => `${file.exists ? '$(pass-filled)' : '$(circle-slash)'} ${file.name}`,
    ),
    '',
    allPresent
      ? 'Click to open product.md. Use the sync button to run /kiro-steering again.'
      : 'Click to run /kiro-steering and fill in the missing files.',
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

  private activeId: string | undefined;

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
    private readonly getSort: () => SpecSort,
  ) {}

  setActive(specId: string | undefined): void {
    if (this.activeId === specId) {
      return;
    }
    this.activeId = specId;
    this.changed.fire();
  }

  refresh(): void {
    this.changed.fire();
  }

  async getChildren(element?: SpecTreeNode): Promise<SpecTreeNode[]> {
    if (!element) {
      const [records, info] = await Promise.all([this.load(), this.workspaceInfo()]);
      const progress = new Map<string, TasksProgress | undefined>();
      await Promise.all(
        records.map(async (record) => {
          progress.set(record.id, summarizeTasks(await this.readArtifact(record, 'tasks')));
        }),
      );

      const nodes: SpecTreeNode[] = [];
      const roadmap = info.roadmap;
      if (roadmap) {
        nodes.push({ kind: 'roadmap', info: roadmap });
      }

      // Default: newest spec first. Roadmap order is opt-in because dependency
      // order and recency answer different questions.
      const sorted =
        this.getSort() === 'roadmap' && roadmap
          ? [...records].sort((left, right) => compareRoadmap(roadmap, left, right))
          : [...records].sort(compareNewest);

      for (const record of sorted) {
        nodes.push({
          kind: 'spec',
          record,
          deps: roadmap?.deps[record.id],
          progress: progress.get(record.id),
        });
      }

      // Steering は Workspace 共通の文脈のため常に先頭。未生成なら目立たせる。
      nodes.unshift({ kind: 'steering', status: info.steering });
      return nodes;
    }

    if (element.kind === 'spec') {
      return this.buildBody(element.record);
    }

    if (element.kind === 'implementation') {
      return element.nextTask
        ? [
            {
              kind: 'task',
              record: element.record,
              task: element.nextTask,
              remaining: element.remaining,
            },
          ]
        : [];
    }

    return [];
  }

  getTreeItem(node: SpecTreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'spec':
        return specItem(node.record, this.activeId === node.record.id, node.deps, node.progress);
      case 'steering':
        return steeringItem(node.status);
      case 'roadmap':
        return roadmapItem(node.info);
      case 'action': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = `action:${node.record.id}:next`;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        if (node.detail) {
          item.description = node.detail;
        }
        if (node.command) {
          item.command = node.command;
        }
        item.tooltip = node.tooltip ?? (node.detail ? `${node.label}\n\n${node.detail}` : node.label);
        return item;
      }
      case 'phase':
        return phaseItem(
          node.record,
          node.phase,
          node.status,
          node.order,
          node.current,
          node.tasksProgress,
        );
      case 'implementation':
        return implementationItem(node);
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
    const progress: TasksProgress | undefined =
      tasks.length > 0
        ? {
            done,
            total: tasks.length,
            nextId: tasks.find((task) => !task.checked)?.id,
          }
        : undefined;

    // 1. One explicit next action, so the tree always answers "what now?".
    const next = nextStep(record, progress);
    if (next) {
      nodes.push({ kind: 'action', record, ...next });
    }

    // 2. The pipeline in chronological order: Requirements -> Design -> Tasks.
    const currentPhase = action.kind === 'implement' ? undefined : action.phase;
    PHASES.forEach((phase, index) => {
      nodes.push({
        kind: 'phase',
        record,
        phase,
        status: phaseStatus(spec, phase, record.exists[phase]),
        order: index + 1,
        current: phase === currentPhase,
        tasksProgress: phase === 'tasks' ? progress : undefined,
      });
    });

    // 3. Implementation is a fourth step once every phase is approved.
    if (action.kind === 'implement') {
      if (!progress) {
        nodes.push({
          kind: 'implementation',
          record,
          state: 'missing-tasks',
          remaining: 0,
        });
      } else {
        const nextTask = tasks.find((task) => !task.checked);
        nodes.push({
          kind: 'implementation',
          record,
          state: nextTask ? 'in-progress' : 'complete',
          progress,
          nextTask,
          remaining: tasks.length - done,
        });
      }
    }

    return nodes;
  }
}
