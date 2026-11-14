// Pure aggregation for the team-facing spec overview. It reads repository
// state plus the local run records that are actually visible in this window.
// The UI labels that scope explicitly: a local run is not team-wide truth.
import { buildOverviewReport, type OverviewReport } from './overviewReport';
import type { RunState } from '../run/claudeRunner';
import { PHASE_META } from './phases';
import { buildSpecProgress, type SpecStage, type Verification } from './progress';
import {
  specCreatedAt,
  specUpdatedAt,
  type RoadmapInfo,
  type SpecRecord,
  type ValidationFile,
} from './repository';
import { type PhaseKey, type PhaseStatus, type SpecJson } from './spec';

export type OverviewRunState = 'none' | 'idle' | 'running' | 'input' | 'failed';

export interface OverviewRun {
  id: string;
  skill: string;
  status: RunState['status'];
  pending?: 'permission' | 'question';
  startedAt: number;
  endedAt?: number;
}

export interface OverviewSpec {
  id: string;
  label: string;
  stage: SpecStage;
  completed: boolean;
  implementationComplete: boolean;
  approvals: Record<PhaseKey, PhaseStatus>;
  reviewPhases: PhaseKey[];
  tasksDone: number;
  tasksTotal: number;
  status: string;
  statusDetail?: string;
  blockedReason?: string;
  blockedKind?: 'explicit' | 'dependency';
  dependencies: string[];
  hasDependencyInfo: boolean;
  waitingOn: string[];
  dependencyUnknown: string[];
  downstream: string[];
  verification: Verification;
  runs: OverviewRun[];
  runState: OverviewRunState;
  runningCount: number;
  pendingCount: number;
  latestRunId?: string;
  createdAt: number;
  updatedAt?: number;
  /** Recorded completion signal (validation or last update) when verified. */
  completedAt?: number;
  /** Latest spec or run activity, used for stable in-group ordering. */
  activityAt: number;
  dir: string;
  tasksPath: string;
  error?: string;
}

export interface OverviewKpi {
  inProgress: number;
  blocked: number;
  blockedExplicit: number;
  blockedDependency: number;
  reviewPending: number;
  reviews: number;
  verificationPending: number;
  verificationFailed: number;
  done: number;
  tasksDone: number;
  tasksTotal: number;
}

export type OverviewDependencyKind = 'waiting' | 'ready' | 'downstream' | 'revalidation';

export interface OverviewDependency {
  kind: OverviewDependencyKind;
  specId: string;
  specLabel: string;
  text: string;
  related: { id: string; label: string }[];
}

export type OverviewEventKind = 'spec' | 'run' | 'verification';
export type OverviewEventScope = 'repo' | 'local';

export interface OverviewEvent {
  id: string;
  kind: OverviewEventKind;
  scope: OverviewEventScope;
  at: number;
  specId?: string;
  specLabel?: string;
  runId?: string;
  text: string;
}

export interface OverviewModel {
  report: OverviewReport;
  generatedAt: number;
  projectName: string;
  dependencyInfo: 'available' | 'none';
  kpi: OverviewKpi;
  specs: OverviewSpec[];
  dependencies: OverviewDependency[];
  events: OverviewEvent[];
}

export interface OverviewSpecInput {
  record: SpecRecord;
  tasks?: string;
  validation?: ValidationFile;
}

export interface OverviewInput {
  projectName: string;
  specs: OverviewSpecInput[];
  runs: RunState[];
  roadmap?: RoadmapInfo;
  now: number;
}

const readStringList = (value: unknown): string[] => {
  if (typeof value === 'string') {
    return value.trim() ? [value.trim()] : [];
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim());
  }
  return [];
};

/** Explicit block metadata only; never inferred from age or past failures. */
const explicitBlockReason = (spec: SpecJson | null): string | undefined => {
  if (!spec) {
    return undefined;
  }
  const raw = spec as Record<string, unknown>;
  for (const key of ['blocked_reason', 'blockedReason']) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  const blocked = raw.blocked;
  if (typeof blocked === 'string' && blocked.trim()) {
    return blocked.trim();
  }
  if (blocked && typeof blocked === 'object') {
    const reason = (blocked as Record<string, unknown>).reason;
    if (typeof reason === 'string' && reason.trim()) {
      return reason.trim();
    }
  }
  const blockers = readStringList(raw.blockers ?? raw.blocked_by ?? raw.blockedBy);
  return blockers.length > 0 ? blockers.join(', ') : undefined;
};

