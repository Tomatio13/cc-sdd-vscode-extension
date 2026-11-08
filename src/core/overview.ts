// Pure aggregation for the leader / PM overview board. The overview is built
// from three sources that already exist: specs (approval state + tasks.md),
// live runs in this window, and Claude Code session transcripts (which also
// reveal work happening in other windows or terminals).
import type { RunState } from '../run/claudeRunner';
import type { SessionRecord } from './sessions';
import type { SpecRecord } from './repository';
import { PHASE_META } from './phases';
import {
  PHASES,
  nextAction,
  phaseStatus,
  type PhaseKey,
  type PhaseStatus,
} from './spec';
import { parseTasks } from './tasks';

/** A session file touched within this window is treated as "active elsewhere". */
export const ACTIVE_SESSION_MS = 3 * 60 * 1000;

export type OverviewColumn = 'attention' | 'running' | 'done' | 'failed';
export type OverviewTone = 'attention' | 'running' | 'done' | 'failed' | 'cancelled';

export const OVERVIEW_COLUMNS: OverviewColumn[] = ['attention', 'running', 'done', 'failed'];

export interface OverviewCard {
  id: string;
  runId?: string;
  sessionId?: string;
  specId?: string;
  reviewPhase?: PhaseKey;
  source: 'live' | 'session' | 'review';
  feature: string;
  skill: string;
  column: OverviewColumn;
  tone: OverviewTone;
  label: string;
  detail?: string;
  permissionMode?: string;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  tokens?: number;
  costUsd?: number;
  pendingKind?: 'permission' | 'question';
}

export interface OverviewSpec {
  id: string;
  label: string;
  phase: string;
  ready: boolean;
  approvals: Record<PhaseKey, PhaseStatus>;
  approvedCount: number;
  reviewPhases: PhaseKey[];
  tasksDone: number;
  tasksTotal: number;
  nextLabel: string;
  active: number;
  attention: number;
  sessionsToday: number;
  costTodayUsd?: number;
  updatedAt?: number;
  reviewSince?: number;
  dir: string;
  tasksPath: string;
  error?: string;
}

export interface OverviewKpi {
  needsYou: number;
  running: number;
  failed: number;
  reviews: number;
  specs: number;
  activeSpecs: number;
  tasksDone: number;
  tasksTotal: number;
  sessionsToday: number;
  spendTodayUsd: number;
}

export interface OverviewModel {
  generatedAt: number;
  kpi: OverviewKpi;
  columns: Record<OverviewColumn, OverviewCard[]>;
  specs: OverviewSpec[];
}

export interface OverviewSpecInput {
  record: SpecRecord;
  tasks?: string;
}

export interface OverviewInput {
  specs: OverviewSpecInput[];
  runs: RunState[];
  sessions: SessionRecord[];
  now: number;
}

const shorten = (value: string, max = 160): string => {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
};

const runCost = (run: RunState): number | undefined => {
  if (typeof run.summary?.costUsd === 'number') {
    return run.summary.costUsd;
  }
  return typeof run.usageCostUsd === 'number' ? run.usageCostUsd : undefined;
};

const runTokens = (run: RunState): number | undefined => {
  const usage = run.summary?.usage ?? run.usage;
  if (!usage) {
    return undefined;
  }
  const total = usage.inputTokens + usage.outputTokens;
  return total > 0 ? total : undefined;
};

const runDetail = (run: RunState): string | undefined => {
  if (run.pending) {
    if (run.pending.kind === 'permission') {
      const summary = run.pending.summary ? `: ${run.pending.summary}` : '';
      return shorten(`Permission for ${run.pending.toolName ?? 'tool'}${summary}`);
    }
    const questions = (run.pending.questions ?? []).map((question) => question.question);
    if (questions.length > 0) {
      return shorten(questions.join(' / '));
    }
  }
  for (let index = run.segments.length - 1; index >= 0; index -= 1) {
    const segment = run.segments[index];
    if (segment.kind === 'toolresult' || !segment.text.trim()) {
      continue;
    }
    return shorten(segment.text);
  }
  return undefined;
};

