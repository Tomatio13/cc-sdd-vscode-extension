import * as vscode from 'vscode';
import {
  IMPLEMENTATION_SKILL,
  PHASE_META,
  VALIDATE_IMPL_SKILL,
} from '../core/phases';
import {
  buildSpecProgress,
  verificationLabel,
  type SpecProgress,
  type Verification,
} from '../core/progress';
import {
  specCreatedAt,
  type RoadmapInfo,
  type SpecRecord,
  type SteeringStatus,
  type ValidationFile,
} from '../core/repository';
import { PHASES, type PhaseKey, type PhaseStatus } from '../core/spec';
import type { RunState } from '../run/claudeRunner';
import {
  countLabel,
  phaseStateIcon,
  phaseStateLabel,
} from './treeState';

type StageKey = PhaseKey | 'implementation' | 'verification';

export type SpecSort = 'newest' | 'roadmap';

interface SpecRunInfo {
  all: RunState[];
  active?: RunState;
  latest?: RunState;
  running: number;
  pending: number;
  latestFailed: boolean;
}

export type SpecTreeNode =
  | { kind: 'spec'; record: SpecRecord; deps?: string[]; progress: SpecProgress }
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
      kind: 'stage';
      record: SpecRecord;
      progress: SpecProgress;
      stage: StageKey;
      order: number;
      current: boolean;
      runs: SpecRunInfo;
    }
  | { kind: 'message'; label: string; description?: string };

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

const approvedCount = (progress: SpecProgress): number =>
  PHASES.filter((phase) => progress.approvals[phase] === 'approved').length;

const runsForSpec = (record: SpecRecord, runs: RunState[]): SpecRunInfo => {
  const matching = runs
    .filter((run) => run.feature === record.id && run.status !== 'preview')
    .sort((left, right) => right.startedAt - left.startedAt);
  const pending = matching.filter((run) => run.pending !== undefined);
  const running = matching.filter(
    (run) => run.status === 'running' && run.pending === undefined,
  );
  const latest = [...matching].sort(
    (left, right) => (right.endedAt ?? right.startedAt) - (left.endedAt ?? left.startedAt),
  )[0];
  return {
    all: matching,
    active: pending[0] ?? running[0],
    latest,
    running: running.length,
    pending: pending.length,
    latestFailed: latest?.status === 'error',
  };
};

const activeRunOf = (runs: SpecRunInfo, skill: string): RunState | undefined =>
  runs.all.find(
    (run) =>
      run.skill === skill && (run.pending !== undefined || run.status === 'running'),
  );

const allApproved = (progress: SpecProgress): boolean =>
  PHASES.every((phase) => progress.approvals[phase] === 'approved');