const toOverviewRun = (run: RunState): OverviewRun => ({
  id: run.id,
  skill: run.skill,
  status: run.status,
  pending: run.pending?.kind,
  startedAt: run.startedAt,
  endedAt: run.endedAt,
});

const runSummary = (
  runs: OverviewRun[],
): Pick<OverviewSpec, 'runState' | 'runningCount' | 'pendingCount' | 'latestRunId'> => {
  const pending = runs.filter((run) => run.pending !== undefined);
  const running = runs.filter((run) => run.status === 'running' && run.pending === undefined);
  const latest = [...runs].sort(
    (left, right) => (right.endedAt ?? right.startedAt) - (left.endedAt ?? left.startedAt),
  )[0];
  const latestFailed = latest?.status === 'error' ? latest : undefined;
  const latestAction = pending[0] ?? running[0] ?? latest;

  const runState: OverviewRunState =
    pending.length > 0
      ? 'input'
      : running.length > 0
        ? 'running'
        : latestFailed
          ? 'failed'
          : runs.length > 0
            ? 'idle'
            : 'none';

  return {
    runState,
    runningCount: running.length,
    pendingCount: pending.length,
    latestRunId: latestAction?.id,
  };
};

const buildBaseSpec = (input: OverviewSpecInput, runs: RunState[]): OverviewSpec => {
  const { record } = input;
  const progress = buildSpecProgress(record, input.tasks, input.validation);

  const specRuns = runs
    .filter((run) => run.feature === record.id && run.status !== 'preview')
    .map(toOverviewRun)
    .sort((left, right) => right.startedAt - left.startedAt);
  const runInfo = runSummary(specRuns);

  const updatedAt = specUpdatedAt(record);
  const completedAt = progress.completed
    ? Math.max(updatedAt ?? 0, progress.verification.at ?? 0) || undefined
    : undefined;
  const activityAt = Math.max(
    updatedAt ?? 0,
    progress.verification.at ?? 0,
    ...specRuns.map((run) => run.endedAt ?? run.startedAt),
  );

  return {
    id: record.id,
    label: record.spec?.feature_name?.trim() || record.id,
    stage: progress.stage,
    completed: progress.completed,
    implementationComplete: progress.implementationComplete,
    approvals: progress.approvals,
    reviewPhases: progress.reviewPhases,
    tasksDone: progress.tasksDone,
    tasksTotal: progress.tasksTotal,
    status: '',
    dependencies: [],
    hasDependencyInfo: false,
    waitingOn: [],
    dependencyUnknown: [],
    downstream: [],
    verification: progress.verification,
    runs: specRuns,
    ...runInfo,
    createdAt: specCreatedAt(record),
    updatedAt,
    completedAt,
    activityAt,
    dir: record.dir,
    tasksPath: record.artifacts.tasks,
    error: record.specError,
  };
};

