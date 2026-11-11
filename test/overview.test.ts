import { describe, expect, it } from 'vitest';
import { buildOverview } from '../src/core/overview';
import type { RoadmapInfo, SpecRecord } from '../src/core/repository';
import type { SpecJson } from '../src/core/spec';
import type { RunState } from '../src/run/claudeRunner';

const NOW = Date.parse('2026-06-01T12:00:00Z');

const ALL_APPROVED = {
  requirements: { generated: true, approved: true },
  design: { generated: true, approved: true },
  tasks: { generated: true, approved: true },
};

const tasks = (done: number, total: number): string =>
  Array.from({ length: total }, (_, index) => {
    const checked = index < done ? 'x' : ' ';
    return `- [${checked}] ${index + 1}. Task ${index + 1}`;
  }).join('\n');

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
  validationPath: '/tmp/specs/demo/impl-validation.md',
  validationExists: false,
  spec: {
    feature_name: 'Demo feature',
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-02T00:00:00Z',
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

const specWith = (
  spec: Partial<SpecJson>,
  recordOverrides: Partial<SpecRecord> = {},
): SpecRecord =>
  record({
    ...recordOverrides,
    spec: { ...record().spec!, ...spec },
  });

const implemented = (
  spec: Partial<SpecJson> = {},
  recordOverrides: Partial<SpecRecord> = {},
): SpecRecord =>
  specWith(
    { approvals: ALL_APPROVED, ready_for_implementation: true, ...spec },
    recordOverrides,
  );

const completedRecord = (
  id: string,
  validationAt: number,
  contentAt: number,
  decision: 'GO' | 'NO-GO' | 'MANUAL_VERIFY_REQUIRED' = 'GO',
): SpecRecord =>
  record({
    id,
    validationExists: true,
    validationUpdatedAtMs: validationAt,
    updatedAtMs: contentAt,
    artifactUpdatedAtMs: {
      requirements: contentAt,
      design: contentAt,
      tasks: contentAt,
    },
    spec: implemented({ feature_name: id }).spec,
  });

const validation = (decision: 'GO' | 'NO-GO' | 'MANUAL_VERIFY_REQUIRED') => ({
  content: ['## Validation Report', `- DECISION: ${decision}`, ''].join('\n'),
});

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

const roadmap: RoadmapInfo = {
  path: '/tmp/steering/roadmap.md',
  order: ['auth', 'notifications', 'history'],
  deps: {
    auth: [],
    notifications: ['auth'],
    history: ['auth'],
  },
};

describe('buildOverview', () => {
  it('keeps the implementation stage separate from the run state', () => {
    const demo = implemented();
    const base = buildOverview({
      projectName: 'demo',
      specs: [{ record: demo, tasks: tasks(4, 8) }],
      runs: [],
      now: NOW,
    });

    expect(base.specs[0].stage).toBe('implementation');
    expect(base.specs[0].runState).toBe('none');
    expect(base.specs[0].status).toBe('No run record');
    expect(base.specs[0].blockedReason).toBeUndefined();

    const running = buildOverview({
      projectName: 'demo',
      specs: [{ record: demo, tasks: tasks(4, 8) }],
      runs: [run({ feature: 'demo' })],
      now: NOW,
    });
    expect(running.specs[0].stage).toBe('implementation');
    expect(running.specs[0].runState).toBe('running');
    expect(running.specs[0].status).toBe('Running');

    const waiting = buildOverview({
      projectName: 'demo',
      specs: [{ record: demo, tasks: tasks(4, 8) }],
      runs: [
        run({
          feature: 'demo',
          pending: { id: 'p1', kind: 'question', questions: [] },
        }),
      ],
      now: NOW,
    });
    expect(waiting.specs[0].runState).toBe('input');
    expect(waiting.specs[0].status).toBe('Input waiting');
    expect(waiting.specs[0].pendingCount).toBe(1);

    const multiple = buildOverview({
      projectName: 'demo',
      specs: [{ record: demo, tasks: tasks(4, 8) }],
      runs: [
        run({ id: 'r1', feature: 'demo' }),
        run({ id: 'r2', feature: 'demo', startedAt: NOW - 30_000 }),
      ],
      now: NOW,
    });
    expect(multiple.specs[0].runningCount).toBe(2);
    expect(multiple.specs[0].status).toBe('2 running');
  });

  it('treats approval waiting as state, not an inbox item', () => {
    const model = buildOverview({
      projectName: 'demo',
      specs: [{ record: record(), tasks: tasks(0, 3) }],
      runs: [],
      now: NOW,
    });
    const spec = model.specs[0];

    expect(spec.reviewPhases).toEqual(['design']);
    expect(spec.status).toBe('Review pending: Design');
    expect(model.kpi.reviewPending).toBe(1);
    expect(model.kpi.reviews).toBe(1);
  });

  it('shows explicit blocks but does not treat old updates as blocked', () => {
    const blocked = specWith({
      blocked_reason: 'Waiting for the shared API contract',
    });
    const old = record({
      id: 'old',
      updatedAtMs: Date.parse('2020-01-01T00:00:00Z'),
      spec: { ...record().spec!, updated_at: '2020-01-01T00:00:00Z' },
    });

    const model = buildOverview({
      projectName: 'demo',
      specs: [
        { record: blocked, tasks: tasks(1, 3) },
        { record: old, tasks: tasks(1, 3) },
      ],
      runs: [],
      now: NOW,
    });

    const blockedSpec = model.specs.find((spec) => spec.id === 'demo');
    expect(blockedSpec?.blockedReason).toBe('Waiting for the shared API contract');
    expect(blockedSpec?.blockedKind).toBe('explicit');
    expect(blockedSpec?.status).toContain('Blocked:');

    const oldSpec = model.specs.find((spec) => spec.id === 'old');
    expect(oldSpec?.blockedReason).toBeUndefined();
    expect(oldSpec?.status).not.toContain('Blocked');

    expect(model.kpi.blocked).toBe(1);
    expect(model.kpi.blockedExplicit).toBe(1);
    expect(model.kpi.blockedDependency).toBe(0);
  });

  it('derives dependency waiting and downstream impact from roadmap.md', () => {
    const auth = implemented({ feature_name: 'Auth' }, { id: 'auth' });
    const notifications = specWith(
      {
        feature_name: 'Notifications',
        approvals: {
          requirements: { generated: false, approved: false },
          design: { generated: false, approved: false },
          tasks: { generated: false, approved: false },
        },
        ready_for_implementation: false,
      },
      { id: 'notifications' },
    );
    const history = specWith(
      {
        feature_name: 'History',
        approvals: {
          requirements: { generated: false, approved: false },
          design: { generated: false, approved: false },
          tasks: { generated: false, approved: false },
        },
        ready_for_implementation: false,
      },
      { id: 'history' },
    );

    const model = buildOverview({
      projectName: 'demo',
      specs: [
        { record: auth, tasks: tasks(1, 2) },
        { record: notifications, tasks: '' },
        { record: history, tasks: '' },
      ],
      runs: [],
      roadmap,
      now: NOW,
    });

    const notes = model.specs.find((spec) => spec.id === 'notifications');
    expect(notes?.waitingOn).toEqual(['auth']);
    expect(notes?.blockedKind).toBe('dependency');
    expect(notes?.status).toBe('Waiting on Auth');

    const authSpec = model.specs.find((spec) => spec.id === 'auth');
    expect(authSpec?.downstream).toEqual(['notifications', 'history']);

    expect(model.dependencyInfo).toBe('available');
    expect(model.dependencies.some((note) => note.kind === 'waiting')).toBe(true);
    expect(model.dependencies.some((note) => note.kind === 'downstream')).toBe(true);
  });

  it('does not claim readiness without dependency information', () => {
    const notifications = specWith(
      {
        approvals: {
          requirements: { generated: false, approved: false },
          design: { generated: false, approved: false },
          tasks: { generated: false, approved: false },
        },
        ready_for_implementation: false,
      },
      { id: 'notifications' },
    );

    const model = buildOverview({
      projectName: 'demo',
      specs: [{ record: notifications, tasks: '' }],
      runs: [],
      now: NOW,
    });

    expect(model.dependencyInfo).toBe('none');
    expect(model.dependencies).toEqual([]);
    expect(model.specs[0].hasDependencyInfo).toBe(false);
    expect(model.specs[0].status).not.toContain('ready');
  });

  it('shows unknown dependencies without calling the spec blocked', () => {
    const notifications = specWith(
      {
        feature_name: 'Notifications',
        approvals: {
          requirements: { generated: false, approved: false },
          design: { generated: false, approved: false },
          tasks: { generated: false, approved: false },
        },
        ready_for_implementation: false,
      },
      { id: 'notifications' },
    );

    const model = buildOverview({
      projectName: 'demo',
      specs: [{ record: notifications, tasks: '' }],
      runs: [],
      roadmap: {
        path: '/tmp/roadmap.md',
        order: ['notifications'],
        deps: { notifications: ['missing-spec'] },
      },
      now: NOW,
    });

    expect(model.specs[0].dependencyUnknown).toEqual(['missing-spec']);
    expect(model.specs[0].blockedReason).toBeUndefined();
    expect(model.specs[0].status).toBe('Dependency status unknown: missing-spec');
    expect(model.kpi.blocked).toBe(0);
    expect(model.dependencies[0]?.text).toBe('Dependency status unknown: missing-spec');
  });

  it('separates implementation completion from verification state', () => {
    const contentAt = NOW - 10_000;
    const complete = completedRecord('complete', contentAt + 1000, contentAt, 'GO');
    const stale = completedRecord('stale', contentAt - 1000, contentAt, 'GO');
    const failed = completedRecord('failed', contentAt + 1000, contentAt, 'NO-GO');
    const manual = completedRecord('manual', contentAt + 1000, contentAt, 'MANUAL_VERIFY_REQUIRED');

    const model = buildOverview({
      projectName: 'demo',
      specs: [
        { record: complete, tasks: tasks(2, 2), validation: validation('GO') },
        { record: stale, tasks: tasks(2, 2), validation: validation('GO') },
        { record: failed, tasks: tasks(2, 2), validation: validation('NO-GO') },
        { record: manual, tasks: tasks(2, 2), validation: validation('MANUAL_VERIFY_REQUIRED') },
      ],
      runs: [],
      now: NOW,
    });

    const completeSpec = model.specs.find((spec) => spec.verification.status === 'verified');
    expect(completeSpec?.completed).toBe(true);
    expect(completeSpec?.stage).toBe('done');
    expect(completeSpec?.status).toBe('Verified');

    const staleSpec = model.specs.find((spec) => spec.verification.status === 'stale');
    expect(staleSpec?.completed).toBe(false);
    expect(staleSpec?.stage).toBe('verification');
    expect(staleSpec?.status).toBe('Verification result is stale');

    const failedSpec = model.specs.find((spec) => spec.verification.status === 'failed');
    expect(failedSpec?.completed).toBe(false);
    expect(failedSpec?.status).toBe('Verification failed');

    const manualSpec = model.specs.find((spec) => spec.verification.status === 'manual');
    expect(manualSpec?.completed).toBe(false);
    expect(manualSpec?.status).toBe('Manual verification required');

    expect(model.kpi.done).toBe(1);
    expect(model.kpi.verificationPending).toBe(3);
    expect(model.kpi.verificationFailed).toBe(1);
  });

  it('shows verification pending when tasks are complete without a result', () => {
    const model = buildOverview({
      projectName: 'demo',
      specs: [{ record: implemented({}, { id: 'pending' }), tasks: tasks(2, 2) }],
      runs: [],
      now: NOW,
    });

    expect(model.specs[0].implementationComplete).toBe(true);
    expect(model.specs[0].completed).toBe(false);
    expect(model.specs[0].stage).toBe('verification');
    expect(model.specs[0].status).toBe('Verification pending');
    expect(model.specs[0].verification.status).toBe('none');
    expect(model.kpi.done).toBe(0);
  });

  it('distinguishes missing verification from fetch failure and invalid metadata', () => {
    const unreadable = record({
      id: 'unreadable',
      validationExists: true,
      validationUpdatedAtMs: NOW,
    });
    const broken = record({ id: 'broken', spec: null, specError: 'Invalid JSON' });

    const model = buildOverview({
      projectName: 'demo',
      specs: [
        { record: implemented({}, { id: 'none' }), tasks: tasks(1, 1) },
        { record: unreadable, tasks: tasks(1, 1), validation: { error: 'EACCES' } },
        { record: broken, tasks: '' },
      ],
      runs: [],
      now: NOW,
    });

    const none = model.specs.find((spec) => spec.id === 'none');
    expect(none?.verification.status).toBe('none');
    expect(none?.status).toBe('Verification pending');

    const error = model.specs.find((spec) => spec.id === 'unreadable');
    expect(error?.verification.status).toBe('error');
    expect(error?.status).toBe('Verification info unavailable');

    const invalid = model.specs.find((spec) => spec.id === 'broken');
    expect(invalid?.stage).toBe('unknown');
    expect(invalid?.status).toBe('spec.json invalid');
  });

  it('does not keep a spec failed after a newer successful run', () => {
    const demo = implemented();
    const model = buildOverview({
      projectName: 'demo',
      specs: [{ record: demo, tasks: tasks(1, 4) }],
      runs: [
        run({
          id: 'old-fail',
          feature: 'demo',
          status: 'error',
          startedAt: NOW - 120_000,
          endedAt: NOW - 100_000,
        }),
        run({
          id: 'new-done',
          feature: 'demo',
          status: 'done',
          startedAt: NOW - 50_000,
          endedAt: NOW - 40_000,
        }),
      ],
      now: NOW,
    });

    expect(model.specs[0].runState).toBe('idle');
    expect(model.specs[0].status).toBe('No active run');
    expect(model.specs[0].status).not.toContain('failed');
  });

  it('does not treat an unrecognized validation report as verified', () => {
    const demo = record({
      validationExists: true,
      validationUpdatedAtMs: NOW,
      updatedAtMs: NOW - 1000,
      spec: implemented().spec,
    });
    const model = buildOverview({
      projectName: 'demo',
      specs: [
        {
          record: demo,
          tasks: tasks(2, 2),
          validation: { content: '## Validation Report\n\nNo decision line yet.\n' },
        },
      ],
      runs: [],
      now: NOW,
    });

    expect(model.specs[0].verification.status).toBe('unconfirmed');
    expect(model.specs[0].completed).toBe(false);
    expect(model.specs[0].status).toBe('Verification result unconfirmed');
  });

  it('sorts blocked, running, waiting, other, then completed specs', () => {
    const contentAt = NOW - 10_000;
    const blocked = specWith({ blocked_reason: 'Contract pending' }, { id: 'blocked' });
    const running = implemented({}, { id: 'running' });
    const review = specWith({}, { id: 'review' });
    const other = implemented({}, { id: 'other' });
    const done = completedRecord('done', contentAt + 1000, contentAt, 'GO');

    const model = buildOverview({
      projectName: 'demo',
      specs: [
        { record: done, tasks: tasks(2, 2), validation: validation('GO') },
        { record: other, tasks: tasks(1, 5) },
        { record: review, tasks: tasks(0, 3) },
        { record: running, tasks: tasks(1, 5) },
        { record: blocked, tasks: tasks(1, 5) },
      ],
      runs: [run({ id: 'run-running', feature: 'running' })],
      now: NOW,
    });

    expect(model.specs.map((spec) => spec.id)).toEqual([
      'blocked',
      'running',
      'review',
      'other',
      'done',
    ]);
    expect(model.specs[4].completed).toBe(true);
    expect(model.kpi.inProgress).toBe(4);
    expect(model.kpi.done).toBe(1);
  });

  it('builds recent events from recorded updates, runs, and validation', () => {
    const contentAt = NOW - 10_000;
    const done = completedRecord('demo', contentAt + 1000, contentAt, 'GO');
    const failedRun = run({
      id: 'run-failed',
      feature: 'demo',
      status: 'error',
      endedAt: NOW - 1000,
    });

    const model = buildOverview({
      projectName: 'demo',
      specs: [{ record: done, tasks: tasks(2, 2), validation: validation('GO') }],
      runs: [failedRun],
      now: NOW,
    });

    expect(model.events.some((event) => event.text === 'Spec updated')).toBe(true);
    expect(model.events.some((event) => event.text === 'Run started: /kiro-impl')).toBe(true);
    expect(model.events.some((event) => event.text === 'Run failed')).toBe(true);
    expect(model.events.some((event) => event.text === 'Validation recorded: GO')).toBe(true);
    expect(model.events.find((event) => event.text === 'Run failed')?.scope).toBe('local');
    expect(model.events.find((event) => event.text === 'Validation recorded: GO')?.scope).toBe(
      'repo',
    );
  });
});