const nextActionItem = (
  record: SpecRecord,
  progress: SpecProgress,
  runs: SpecRunInfo,
): Extract<SpecTreeNode, { kind: 'action' }> | undefined => {
  if (progress.completed || progress.next.kind === 'missing') {
    return undefined;
  }

  const next = progress.next;
  if (next.kind === 'generate') {
    return {
      kind: 'action',
      record,
      label: `Next: ${next.label}`,
      detail: next.detail,
      icon: 'play',
      command: next.phase
        ? {
            command: 'ccSdd.runPhase',
            title: 'Run Phase',
            arguments: [{ record, phase: next.phase }],
          }
        : undefined,
    };
  }

  if (next.kind === 'review' && next.phase) {
    const meta = PHASE_META[next.phase];
    return {
      kind: 'action',
      record,
      label: `Next: ${next.label}`,
      detail: next.detail,
      icon: 'eye',
      tooltip: `Open ${meta.file}, then approve it from the check button on step ${PHASES.indexOf(
        next.phase,
      ) + 1}.`,
      command: {
        command: 'ccSdd.openArtifact',
        title: 'Open Artifact',
        arguments: [{ record, phase: next.phase }],
      },
    };
  }

  if (next.kind === 'implement') {
    const implementationRun = activeRunOf(runs, IMPLEMENTATION_SKILL);
    if (implementationRun) {
      return {
        kind: 'action',
        record,
        label: 'Next: Open run',
        detail: implementationRun.pending ? 'Input waiting' : 'Running',
        icon: implementationRun.pending ? 'bell' : 'play',
        command: {
          command: 'ccSdd.openSpecRun',
          title: 'Open Run',
          arguments: [record],
        },
      };
    }
    return {
      kind: 'action',
      record,
      label: `Next: ${next.label}`,
      detail: runs.latestFailed
        ? 'Last run failed; review and restart'
        : `${countLabel(progress.tasksTotal - progress.tasksDone, 'task')} left`,
      icon: 'play',
      command: {
        command: 'ccSdd.runImpl',
        title: 'Run Implementation',
        arguments: [record],
      },
    };
  }

  if (next.kind === 'verify') {
    const validationRun = activeRunOf(runs, VALIDATE_IMPL_SKILL);
    if (validationRun) {
      return {
        kind: 'action',
        record,
        label: 'Next: Open verification run',
        detail: validationRun.pending ? 'Input waiting' : 'Running',
        icon: validationRun.pending ? 'bell' : 'shield',
        command: {
          command: 'ccSdd.openSpecRun',
          title: 'Open Run',
          arguments: [record],
        },
      };
    }
    const start = next.label === 'Start verification' || next.label === 'Revalidate';
    return {
      kind: 'action',
      record,
      label: `Next: ${next.label}`,
      detail: start ? 'impl-validation.md' : 'Open report',
      icon: start ? 'shield' : 'file',
      tooltip: start
        ? 'Run implementation validation and record the result in impl-validation.md.'
        : 'Open the recorded implementation validation report.',
      command: start
        ? {
            command: 'ccSdd.runValidateImpl',
            title: 'Run Implementation Validation',
            arguments: [record],
          }
        : {
            command: 'ccSdd.openValidation',
            title: 'Open Validation',
            arguments: [record],
          },
    };
  }

  if (next.kind === 'done') {
    return {
      kind: 'action',
      record,
      label: `Next: ${next.label}`,
      detail: 'impl-validation.md',
      icon: 'file',
      command: {
        command: 'ccSdd.openValidation',
        title: 'Open Validation',
        arguments: [record],
      },
    };
  }

  return undefined;
};

const specIcon = (
  record: SpecRecord,
  progress: SpecProgress,
  runs: SpecRunInfo,
): vscode.ThemeIcon => {
  if (record.specError) {
    return new vscode.ThemeIcon('warning');
  }
  if (progress.completed) {
    return new vscode.ThemeIcon('pass-filled');
  }
  if (progress.stage === 'verification') {
    if (activeRunOf(runs, VALIDATE_IMPL_SKILL)) {
      return new vscode.ThemeIcon('sync');
    }
    if (progress.verification.status === 'failed') {
      return new vscode.ThemeIcon('error');
    }
    if (progress.verification.status === 'verified') {
      return new vscode.ThemeIcon('pass-filled');
    }
    return new vscode.ThemeIcon('clock');
  }
  if (progress.stage === 'implementation') {
    if (progress.tasksTotal === 0) {
      return new vscode.ThemeIcon('warning');
    }
    return new vscode.ThemeIcon(
      activeRunOf(runs, IMPLEMENTATION_SKILL) ? 'rocket' : 'circle-outline',
    );
  }
  if (progress.reviewPhases.length > 0) {
    return new vscode.ThemeIcon('clock');
  }
  if (progress.stage === 'requirements' || progress.stage === 'design' || progress.stage === 'tasks') {
    return new vscode.ThemeIcon('circle-outline');
  }
  return new vscode.ThemeIcon('warning');
};

const specDescription = (
  active: boolean,
  progress: SpecProgress,
  runs: SpecRunInfo,
): string => {
  const parts: string[] = [];
  if (active) {
    parts.push('active');
  }
  parts.push(progress.stateLabel);
  if (progress.stage === 'verification') {
    const validationRun = activeRunOf(runs, VALIDATE_IMPL_SKILL);
    if (validationRun) {
      parts.push(validationRun.pending ? 'Input waiting' : 'Running');
    }
  }
  if (progress.stage === 'implementation') {
    const implementationRun = activeRunOf(runs, IMPLEMENTATION_SKILL);
    if (implementationRun) {
      parts.push(implementationRun.pending ? 'Input waiting' : 'Running');
    }
  }
  return parts.join(' · ');
};