const finalizeStatus = (
  spec: OverviewSpec,
  explicitBlock: string | undefined,
  byId: Map<string, OverviewSpec>,
): void => {
  if (spec.completed) {
    spec.status = 'Verified';
    return;
  }
  if (spec.error) {
    spec.status = 'spec.json invalid';
    spec.statusDetail = spec.error;
    return;
  }

  const labelFor = (id: string): string => byId.get(id)?.label ?? id;
  const dependencyWait = spec.waitingOn.length > 0;

  if (explicitBlock) {
    spec.blockedReason = explicitBlock;
    spec.blockedKind = 'explicit';
  } else if (dependencyWait) {
    spec.blockedKind = 'dependency';
    spec.blockedReason = `Waiting on ${spec.waitingOn.map(labelFor).join(', ')}`;
  }

  if (explicitBlock) {
    spec.status = `Blocked: ${explicitBlock}`;
    return;
  }
  if (spec.dependencyUnknown.length > 0) {
    spec.status = `Dependency status unknown: ${spec.dependencyUnknown.map(labelFor).join(', ')}`;
    return;
  }
  if (spec.waitingOn.length > 0) {
    spec.status = `Waiting on ${spec.waitingOn.map(labelFor).join(', ')}`;
    return;
  }
  if (spec.runState === 'input') {
    spec.status = spec.pendingCount > 1 ? `Input waiting (${spec.pendingCount})` : 'Input waiting';
    if (spec.runningCount > 0) {
      spec.statusDetail = `${spec.runningCount} more running`;
    }
    return;
  }
  if (spec.runState === 'running') {
    spec.status = spec.runningCount > 1 ? `${spec.runningCount} running` : 'Running';
    return;
  }
  if (spec.implementationComplete) {
    if (spec.verification.status === 'failed') {
      spec.status = 'Verification failed';
      spec.statusDetail = spec.verification.decision;
      return;
    }
    if (spec.verification.status === 'stale') {
      spec.status = 'Verification result is stale';
      spec.statusDetail = spec.verification.detail;
      return;
    }
    if (spec.verification.status === 'manual') {
      spec.status = 'Manual verification required';
      return;
    }
    if (spec.verification.status === 'unconfirmed') {
      spec.status = 'Verification result unconfirmed';
      spec.statusDetail = spec.verification.detail;
      return;
    }
    if (spec.verification.status === 'error') {
      spec.status = 'Verification info unavailable';
      spec.statusDetail = spec.verification.detail;
      return;
    }
    if (spec.stage === 'verification') {
      spec.status = 'Verification pending';
      return;
    }
  }
  if (spec.reviewPhases.length > 0) {
    spec.status = `Review pending: ${PHASE_META[spec.reviewPhases[0]].label}`;
    if (spec.runState === 'failed') {
      spec.statusDetail = 'Last run failed';
    }
    return;
  }
  if (spec.runState === 'failed') {
    spec.status = 'Last run failed';
    spec.statusDetail = 'No active run';
    return;
  }
  if (spec.runState === 'none') {
    spec.status = 'No run record';
    return;
  }
  if (spec.runState === 'idle') {
    spec.status = 'No active run';
    return;
  }
  spec.status = 'In progress';
};

const buildDependencies = (
  specs: OverviewSpec[],
  roadmap: RoadmapInfo | undefined,
): OverviewDependency[] => {
  if (!roadmap) {
    return [];
  }

  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  const notes: OverviewDependency[] = [];
  const labelFor = (id: string): string => byId.get(id)?.label ?? id;

  for (const spec of specs) {
    if (spec.completed || spec.error) {
      continue;
    }
    const waiting = [...spec.waitingOn, ...spec.dependencyUnknown];
    if (waiting.length > 0) {
      notes.push({
        kind: 'waiting',
        specId: spec.id,
        specLabel: spec.label,
        text:
          spec.dependencyUnknown.length > 0
            ? `Dependency status unknown: ${spec.dependencyUnknown.map(labelFor).join(', ')}`
            : `Waiting on ${spec.waitingOn.map(labelFor).join(', ')}`,
        related: waiting.map((id) => ({ id, label: labelFor(id) })),
      });
    }
  }

  for (const spec of specs) {
    if (
      spec.completed ||
      spec.blockedReason ||
      !spec.hasDependencyInfo ||
      spec.waitingOn.length > 0 ||
      spec.dependencyUnknown.length > 0
    ) {
      continue;
    }
    if (spec.stage === 'requirements' && spec.approvals.requirements === 'missing') {
      notes.push({
        kind: 'ready',
        specId: spec.id,
        specLabel: spec.label,
        text: 'Dependency conditions satisfied; ready to start',
        related: spec.dependencies.map((id) => ({ id, label: labelFor(id) })),
      });
    }
  }

  for (const spec of specs) {
    if (spec.completed || spec.error || spec.downstream.length === 0) {
      continue;
    }
    notes.push({
      kind: 'downstream',
      specId: spec.id,
      specLabel: spec.label,
      text: `Downstream specs waiting: ${spec.downstream.map(labelFor).join(', ')}`,
      related: spec.downstream.map((id) => ({ id, label: labelFor(id) })),
    });
  }

  for (const spec of specs) {
    if (!spec.implementationComplete || spec.verification.status !== 'stale') {
      continue;
    }
    notes.push({
      kind: 'revalidation',
      specId: spec.id,
      specLabel: spec.label,
      text: 'Verification result is older than the current artifacts',
      related: [],
    });
  }

  return notes;
};