const runColumn = (run: RunState): OverviewColumn => {
  if (run.pending) {
    return 'attention';
  }
  switch (run.status) {
    case 'running':
      return 'running';
    case 'done':
      return 'done';
    case 'error':
    case 'cancelled':
      return 'failed';
    default:
      return 'running';
  }
};

const runTone = (run: RunState): OverviewTone => {
  if (run.pending) {
    return 'attention';
  }
  switch (run.status) {
    case 'running':
      return 'running';
    case 'done':
      return 'done';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'failed';
  }
};

const runLabel = (run: RunState): string => {
  if (run.pending) {
    return run.pending.kind === 'question' ? 'Answer needed' : 'Permission needed';
  }
  switch (run.status) {
    case 'running':
      return 'Running';
    case 'done':
      return 'Done';
    case 'error':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return run.status;
  }
};

const toRunCard = (run: RunState, now: number): OverviewCard | undefined => {
  if (run.status === 'preview') {
    return undefined;
  }
  const card: OverviewCard = {
    id: `run:${run.id}`,
    runId: run.id,
    sessionId: run.sessionId,
    source: 'live',
    feature: run.feature || run.skill,
    skill: run.skill,
    column: runColumn(run),
    tone: runTone(run),
    label: runLabel(run),
    startedAt: run.startedAt,
    updatedAt: run.endedAt ?? (run.status === 'running' ? now : run.startedAt),
    endedAt: run.endedAt,
  };
  const detail = runDetail(run);
  if (detail) {
    card.detail = detail;
  }
  if (run.permissionMode) {
    card.permissionMode = run.permissionMode;
  }
  const tokens = runTokens(run);
  if (tokens !== undefined) {
    card.tokens = tokens;
  }
  const cost = runCost(run);
  if (cost !== undefined) {
    card.costUsd = cost;
  }
  if (run.pending) {
    card.pendingKind = run.pending.kind;
    card.updatedAt = now;
  }
  return card;
};

const toSessionCard = (session: SessionRecord, now: number): OverviewCard | undefined => {
  const age = now - session.updatedAt;
  if (age < 0 || age > ACTIVE_SESSION_MS) {
    return undefined;
  }
  // A recent mtime is not enough: completed transcripts keep receiving
  // metadata entries. Only surface sessions whose tail says work is still in
  // flight (or blocked on a question).
  const state = session.activity?.state;
  if (state === 'stopped' || state === 'unknown') {
    return undefined;
  }
  const waiting = state === 'waiting';
  const card: OverviewCard = {
    id: `session:${session.id}`,
    sessionId: session.id,
    source: 'session',
    feature: session.feature ?? session.title,
    skill: session.skill ?? 'session',
    column: waiting ? 'attention' : 'running',
    tone: waiting ? 'attention' : 'running',
    label: waiting ? 'Question elsewhere' : 'Active elsewhere',
    startedAt: session.startedAt ?? session.updatedAt,
    updatedAt: session.updatedAt,
  };
  if (waiting) {
    card.pendingKind = 'question';
  }
  if (session.lastMessage) {
    card.detail = shorten(session.lastMessage);
  }
  const tokens = session.usage
    ? session.usage.inputTokens + session.usage.outputTokens
    : undefined;
  if (tokens !== undefined && tokens > 0) {
    card.tokens = tokens;
  }
  if (typeof session.costUsd === 'number') {
    card.costUsd = session.costUsd;
  }
  return card;
};