const specItem = (
  node: Extract<SpecTreeNode, { kind: 'spec' }>,
  active: boolean,
  runs: SpecRunInfo,
): vscode.TreeItem => {
  const { record, progress } = node;
  const label = record.spec?.feature_name?.trim() || record.id;
  const item = new vscode.TreeItem(
    label,
    progress.completed
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.Expanded,
  );
  item.id = `spec:${record.id}`;
  item.contextValue = progress.completed
    ? 'spec-complete'
    : progress.stage === 'implementation'
      ? 'spec-implementing'
      : 'spec';
  item.description = specDescription(active, progress, runs);
  item.iconPath = specIcon(record, progress, runs);
  item.command = {
    command: 'ccSdd.selectSpec',
    title: 'Select Spec',
    arguments: [record],
  };

  const tooltip = new vscode.MarkdownString();
  tooltip.supportThemeIcons = true;
  tooltip.appendMarkdown(`**${label}**\n\n`);
  tooltip.appendMarkdown(`Path: \`${record.dir}\`\n\n`);
  if (node.deps && node.deps.length > 0) {
    tooltip.appendMarkdown(`After: ${node.deps.join(', ')}\n\n`);
  }
  tooltip.appendMarkdown(`Stage: ${progress.stageLabel}\n\n`);
  tooltip.appendMarkdown(`State: ${progress.stateLabel}\n\n`);
  tooltip.appendMarkdown(`Next: ${progress.next.label}\n\n`);
  tooltip.appendMarkdown(
    `Steps: ${PHASES.map((phase) => {
      const status = progress.approvals[phase];
      const mark =
        status === 'approved'
          ? '$(pass-filled)'
          : status === 'generated'
            ? '$(clock)'
            : '$(circle-outline)';
      return `${mark} ${PHASE_META[phase].label}`;
    }).join('  ')}\n\n`,
  );
  tooltip.appendMarkdown(
    `Implementation: ${progress.tasksDone}/${progress.tasksTotal} tasks\n\n`,
  );
  tooltip.appendMarkdown(`Verification: ${verificationLabel(progress.verification)}\n\n`);
  if (progress.verification.detail) {
    tooltip.appendMarkdown(`${progress.verification.detail}\n\n`);
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

const phaseStageItem = (
  node: Extract<SpecTreeNode, { kind: 'stage' }>,
  phase: PhaseKey,
): vscode.TreeItem => {
  const { record, progress, order, current } = node;
  const meta = PHASE_META[phase];
  const status = progress.approvals[phase];
  const item = new vscode.TreeItem(`${order}. ${meta.label}`, vscode.TreeItemCollapsibleState.None);
  item.id = `stage:${record.id}:${phase}`;
  item.contextValue = `phase-${status}`;
  item.description =
    phase === 'tasks' && progress.tasksTotal > 0
      ? `${progress.tasksDone}/${progress.tasksTotal} done`
      : phaseStateLabel(status);
  item.iconPath = phaseIcon(status, current);

  const details = [
    `Step ${order} · ${meta.description}`,
    `Status: ${phaseStateLabel(status)}${current ? ' (current)' : ''}`,
    record.artifacts[phase],
    `Skill: /${meta.skill}`,
  ];
  if (phase === 'tasks' && progress.tasksTotal > 0) {
    details.push(`Progress: ${progress.tasksDone}/${progress.tasksTotal} done`);
  }
  item.tooltip = details.join('\n\n');
  item.command =
    status === 'missing'
      ? { command: 'ccSdd.runPhase', title: 'Run Phase', arguments: [{ record, phase }] }
      : { command: 'ccSdd.openArtifact', title: 'Open Artifact', arguments: [{ record, phase }] };
  return item;
};

const implementationStageItem = (
  node: Extract<SpecTreeNode, { kind: 'stage' }>,
): vscode.TreeItem => {
  const { record, progress, current, runs } = node;
  const item = new vscode.TreeItem('4. Implementation', vscode.TreeItemCollapsibleState.None);
  item.id = `stage:${record.id}:implementation`;

  if (!allApproved(progress)) {
    item.description = 'waiting for approvals';
    item.contextValue = 'impl-waiting';
    item.iconPath = new vscode.ThemeIcon('circle-slash');
    item.tooltip = 'Implementation starts after Requirements, Design, and Tasks are approved.';
    return item;
  }

  if (progress.tasksTotal === 0) {
    item.description = 'tasks.md missing';
    item.contextValue = 'impl-missing-tasks';
    item.iconPath = new vscode.ThemeIcon('warning');
    item.tooltip = 'tasks.md has no tasks. Create tasks before implementation.';
    item.command = {
      command: 'ccSdd.runPhase',
      title: 'Run Phase',
      arguments: [{ record, phase: 'tasks' as PhaseKey }],
    };
    return item;
  }

  const nextTask = progress.tasks.find((task) => !task.checked);
  const implementationRun = activeRunOf(runs, IMPLEMENTATION_SKILL);
  item.description = `${progress.tasksDone}/${progress.tasksTotal} done`;
  item.tooltip = [
    'Step 4 · implementation',
    `Progress: ${progress.tasksDone}/${progress.tasksTotal} done`,
    nextTask ? `Next task: ${nextTask.id}. ${nextTask.title}` : 'All tasks are complete.',
    implementationRun
      ? `Run: ${implementationRun.pending ? 'Input waiting' : 'Running'}`
      : 'No active implementation run in this window.',
  ].join('\n\n');

  if (progress.implementationComplete) {
    item.contextValue = 'impl-complete';
    item.iconPath = new vscode.ThemeIcon('pass-filled');
    item.command = {
      command: 'ccSdd.openArtifact',
      title: 'Open Tasks',
      arguments: [{ record, phase: 'tasks' as PhaseKey }],
    };
    return item;
  }

  if (implementationRun) {
    item.contextValue = 'impl-running';
    item.iconPath = new vscode.ThemeIcon('sync');
  } else {
    item.contextValue = 'impl-in-progress';
    item.iconPath = new vscode.ThemeIcon(current ? 'arrow-circle-right' : 'rocket');
  }
  item.command = nextTask
    ? {
        command: 'ccSdd.openTask',
        title: 'Open Task',
        arguments: [{ record, task: nextTask }],
      }
    : {
        command: 'ccSdd.openArtifact',
        title: 'Open Tasks',
        arguments: [{ record, phase: 'tasks' as PhaseKey }],
      };
  return item;
};

const verificationStatusDescription = (verification: Verification): string => {
  switch (verification.status) {
    case 'verified':
      return 'success (GO)';
    case 'failed':
      return `failed (${verification.decision ?? 'NO-GO'})`;
    case 'stale':
      return 'stale result';
    case 'manual':
      return 'manual required';
    case 'unconfirmed':
      return 'result unconfirmed';
    case 'error':
      return 'result unavailable';
    case 'none':
      return 'not run';
  }
};

const verificationStageItem = (
  node: Extract<SpecTreeNode, { kind: 'stage' }>,
): vscode.TreeItem => {
  const { record, progress, current } = node;
  const verification = progress.verification;
  const item = new vscode.TreeItem('5. Verification', vscode.TreeItemCollapsibleState.None);
  item.id = `stage:${record.id}:verification`;

  if (!progress.implementationComplete) {
    item.description = 'waiting for implementation';
    item.contextValue = 'verification-waiting';
    item.iconPath = new vscode.ThemeIcon('circle-slash');
    item.tooltip = 'Verification starts after all implementation tasks are complete.';
    return item;
  }

  item.description = verificationStatusDescription(verification);
  item.contextValue = `verification-${verification.status}`;

  const validationRun = activeRunOf(node.runs, VALIDATE_IMPL_SKILL);
  if (validationRun) {
    item.description = validationRun.pending ? 'input waiting' : 'running';
    item.contextValue = 'verification-running';
    item.iconPath = new vscode.ThemeIcon(validationRun.pending ? 'bell' : 'sync');
    item.command = {
      command: 'ccSdd.openSpecRun',
      title: 'Open Run',
      arguments: [record],
    };
    item.tooltip = [
      'Step 5 · verification',
      `Run: ${validationRun.pending ? 'Input waiting' : 'Running'}`,
      record.validationPath,
    ].join('\n\n');
    return item;
  }

  if (verification.status === 'verified') {
    item.iconPath = new vscode.ThemeIcon('pass-filled');
    item.command = {
      command: 'ccSdd.openValidation',
      title: 'Open Validation',
      arguments: [record],
    };
  } else if (verification.status === 'failed') {
    item.iconPath = new vscode.ThemeIcon('error');
    item.command = {
      command: 'ccSdd.openValidation',
      title: 'Open Validation',
      arguments: [record],
    };
  } else if (verification.status === 'none') {
    item.iconPath = new vscode.ThemeIcon(current ? 'arrow-circle-right' : 'circle-outline');
    item.command = {
      command: 'ccSdd.runValidateImpl',
      title: 'Run Implementation Validation',
      arguments: [record],
    };
  } else {
    item.iconPath = new vscode.ThemeIcon('warning');
    item.command = record.validationExists
      ? {
          command: 'ccSdd.openValidation',
          title: 'Open Validation',
          arguments: [record],
        }
      : {
          command: 'ccSdd.runValidateImpl',
          title: 'Run Implementation Validation',
          arguments: [record],
        };
  }

  const details = [
    `Step 5 · verification`,
    `Status: ${verificationLabel(verification)}`,
    record.validationPath,
  ];
  if (verification.at) {
    details.push(`Recorded: ${new Date(verification.at).toLocaleString()}`);
  }
  if (verification.detail) {
    details.push(verification.detail);
  }
  if (verification.items.length > 0) {
    details.push(
      ['Checks:', ...verification.items.map((check) => `- ${check.label}: ${check.value}`)].join('\n'),
    );
  } else {
    details.push('No itemized verification checks recorded.');
  }
  item.tooltip = details.join('\n\n');
  return item;
};

const stageItem = (node: Extract<SpecTreeNode, { kind: 'stage' }>): vscode.TreeItem => {
  if (node.stage === 'implementation') {
    return implementationStageItem(node);
  }
  if (node.stage === 'verification') {
    return verificationStageItem(node);
  }
  return phaseStageItem(node, node.stage);
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
    private readonly readValidation: (record: SpecRecord) => Promise<ValidationFile>,
    private readonly getRuns: () => RunState[],
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
      const progress = new Map<string, SpecProgress>();
      await Promise.all(
        records.map(async (record) => {
          const [tasks, validation] = await Promise.all([
            this.readArtifact(record, 'tasks'),
            this.readValidation(record),
          ]);
          progress.set(record.id, buildSpecProgress(record, tasks, validation));
        }),
      );

      const nodes: SpecTreeNode[] = [];
      const roadmap = info.roadmap;
      if (roadmap) {
        nodes.push({ kind: 'roadmap', info: roadmap });
      }

      const sorted =
        this.getSort() === 'roadmap' && roadmap
          ? [...records].sort((left, right) => compareRoadmap(roadmap, left, right))
          : [...records].sort(compareNewest);

      for (const record of sorted) {
        nodes.push({
          kind: 'spec',
          record,
          deps: roadmap?.deps[record.id],
          progress: progress.get(record.id) as SpecProgress,
        });
      }

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
        return specItem(node, this.activeId === node.record.id, runsForSpec(node.record, this.getRuns()));
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
      case 'stage':
        return stageItem(node);
      case 'message': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.description = node.description;
        item.contextValue = 'status-message';
        return item;
      }
    }
  }

  private async buildBody(record: SpecRecord): Promise<SpecTreeNode[]> {
    if (!record.spec) {
      return [
        {
          kind: 'message',
          label: 'spec.json is missing or invalid',
          description: record.specError ?? 'Run /kiro-spec-init first',
        },
      ];
    }

    const [tasks, validation] = await Promise.all([
      this.readArtifact(record, 'tasks'),
      this.readValidation(record),
    ]);
    const progress = buildSpecProgress(record, tasks, validation);
    const runs = runsForSpec(record, this.getRuns());
    const nodes: SpecTreeNode[] = [];

    const next = nextActionItem(record, progress, runs);
    if (next) {
      nodes.push(next);
    }

    PHASES.forEach((phase, index) => {
      nodes.push({
        kind: 'stage',
        record,
        progress,
        stage: phase,
        order: index + 1,
        current: progress.stage === phase,
        runs,
      });
    });
    nodes.push({
      kind: 'stage',
      record,
      progress,
      stage: 'implementation',
      order: 4,
      current: progress.stage === 'implementation',
      runs,
    });
    nodes.push({
      kind: 'stage',
      record,
      progress,
      stage: 'verification',
      order: 5,
      current: progress.stage === 'verification',
      runs,
    });

    return nodes;
  }
}
