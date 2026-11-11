import { describe, expect, it } from 'vitest';
import { buildSpecProgress, parseDecision, parseVerificationItems } from '../src/core/progress';
import type { SpecRecord, ValidationFile } from '../src/core/repository';

const NOW = Date.parse('2026-06-01T12:00:00Z');

const ALL_APPROVED = {
  requirements: { generated: true, approved: true },
  design: { generated: true, approved: true },
  tasks: { generated: true, approved: true },
};

const tasks = (done: number, total: number, title = 'Task'): string =>
  Array.from({ length: total }, (_, index) => {
    const checked = index < done ? 'x' : ' ';
    return `- [${checked}] ${index + 1}. ${title} ${index + 1}`;
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
    feature_name: 'Demo',
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-02T00:00:00Z',
    approvals: {
      requirements: { generated: true, approved: true },
      design: { generated: true, approved: false },
      tasks: { generated: false, approved: false },
    },
    ready_for_implementation: false,
  },
  ...overrides,
});

const approved = (overrides: Partial<SpecRecord> = {}): SpecRecord =>
  record({
    ...overrides,
    spec: {
      ...record().spec!,
      approvals: ALL_APPROVED,
      ready_for_implementation: true,
      ...(overrides.spec ?? {}),
    },
  });

const validation = (decision: string): ValidationFile => ({
  content: [
    '## Validation Report',
    `- DECISION: ${decision}`,
    '- MECHANICAL_RESULTS:',
    '  - Tests: PASS',
    '  - TBD/TODO grep: CLEAN',
    '  - Smoke boot: PASS',
    '- OWNERSHIP: LOCAL',
    '',
  ].join('\n'),
});

describe('buildSpecProgress', () => {
  it('keeps implementation completion separate from verification', () => {
    const progress = buildSpecProgress(approved(), tasks(2, 2), undefined);

    expect(progress.stage).toBe('verification');
    expect(progress.implementationComplete).toBe(true);
    expect(progress.completed).toBe(false);
    expect(progress.stateLabel).toBe('Verification pending');
    expect(progress.next).toMatchObject({ kind: 'verify', label: 'Start verification' });
  });

  it('only completes with a current GO report', () => {
    const recordWithReport = approved({
      validationExists: true,
      validationUpdatedAtMs: NOW,
      updatedAtMs: NOW - 1000,
      artifactUpdatedAtMs: {
        requirements: NOW - 1000,
        design: NOW - 1000,
        tasks: NOW - 1000,
      },
    });

    const verified = buildSpecProgress(recordWithReport, tasks(2, 2), validation('GO'));
    expect(verified.stage).toBe('done');
    expect(verified.completed).toBe(true);
    expect(verified.stateLabel).toBe('Completed');

    const stale = buildSpecProgress(
      { ...recordWithReport, validationUpdatedAtMs: NOW - 10_000 },
      tasks(2, 2),
      validation('GO'),
    );
    expect(stale.stage).toBe('verification');
    expect(stale.completed).toBe(false);
    expect(stale.verification.status).toBe('stale');
    expect(stale.next.label).toBe('Revalidate');
  });

  it('does not treat a checked verification task as validation success', () => {
    const progress = buildSpecProgress(
      approved(),
      tasks(1, 1, 'Verify integration'),
      undefined,
    );

    expect(progress.tasksDone).toBe(1);
    expect(progress.completed).toBe(false);
    expect(progress.verification.status).toBe('none');
    expect(progress.stateLabel).toBe('Verification pending');
  });

  it('parses decisions and itemized checks', () => {
    const content = validation('NO-GO').content!;
    expect(parseDecision(content)).toBe('NO-GO');
    expect(parseVerificationItems(content)).toEqual([
      { label: 'Tests', value: 'PASS', status: 'pass' },
      { label: 'TBD/TODO grep', value: 'CLEAN', status: 'pass' },
      { label: 'Smoke boot', value: 'PASS', status: 'pass' },
      { label: 'OWNERSHIP', value: 'LOCAL', status: 'info' },
    ]);
  });

  it('shows review pending and the phase artifact before completion', () => {
    const progress = buildSpecProgress(record(), tasks(0, 3), undefined);

    expect(progress.stage).toBe('design');
    expect(progress.stateLabel).toBe('Review pending: Design');
    expect(progress.next).toMatchObject({ kind: 'review', phase: 'design', label: 'Open design' });
  });
});