const startOfDay = (now: number): number => {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

const parseUpdatedAt = (value: string | undefined): number | undefined => {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const buildSpec = (
  input: OverviewSpecInput,
  cards: OverviewCard[],
  sessions: SessionRecord[],
  dayStart: number,
): OverviewSpec => {
  const { record } = input;
  const tasks = parseTasks(input.tasks ?? '');
  const done = tasks.filter((task) => task.checked).length;

  const approvals = {} as Record<PhaseKey, PhaseStatus>;
  const reviewPhases: PhaseKey[] = [];
  for (const phase of PHASES) {
    approvals[phase] = phaseStatus(record.spec, phase, record.exists[phase]);
    const approval = record.spec?.approvals[phase];
    if (approval?.generated === true && approval.approved !== true) {
      reviewPhases.push(phase);
    }
  }

  const matching = cards.filter(
    (card) => card.feature === record.id && card.column !== 'done' && card.column !== 'failed',
  );
  const sessionFeature = record.id;
  const sessionCost = sessions
    .filter(
      (session) =>
        session.feature === sessionFeature &&
        session.updatedAt >= dayStart &&
        typeof session.costUsd === 'number',
    )
    .reduce((total, session) => total + (session.costUsd ?? 0), 0);

  const spec: OverviewSpec = {
    id: record.id,
    label: record.spec?.feature_name?.trim() || record.id,
    phase: record.spec?.phase ?? 'unknown',
    ready: record.spec?.ready_for_implementation === true,
    approvals,
    approvedCount: PHASES.filter((phase) => record.spec?.approvals[phase].approved === true)
      .length,
    reviewPhases,
    tasksDone: done,
    tasksTotal: tasks.length,
    nextLabel: record.spec ? nextAction(record.spec).label : 'spec.json missing',
    active: matching.filter((card) => card.column === 'running').length,
    attention: matching.filter((card) => card.column === 'attention').length,
    sessionsToday: sessions.filter(
      (session) => session.feature === sessionFeature && session.updatedAt >= dayStart,
    ).length,
    dir: record.dir,
    tasksPath: record.artifacts.tasks,
  };

  if (sessionCost > 0) {
    spec.costTodayUsd = sessionCost;
  }
  const reviewSince = parseUpdatedAt(record.spec?.updated_at);
  if (reviewSince !== undefined) {
    spec.reviewSince = reviewSince;
  }
  let updatedAt = parseUpdatedAt(record.spec?.updated_at);
  for (const session of sessions) {
    if (session.feature === sessionFeature && session.updatedAt > (updatedAt ?? 0)) {
      updatedAt = session.updatedAt;
    }
  }
  for (const card of matching) {
    if (card.updatedAt > (updatedAt ?? 0)) {
      updatedAt = card.updatedAt;
    }
  }
  if (updatedAt !== undefined) {
    spec.updatedAt = updatedAt;
  }
  if (record.specError) {
    spec.error = record.specError;
  }
  return spec;
};

const specRank = (spec: OverviewSpec): number => {
  if (spec.error) {
    return 0;
  }
  if (spec.attention > 0) {
    return 1;
  }
  if (spec.active > 0) {
    return 2;
  }
  if (spec.reviewPhases.length > 0) {
    return 3;
  }
  if (spec.ready) {
    return 4;
  }
  if (spec.tasksTotal > 0 && spec.tasksDone === spec.tasksTotal) {
    return 5;
  }
  return 6;
};

/** Builds the overview model. Pure: no file system or VS Code access. */
export const buildOverview = (input: OverviewInput): OverviewModel => {
  const { now, runs, sessions, specs } = input;
  const dayStart = startOfDay(now);

  const liveSessionIds = new Set<string>();
  const liveKeys = new Set<string>();
  const cards: OverviewCard[] = [];
  for (const run of runs) {
    const card = toRunCard(run, now);
    if (!card) {
      continue;
    }
    if (run.sessionId) {
      liveSessionIds.add(run.sessionId);
    }
    liveKeys.add(`${run.feature}\u0000${run.skill}`);
    cards.push(card);
  }

  for (const session of sessions) {
    if (liveSessionIds.has(session.id)) {
      continue;
    }
    if (liveKeys.has(`${session.feature ?? ''}\u0000${session.skill ?? ''}`)) {
      continue;
    }
    const card = toSessionCard(session, now);
    if (card) {
      cards.push(card);
    }
  }

  const columns: Record<OverviewColumn, OverviewCard[]> = {
    attention: [],
    running: [],
    done: [],
    failed: [],
  };
  for (const card of cards) {
    columns[card.column].push(card);
  }
  columns.attention.sort((left, right) => left.startedAt - right.startedAt);
  columns.running.sort((left, right) => left.startedAt - right.startedAt);
  columns.done.sort((left, right) => (right.endedAt ?? right.startedAt) - (left.endedAt ?? left.startedAt));
  columns.failed.sort((left, right) => (right.endedAt ?? right.startedAt) - (left.endedAt ?? left.startedAt));
  for (const column of OVERVIEW_COLUMNS) {
    columns[column] = columns[column].slice(0, 20);
  }

  const overviewSpecs = specs
    .map((spec) => buildSpec(spec, cards, sessions, dayStart))
    .sort((left, right) => {
      const rank = specRank(left) - specRank(right);
      if (rank !== 0) {
        return rank;
      }
      return left.label.localeCompare(right.label);
    });

  // Approvals are "needs you" work too. Putting them on the board keeps the
  // KPI and the attention column consistent, and gives them an open action.
  for (const spec of overviewSpecs) {
    for (const phase of spec.reviewPhases) {
      const waitingSince = spec.reviewSince ?? spec.updatedAt ?? now;
      columns.attention.push({
        id: `review:${spec.id}:${phase}`,
        specId: spec.id,
        reviewPhase: phase,
        source: 'review',
        feature: spec.id,
        skill: 'approval',
        column: 'attention',
        tone: 'attention',
        label: `Review ${phase}`,
        detail: `${PHASE_META[phase].file} is waiting for approval.`,
        startedAt: waitingSince,
        updatedAt: waitingSince,
      });
    }
  }
  columns.attention.sort((left, right) => left.startedAt - right.startedAt);
  const needsYou = columns.attention.length;
  columns.attention = columns.attention.slice(0, 20);

  const tasksDone = overviewSpecs.reduce((total, spec) => total + spec.tasksDone, 0);
  const tasksTotal = overviewSpecs.reduce((total, spec) => total + spec.tasksTotal, 0);

  // Spend today: sessions hold cumulative cost; live runs may be ahead of the
  // last transcript flush, so take the larger value per session.
  const liveCostBySession = new Map<string, number>();
  let spendTodayUsd = 0;
  for (const run of runs) {
    const cost = runCost(run);
    if (cost === undefined) {
      continue;
    }
    if ((run.endedAt ?? run.startedAt) < dayStart) {
      continue;
    }
    if (run.sessionId) {
      liveCostBySession.set(
        run.sessionId,
        Math.max(liveCostBySession.get(run.sessionId) ?? 0, cost),
      );
    } else {
      spendTodayUsd += cost;
    }
  }

  let sessionsToday = 0;
  for (const session of sessions) {
    if (session.updatedAt < dayStart) {
      continue;
    }
    sessionsToday += 1;
    const liveCost = liveCostBySession.get(session.id);
    if (liveCost !== undefined) {
      spendTodayUsd += Math.max(liveCost, session.costUsd ?? 0);
      liveCostBySession.delete(session.id);
    } else if (typeof session.costUsd === 'number') {
      spendTodayUsd += session.costUsd;
    }
  }
  for (const cost of liveCostBySession.values()) {
    spendTodayUsd += cost;
  }

  const failed = runs.filter(
    (run) =>
      run.status === 'error' &&
      (run.endedAt ?? run.startedAt) >= dayStart,
  ).length;

  return {
    generatedAt: now,
    kpi: {
      needsYou,
      running: columns.running.length,
      failed,
      reviews: overviewSpecs.reduce((total, spec) => total + spec.reviewPhases.length, 0),
      specs: overviewSpecs.length,
      activeSpecs: overviewSpecs.filter((spec) => spec.active > 0).length,
      tasksDone,
      tasksTotal,
      sessionsToday,
      spendTodayUsd,
    },
    columns,
    specs: overviewSpecs,
  };
};

/** Empty model used before a workspace is available. */
export const emptyOverview = (now: number): OverviewModel => ({
  generatedAt: now,
  kpi: {
    needsYou: 0,
    running: 0,
    failed: 0,
    reviews: 0,
    specs: 0,
    activeSpecs: 0,
    tasksDone: 0,
    tasksTotal: 0,
    sessionsToday: 0,
    spendTodayUsd: 0,
  },
  columns: { attention: [], running: [], done: [], failed: [] },
  specs: [],
});
