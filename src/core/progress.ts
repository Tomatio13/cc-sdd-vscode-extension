// Shared spec progress model for the sidebar, Tasks view, and Overview.
// Completion is intentionally conservative: tasks done + a current validation
// GO. Nothing in the UI should invent a different completion rule.
import { PHASE_META } from './phases';
import { specContentUpdatedAt, type SpecRecord, type ValidationFile } from './repository';
import {
  PHASES,
  nextStepState,
  phaseStatus,
  type NextStepState,
  type PhaseKey,
  type PhaseStatus,
} from './spec';
import { parseTasks, type ParsedTask } from './tasks';

export type SpecStage =
  'requirements' | 'design' | 'tasks' | 'implementation' | 'verification' | 'done' | 'unknown';

export type VerificationStatus =
  'none' | 'stale' | 'verified' | 'failed' | 'manual' | 'unconfirmed' | 'error';

export type VerificationDecision = 'GO' | 'NO-GO' | 'MANUAL_VERIFY_REQUIRED';

export type VerificationItemStatus = 'pass' | 'fail' | 'unknown' | 'info';

export interface VerificationItem {
  label: string;
  value: string;
  status: VerificationItemStatus;
}

export interface Verification {
  reportMissing?: boolean;
  status: VerificationStatus;
  decision?: VerificationDecision;
  at?: number;
  path?: string;
  detail?: string;
  items: VerificationItem[];
  conditionsDefined: boolean;
}

export type SpecNextKind = 'missing' | 'generate' | 'review' | 'implement' | 'verify' | 'done';

export interface SpecNextAction {
  kind: SpecNextKind;
  label: string;
  detail?: string;
  phase?: PhaseKey;
}

export interface SpecProgress {
  stage: SpecStage;
  stageLabel: string;
  stateLabel: string;
  completed: boolean;
  implementationComplete: boolean;
  approvals: Record<PhaseKey, PhaseStatus>;
  reviewPhases: PhaseKey[];
  tasks: ParsedTask[];
  tasksDone: number;
  tasksTotal: number;
  verification: Verification;
  next: SpecNextAction;
}

const DECISION_RE = /^\s*[-*]?\s*DECISION:\s*[*`]*(GO|NO-GO|MANUAL_VERIFY_REQUIRED)[*`]*\s*$/im;

const ITEM_RE = /^\s*[-*]\s+([^:]+):\s*(.+?)\s*$/;

export const STAGE_LABELS: Record<SpecStage, string> = {
  requirements: 'Requirements',
  design: 'Design',
  tasks: 'Tasks',
  implementation: 'Implementation',
  verification: 'Verification',
  done: 'Done',
  unknown: 'Unknown',
};

export const verificationLabel = (verification: Verification): string => {
  switch (verification.status) {
    case 'verified':
      return 'Verified (GO)';
    case 'failed':
      return `Failed (${verification.decision ?? 'NO-GO'})`;
    case 'manual':
      return `Manual verification required (${verification.decision ?? 'MANUAL'})`;
    case 'stale':
      return `Stale result (${verification.decision ?? 'unconfirmed'})`;
    case 'unconfirmed':
      return 'Result recorded, applicability unconfirmed';
    case 'error':
      return 'Verification result unavailable';
    case 'none':
      return 'Verification not run';
  }
};

export const parseDecision = (content: string | undefined): VerificationDecision | undefined => {
  if (!content) {
    return undefined;
  }
  const match = DECISION_RE.exec(content);
  return match ? (match[1].toUpperCase() as VerificationDecision) : undefined;
};

const classifyItem = (value: string): VerificationItemStatus => {
  const upper = value.toUpperCase();
  if (value.includes('|')) {
    return 'unknown';
  }
  if (/\b(FAIL|NO-GO|MISMATCH|ERROR|BLOCKED)\b/.test(upper)) {
    return 'fail';
  }
  if (/\b(PASS|CLEAN|GO|MATCH|OK)\b/.test(upper)) {
    return 'pass';
  }
  if (/\b(MANUAL|UNKNOWN|NOT RUN|N\/A|REQUIRED)\b/.test(upper)) {
    return 'unknown';
  }
  return 'info';
};

export const parseVerificationItems = (content: string | undefined): VerificationItem[] => {
  if (!content) {
    return [];
  }
  const items: VerificationItem[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = ITEM_RE.exec(line);
    if (!match) {
      continue;
    }
    const label = match[1].trim();
    const value = match[2].trim();
    if (!value || /^DECISION$/i.test(label)) {
      continue;
    }
    items.push({ label, value, status: classifyItem(value) });
    if (items.length >= 20) {
      break;
    }
  }
  return items;
};