const buildEvents = (specs: OverviewSpec[], runs: RunState[], now: number): OverviewEvent[] => {
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  const events: OverviewEvent[] = [];

  for (const spec of specs) {
    if (spec.createdAt > 0) {
      events.push({
        id: `spec:${spec.id}:created`,
        kind: 'spec',
        scope: 'repo',
        at: spec.createdAt,
        specId: spec.id,
        specLabel: spec.label,
        text: 'Spec added',
      });
    }
    if (spec.updatedAt && spec.updatedAt > spec.createdAt) {
      events.push({
        id: `spec:${spec.id}:updated`,
        kind: 'spec',
        scope: 'repo',
        at: spec.updatedAt,
        specId: spec.id,
        specLabel: spec.label,
        text: 'Spec updated',
      });
    }
    if (spec.verification.at) {
      events.push({
        id: `verification:${spec.id}`,
        kind: 'verification',
        scope: 'repo',
        at: spec.verification.at,
        specId: spec.id,
        specLabel: spec.label,
        text: spec.verification.decision
          ? `Validation recorded: ${spec.verification.decision}`
          : 'Validation report updated',
      });
    }
  }

  for (const run of runs) {
    if (run.status === 'preview') {
      continue;
    }
    const spec = byId.get(run.feature);
    if (!spec) {
      continue;
    }
    events.push({
      id: `run:${run.id}:started`,
      kind: 'run',
      scope: 'local',
      at: run.startedAt,
      specId: spec.id,
      specLabel: spec.label,
      runId: run.id,
      text: `Run started: /${run.skill}`,
    });
    if (run.endedAt) {
      const outcome =
        run.status === 'done'
          ? 'Run done'
          : run.status === 'cancelled'
            ? 'Run cancelled'
            : run.status === 'error'
              ? 'Run failed'
              : 'Run finished';
      events.push({
        id: `run:${run.id}:ended`,
        kind: 'run',
        scope: 'local',
        at: run.endedAt,
        specId: spec.id,
        specLabel: spec.label,
        runId: run.id,
        text: outcome,
      });
    }
    if (run.pending) {
      events.push({
        id: `run:${run.id}:pending`,
        kind: 'run',
        scope: 'local',
        at: now,
        specId: spec.id,
        specLabel: spec.label,
        runId: run.id,
        text:
          run.pending.kind === 'question' ? 'Input waiting: question' : 'Input waiting: permission',
      });
    }
  }

  return events.sort((left, right) => right.at - left.at).slice(0, 50);
};

const rank = (spec: OverviewSpec): number => {
  if (
    spec.error ||
    spec.blockedReason ||
    spec.runState === 'failed' ||
    (spec.implementationComplete && spec.verification.status === 'failed') ||
    (spec.implementationComplete && spec.verification.status === 'error')
  ) {
    return 0;
  }
  if (spec.runState === 'running') {
    return 1;
  }
  if (
    spec.runState === 'input' ||
    spec.reviewPhases.length > 0 ||
    spec.dependencyUnknown.length > 0
  ) {
    return 2;
  }
  return 3;
};

