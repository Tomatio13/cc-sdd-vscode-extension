import type { OverviewSpec } from './overview';

export interface OverviewReport {
  total: number;
  inProgress: number;
  done: number;
  reviewPending: number;
  verificationPending: number;
  concerns: { specId: string; label: string; reasons: string[] }[];
  statuses: Record<string, string>;
  text: string;
}

const STAGES: Record<string, string> = {
  requirements: 'Requirements',
  design: 'Design',
  tasks: 'Task planning',
  implementation: 'Implementation',
  verification: 'Verification',
  done: 'Completed',
  unknown: 'Unknown',
};

/** Repository snapshot only: local runs, inferred dependencies and age do not imply progress. */
export function buildOverviewReport(
  project: string,
  specs: OverviewSpec[],
  at: number,
): OverviewReport {
  const active = specs.filter((spec) => !spec.completed);
  const concerns = active
    .map((spec) => {
      const reasons: string[] = [];
      if (spec.error) reasons.push(`Spec metadata unavailable: ${spec.error}`);
      if (spec.blockedKind === 'explicit' && spec.blockedReason) reasons.push(spec.blockedReason);
      const verification = spec.verification;
      if (verification.status === 'failed') reasons.push('Verification failed');
      if (verification.status === 'manual') reasons.push('Manual verification required');
      if (verification.status === 'stale')
        reasons.push('Verification result is stale; revalidation needed');
      if (verification.status === 'unconfirmed')
        reasons.push(
          verification.reportMissing
            ? 'Verification report not saved'
            : 'Verification result unconfirmed',
        );
      if (verification.status === 'error') reasons.push('Verification report unavailable');
      return { specId: spec.id, label: spec.label, reasons };
    })
    .filter((item) => item.reasons.length > 0)
    .sort((a, b) => a.label.localeCompare(b.label));
  const statuses = Object.fromEntries(
    specs.map((spec) => {
      const concern = concerns.find((item) => item.specId === spec.id);
      const status = spec.completed
        ? 'Verified (GO)'
        : concern
          ? concern.reasons.join(' · ')
          : spec.reviewPhases.length
            ? `Review pending: ${spec.reviewPhases.map((phase) => STAGES[phase]).join(', ')}`
            : spec.implementationComplete
              ? 'Verification pending'
              : spec.stage === 'implementation'
                ? 'Implementation in progress'
                : spec.stage === 'unknown'
                  ? 'State unavailable'
                  : `${STAGES[spec.stage]} in preparation`;
      return [spec.id, status];
    }),
  );
  const report: OverviewReport = {
    total: specs.length,
    inProgress: active.length,
    done: specs.length - active.length,
    reviewPending: active.filter((spec) => spec.reviewPhases.length > 0).length,
    verificationPending: active.filter((spec) => spec.implementationComplete).length,
    concerns,
    statuses,
    text: '',
  };
  const lines = [
    project,
    `Progress snapshot: ${new Date(at).toISOString()}`,
    `${report.total} specs · ${report.done} verified complete · ${report.inProgress} in progress`,
    `${report.reviewPending} review pending · ${report.verificationPending} verification pending · ${concerns.length} need attention`,
    'Review / verification / attention counts are subsets and may overlap.',
    '',
    'In progress',
  ];
  if (!active.length) lines.push('- None');
  for (const spec of [...active].sort((a, b) => a.label.localeCompare(b.label))) {
    lines.push(
      `- ${spec.label} — ${STAGES[spec.stage]} · ${spec.tasksTotal ? `${spec.tasksDone}/${spec.tasksTotal} implementation tasks` : 'No implementation tasks recorded'} · ${statuses[spec.id]}`,
    );
  }
  lines.push('', 'Attention');
  if (!concerns.length) lines.push('- No recorded issues');
  concerns.forEach((item) => lines.push(`- ${item.label} — ${item.reasons.join(' · ')}`));
  lines.push('', 'Verified complete');
  const done = specs
    .filter((spec) => spec.completed)
    .sort((a, b) => a.label.localeCompare(b.label));
  if (!done.length) lines.push('- None');
  done.forEach((spec) =>
    lines.push(
      `- ${spec.label} — GO${spec.verification.at ? ` · verified ${new Date(spec.verification.at).toISOString()}` : ''}`,
    ),
  );
  lines.push(
    '',
    'Based on repository records; implementation task counts are not overall project completion.',
  );
  report.text = lines.join('\n');
  return report;
}
