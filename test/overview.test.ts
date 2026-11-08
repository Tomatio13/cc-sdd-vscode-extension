import { describe, expect, it } from 'vitest';
import { buildOverview, ACTIVE_SESSION_MS } from '../src/core/overview';
import type { SpecRecord } from '../src/core/repository';
import type { SessionRecord } from '../src/core/sessions';
import type { RunState } from '../src/run/claudeRunner';

const NOW = new Date('2026-06-01T12:00:00Z').getTime();

const run = (overrides: Partial<RunState>): RunState => ({
  id: 'run-1',
  skill: 'kiro-impl',
  feature: 'demo',
  prompt: '/kiro-impl demo',
  permissionMode: 'acceptEdits',
  status: 'running',
  segments: [],
  startedAt: NOW - 60_000,
  ...overrides,
});

const session = (overrides: Partial<SessionRecord>): SessionRecord => ({
  id: 'session-1',
  title: '/kiro-impl demo',
  skill: 'kiro-impl',
  feature: 'demo',
  updatedAt: NOW - 1000,
  sizeBytes: 100,
  filePath: '/tmp/session-1.jsonl',
  ...overrides,
});

const record = (overrides: Partial<SpecRecord> = {}): SpecRecord => ({
  id: 'demo',
  dir: '/tmp/specs/demo',
  specJsonPath: '/tmp/specs/demo/spec.json',
  artifacts: {
    requirements: '/tmp/specs/demo/requirements.md',
    design: '/tmp/specs/demo/design.md',
    tasks: '/tmp/specs/demo/tasks.md',
  },
  exists: { requirements: true, design: true, tasks: true },
  spec: {
    feature_name: 'Demo feature',
    phase: 'tasks-generated',
    approvals: {
      requirements: { generated: true, approved: true },
      design: { generated: true, approved: false },
      tasks: { generated: false, approved: false },
    },
    ready_for_implementation: false,
  },
  ...overrides,
});

const TASKS = [
  '# Tasks',
  '',
  '- [x] 1. Done task',
  '- [ ] 2. Todo task',
  '  - _Depends:_ 1',
  '- [ ] 3. Another todo',
].join('\n');