export const verificationFrom = (
  record: SpecRecord,
  validation: ValidationFile | undefined,
): Verification => {
  if (!record.validationExists) {
    const recorded = record.spec?.validation;
    if (recorded && typeof recorded === 'object' && !Array.isArray(recorded)) {
      return {
        status: 'unconfirmed',
        reportMissing: true,
        path: record.validationPath,
        detail:
          'Verification metadata exists in spec.json, but impl-validation.md was not saved. Revalidate to persist the evidence report.',
        items: [],
        conditionsDefined: false,
      };
    }
    return {
      status: 'none',
      path: record.validationPath,
      items: [],
      conditionsDefined: false,
    };
  }
  if (validation?.error) {
    return {
      status: 'error',
      path: record.validationPath,
      detail: validation.error,
      items: [],
      conditionsDefined: false,
    };
  }
  if (validation?.content === undefined) {
    return {
      status: 'error',
      path: record.validationPath,
      detail: 'Validation report could not be read.',
      items: [],
      conditionsDefined: false,
    };
  }

  const at = record.validationUpdatedAtMs;
  const decision = parseDecision(validation.content);
  const items = parseVerificationItems(validation.content);
  const conditionsDefined = decision !== undefined || items.length > 0;
  const stale = at === undefined || at < specContentUpdatedAt(record);
  const base = {
    decision,
    at,
    path: record.validationPath,
    items,
    conditionsDefined,
  };

  if (!decision) {
    return {
      ...base,
      status: stale ? 'stale' : 'unconfirmed',
      detail: 'No recognized DECISION line in impl-validation.md.',
    };
  }
  if (stale) {
    return {
      ...base,
      status: 'stale',
      detail: 'Result is older than the current spec artifacts.',
    };
  }
  if (decision === 'GO') {
    return { ...base, status: 'verified' };
  }
  if (decision === 'NO-GO') {
    return { ...base, status: 'failed' };
  }
  return { ...base, status: 'manual' };
};

const stageFor = (step: NextStepState, verification: Verification): SpecStage => {
  switch (step.kind) {
    case 'missing':
      return 'unknown';
    case 'generate':
    case 'review':
      return step.phase;
    case 'implement':
      return 'implementation';
    case 'done':
      return verification.status === 'verified' ? 'done' : 'verification';
  }
};

const nextAction = (step: NextStepState, verification: Verification): SpecNextAction => {
  if (step.kind === 'missing') {
    return { kind: 'missing', label: 'Spec metadata missing' };
  }
  if (step.kind === 'generate') {
    const meta = PHASE_META[step.phase];
    return {
      kind: 'generate',
      phase: step.phase,
      label: `Create ${meta.label.toLowerCase()}`,
      detail: `/${meta.skill}`,
    };
  }
  if (step.kind === 'review') {
    const meta = PHASE_META[step.phase];
    return {
      kind: 'review',
      phase: step.phase,
      label: `Open ${meta.label.toLowerCase()}`,
      detail: meta.file,
    };
  }
  if (step.kind === 'implement') {
    return { kind: 'implement', label: 'Start implementation' };
  }

  if (verification.reportMissing) return { kind: 'verify', label: 'Revalidate' };
  if (verification.status === 'verified') {
    return { kind: 'done', label: 'View verification result' };
  }
  if (verification.status === 'stale') {
    return { kind: 'verify', label: 'Revalidate' };
  }
  if (verification.status === 'failed') {
    return { kind: 'verify', label: 'Open verification result' };
  }
  if (verification.status === 'manual') {
    return { kind: 'verify', label: 'Open verification result' };
  }
  if (verification.status === 'unconfirmed' || verification.status === 'error') {
    return { kind: 'verify', label: 'Open verification result' };
  }
  return { kind: 'verify', label: 'Start verification' };
};

const stateLabel = (
  step: NextStepState,
  stage: SpecStage,
  verification: Verification,
  tasksDone: number,
  tasksTotal: number,
): string => {
  if (step.kind === 'missing') {
    return 'Spec metadata unavailable';
  }
  if (step.kind === 'generate' || step.kind === 'review') {
    const phase = PHASE_META[step.phase].label;
    return step.kind === 'review' ? `Review pending: ${phase}` : `${phase} not started`;
  }
  if (step.kind === 'implement') {
    return tasksTotal > 0 ? `Implementation ${tasksDone}/${tasksTotal}` : 'Tasks not generated';
  }
  if (verification.status === 'verified') {
    return 'Completed';
  }
  if (verification.status === 'failed') {
    return 'Verification failed';
  }
  if (verification.status === 'stale') {
    return 'Verification stale';
  }
  if (verification.status === 'manual') {
    return 'Manual verification required';
  }
  if (verification.status === 'unconfirmed') {
    return 'Verification unconfirmed';
  }
  if (verification.status === 'error') {
    return 'Verification unavailable';
  }
  return stage === 'verification' ? 'Verification pending' : 'In progress';
};

export const buildSpecProgress = (
  record: SpecRecord,
  tasksContent: string | undefined,
  validation: ValidationFile | undefined,
): SpecProgress => {
  const tasks = parseTasks(tasksContent ?? '');
  const tasksDone = tasks.filter((task) => task.checked).length;
  const approvals = {} as Record<PhaseKey, PhaseStatus>;
  const reviewPhases: PhaseKey[] = [];

  for (const phase of PHASES) {
    approvals[phase] = phaseStatus(record.spec, phase, record.exists[phase]);
    const approval = record.spec?.approvals[phase];
    if (approval?.generated === true && approval.approved !== true) {
      reviewPhases.push(phase);
    }
  }

  const verification = verificationFrom(record, validation);
  const step = nextStepState(record.spec, { done: tasksDone, total: tasks.length });
  const stage = stageFor(step, verification);
  const implementationComplete = tasks.length > 0 && tasksDone === tasks.length;
  const completed = implementationComplete && verification.status === 'verified';

  return {
    stage,
    stageLabel: STAGE_LABELS[stage],
    stateLabel: stateLabel(step, stage, verification, tasksDone, tasks.length),
    completed,
    implementationComplete,
    approvals,
    reviewPhases,
    tasks,
    tasksDone,
    tasksTotal: tasks.length,
    verification,
    next: nextAction(step, verification),
  };
};