/** Builds the overview model. Pure: no file system or VS Code access. */
export const buildOverview = (input: OverviewInput): OverviewModel => {
  const { projectName, roadmap, runs, specs, now } = input;
  const overviewSpecs = specs.map((spec) => buildBaseSpec(spec, runs));
  const byId = new Map(overviewSpecs.map((spec) => [spec.id, spec]));
  const dependencyInfo: OverviewModel['dependencyInfo'] =
    roadmap && (roadmap.order.length > 0 || Object.keys(roadmap.deps).length > 0)
      ? 'available'
      : 'none';

  for (const spec of overviewSpecs) {
    spec.dependencies = dependencyInfo === 'available' ? (roadmap?.deps[spec.id] ?? []) : [];
    spec.hasDependencyInfo =
      dependencyInfo === 'available' &&
      roadmap !== undefined &&
      (roadmap.order.includes(spec.id) ||
        Object.prototype.hasOwnProperty.call(roadmap.deps, spec.id));
    spec.waitingOn = spec.dependencies.filter((id) => {
      const dependency = byId.get(id);
      return dependency !== undefined && !dependency.completed;
    });
    spec.dependencyUnknown = spec.dependencies.filter((id) => !byId.has(id));
    if (!spec.hasDependencyInfo) {
      spec.waitingOn = [];
      spec.dependencyUnknown = [];
      spec.dependencies = [];
    }
  }

  for (const spec of overviewSpecs) {
    if (spec.completed || spec.error) {
      continue;
    }
    for (const dependencyId of spec.dependencies) {
      const dependency = byId.get(dependencyId);
      if (dependency) {
        dependency.downstream.push(spec.id);
      }
    }
  }

  for (const inputSpec of specs) {
    const spec = byId.get(inputSpec.record.id);
    if (spec) {
      finalizeStatus(spec, explicitBlockReason(inputSpec.record.spec), byId);
    }
  }

  const inProgress = overviewSpecs.filter((spec) => !spec.completed);
  inProgress.sort((left, right) => {
    const byRank = rank(left) - rank(right);
    if (byRank !== 0) {
      return byRank;
    }
    const byUpdated = right.activityAt - left.activityAt;
    return byUpdated !== 0 ? byUpdated : left.label.localeCompare(right.label);
  });
  const completed = overviewSpecs
    .filter((spec) => spec.completed)
    .sort((left, right) => {
      const byUpdated = right.activityAt - left.activityAt;
      return byUpdated !== 0 ? byUpdated : left.label.localeCompare(right.label);
    });
  const sortedSpecs = [...inProgress, ...completed];

  return {
    report: buildOverviewReport(projectName, sortedSpecs, now),
    generatedAt: now,
    projectName,
    dependencyInfo,
    kpi: {
      inProgress: inProgress.length,
      blocked: sortedSpecs.filter((spec) => spec.blockedReason !== undefined).length,
      blockedExplicit: sortedSpecs.filter((spec) => spec.blockedKind === 'explicit').length,
      blockedDependency: sortedSpecs.filter((spec) => spec.blockedKind === 'dependency').length,
      reviewPending: sortedSpecs.filter((spec) => spec.reviewPhases.length > 0).length,
      reviews: sortedSpecs.reduce((total, spec) => total + spec.reviewPhases.length, 0),
      verificationPending: sortedSpecs.filter(
        (spec) => spec.implementationComplete && !spec.completed,
      ).length,
      verificationFailed: sortedSpecs.filter(
        (spec) => spec.implementationComplete && spec.verification.status === 'failed',
      ).length,
      done: completed.length,
      tasksDone: sortedSpecs.reduce((total, spec) => total + spec.tasksDone, 0),
      tasksTotal: sortedSpecs.reduce((total, spec) => total + spec.tasksTotal, 0),
    },
    specs: sortedSpecs,
    dependencies: buildDependencies(
      sortedSpecs,
      dependencyInfo === 'available' ? roadmap : undefined,
    ),
    events: buildEvents(sortedSpecs, runs, now),
  };
};

/** Empty model used before a workspace is available. */
export const emptyOverview = (now: number, projectName = 'Workspace'): OverviewModel => ({
  report: buildOverviewReport(projectName, [], now),
  generatedAt: now,
  projectName,
  dependencyInfo: 'none',
  kpi: {
    inProgress: 0,
    blocked: 0,
    blockedExplicit: 0,
    blockedDependency: 0,
    reviewPending: 0,
    reviews: 0,
    verificationPending: 0,
    verificationFailed: 0,
    done: 0,
    tasksDone: 0,
    tasksTotal: 0,
  },
  specs: [],
  dependencies: [],
  events: [],
});