describe('buildOverview', () => {
  it('maps run states to board columns', () => {
    const model = buildOverview({
      specs: [],
      sessions: [],
      now: NOW,
      runs: [
        run({ id: 'r-attention', pending: { id: 'p1', kind: 'permission', toolName: 'Bash' } }),
        run({ id: 'r-running' }),
        run({ id: 'r-done', status: 'done', endedAt: NOW - 1000 }),
        run({ id: 'r-error', status: 'error', endedAt: NOW - 1000 }),
        run({ id: 'r-cancelled', status: 'cancelled', endedAt: NOW - 1000 }),
        run({ id: 'r-preview', status: 'preview' }),
      ],
    });

    expect(model.columns.attention.map((card) => card.runId)).toEqual(['r-attention']);
    expect(model.columns.running.map((card) => card.runId)).toEqual(['r-running']);
    expect(model.columns.done.map((card) => card.runId)).toEqual(['r-done']);
    expect(model.columns.failed.map((card) => card.runId)).toEqual(['r-error', 'r-cancelled']);
    expect(model.columns.attention[0].label).toBe('Permission needed');
    expect(model.columns.failed.find((card) => card.runId === 'r-cancelled')?.tone).toBe(
      'cancelled',
    );
    expect(model.kpi.needsYou).toBe(1);
    expect(model.kpi.running).toBe(1);
    expect(model.kpi.failed).toBe(1);
  });

  it('surfaces sessions active elsewhere and de-duplicates live sessions', () => {
    const model = buildOverview({
      specs: [],
      now: NOW,
      runs: [run({ id: 'r-live', sessionId: 'session-live' })],
      sessions: [
        session({ id: 'session-live', updatedAt: NOW - 1000 }),
        session({ id: 'session-other', feature: 'other', skill: 'kiro-impl' }),
        session({
          id: 'session-stale',
          feature: 'stale',
          skill: 'kiro-impl',
          updatedAt: NOW - ACTIVE_SESSION_MS - 1,
        }),
      ],
    });

    const running = model.columns.running.map((card) => card.id);
    expect(running).toContain('run:r-live');
    expect(running).toContain('session:session-other');
    expect(running).not.toContain('session:session-live');
    expect(running).not.toContain('session:session-stale');
    expect(model.columns.running.find((card) => card.id === 'session:session-other')?.label).toBe(
      'Active elsewhere',
    );
  });

  it('does not treat a finished transcript as a running worker', () => {
    const model = buildOverview({
      specs: [],
      now: NOW,
      runs: [],
      sessions: [
        session({ id: 'session-done', activity: { state: 'stopped' } }),
        session({
          id: 'session-waiting',
          feature: 'waiting',
          activity: { state: 'waiting', pending: 'question' },
          lastMessage: 'Which environment should I use?',
        }),
        session({ id: 'session-running', feature: 'running', activity: { state: 'running' } }),
      ],
    });

    const running = model.columns.running.map((card) => card.id);
    const attention = model.columns.attention.map((card) => card.id);
    expect(running).toContain('session:session-running');
    expect(running).not.toContain('session:session-done');
    expect(attention).toContain('session:session-waiting');
    expect(
      model.columns.attention.find((card) => card.id === 'session:session-waiting')?.label,
    ).toBe('Question elsewhere');
    expect(model.kpi.needsYou).toBe(1);
  });

  it('derives spec approvals, review phases, and task progress', () => {
    const model = buildOverview({
      runs: [],
      sessions: [],
      now: NOW,
      specs: [{ record: record(), tasks: TASKS }],
    });

    const spec = model.specs[0];
    expect(spec.label).toBe('Demo feature');
    expect(spec.approvedCount).toBe(1);
    expect(spec.reviewPhases).toEqual(['design']);
    expect(spec.approvals.requirements).toBe('approved');
    expect(spec.approvals.design).toBe('generated');
    expect(spec.approvals.tasks).toBe('draft');
    expect(spec.tasksDone).toBe(1);
    expect(spec.tasksTotal).toBe(3);
    expect(spec.nextLabel).toBe('Review and approve design');
    expect(model.kpi.reviews).toBe(1);
    expect(model.kpi.needsYou).toBe(1);
    expect(model.kpi.tasksDone).toBe(1);
    expect(model.kpi.tasksTotal).toBe(3);
    expect(model.columns.attention).toHaveLength(1);
    expect(model.columns.attention[0].source).toBe('review');
    expect(model.columns.attention[0].label).toBe('Review design');
    expect(model.columns.attention[0].specId).toBe('demo');
  });

  it('counts live workers per spec and sorts active specs first', () => {
    const model = buildOverview({
      now: NOW,
      sessions: [session({ id: 's-other', feature: 'other', skill: 'kiro-impl' })],
      runs: [
        run({ id: 'r-demo', feature: 'demo', sessionId: 's-demo' }),
        run({
          id: 'r-wait',
          feature: 'demo',
          pending: { id: 'p1', kind: 'question', questions: [] },
        }),
      ],
      specs: [
        { record: record({ id: 'draft', spec: { ...record().spec!, feature_name: 'Draft' } }), tasks: '' },
        { record: record(), tasks: TASKS },
      ],
    });

    const demo = model.specs.find((spec) => spec.id === 'demo');
    const draft = model.specs.find((spec) => spec.id === 'draft');
    expect(demo?.active).toBe(1);
    expect(demo?.attention).toBe(1);
    expect(model.specs[0].id).toBe('demo');
    expect(draft).toBeDefined();
    expect(model.kpi.activeSpecs).toBe(1);
  });

  it('sums today spend without double counting live sessions', () => {
    const model = buildOverview({
      specs: [],
      now: NOW,
      runs: [
        run({
          id: 'r-cost',
          sessionId: 's-live',
          status: 'done',
          endedAt: NOW - 1000,
          usageCostUsd: 0.5,
        }),
      ],
      sessions: [
        session({ id: 's-live', costUsd: 0.4, updatedAt: NOW - 1000 }),
        session({
          id: 's-other',
          feature: 'other',
          skill: 'kiro-impl',
          costUsd: 0.2,
          updatedAt: NOW - 1000,
        }),
        session({
          id: 's-old',
          feature: 'old',
          skill: 'kiro-impl',
          costUsd: 10,
          updatedAt: NOW - 3 * 24 * 60 * 60 * 1000,
        }),
      ],
    });

    expect(model.kpi.spendTodayUsd).toBeCloseTo(0.7);
    expect(model.kpi.sessionsToday).toBe(2);
  });
});
