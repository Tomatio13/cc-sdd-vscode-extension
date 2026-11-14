import { describe, expect, it } from 'vitest';
import { buildOverviewReport } from '../src/core/overviewReport';
import type { OverviewSpec } from '../src/core/overview';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const spec = (id: string, extra: Partial<OverviewSpec> = {}): OverviewSpec =>
  ({
    id,
    label: id,
    stage: 'implementation',
    completed: false,
    implementationComplete: false,
    reviewPhases: [],
    tasksDone: 1,
    tasksTotal: 4,
    verification: { status: 'none', items: [], conditionsDefined: false },
    ...extra,
  }) as OverviewSpec;

describe('reporting overview', () => {
  it('separates verified completion from implementation and counts overlapping concerns once', () => {
    const specs = [
      spec('working'),
      spec('review', { stage: 'design', reviewPhases: ['design'] }),
      spec('blocked', {
        stage: 'verification',
        implementationComplete: true,
        blockedKind: 'explicit',
        blockedReason: 'Waiting for environment',
        verification: { status: 'failed', decision: 'NO-GO', items: [], conditionsDefined: true },
      }),
      spec('done', {
        stage: 'done',
        completed: true,
        implementationComplete: true,
        verification: {
          status: 'verified',
          decision: 'GO',
          at: NOW,
          items: [],
          conditionsDefined: true,
        },
      }),
    ];
    const report = buildOverviewReport('Project', specs, NOW);
    expect(report).toMatchObject({
      total: 4,
      inProgress: 3,
      done: 1,
      reviewPending: 1,
      verificationPending: 1,
    });
    expect(report.concerns).toHaveLength(1);
    expect(report.concerns[0].reasons).toHaveLength(2);
    expect(report.text).toContain('1 verified complete');
    expect(report.text).toContain('may overlap');
    expect(report.text).not.toContain('25%');
  });
  it('ignores local run failures, dependency candidates and record age in reporting', () => {
    const base = spec('alpha');
    const changed = {
      ...base,
      runState: 'failed',
      status: 'Last run failed',
      blockedKind: 'dependency',
      blockedReason: 'Waiting on candidate',
      activityAt: NOW + 5000,
    } as OverviewSpec;
    expect(buildOverviewReport('Project', [changed], NOW)).toEqual(
      buildOverviewReport('Project', [base], NOW),
    );
  });
  it('does not claim a missing or stale validation report is verified', () => {
    const report = buildOverviewReport(
      'Project',
      [
        spec('missing', {
          implementationComplete: true,
          verification: {
            status: 'unconfirmed',
            reportMissing: true,
            items: [],
            conditionsDefined: false,
          },
        }),
        spec('stale', {
          implementationComplete: true,
          verification: { status: 'stale', decision: 'GO', items: [], conditionsDefined: true },
        }),
      ],
      NOW,
    );
    expect(report.done).toBe(0);
    expect(report.concerns).toHaveLength(2);
    expect(report.text).toContain('report not saved');
    expect(report.text).toContain('revalidation needed');
  });
});
