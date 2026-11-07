export const PHASES = ['requirements', 'design', 'tasks'] as const;

export type PhaseKey = (typeof PHASES)[number];

export type PhaseStatus = 'missing' | 'draft' | 'generated' | 'approved';

export interface PhaseApproval {
  generated: boolean;
  approved: boolean;
}

export interface SpecJson {
  feature_name?: string;
  created_at?: string;
  updated_at?: string;
  language?: string;
  phase?: string;
  approvals: Record<PhaseKey, PhaseApproval>;
  ready_for_implementation: boolean;
  [key: string]: unknown;
}

export type ParseSpecResult =
  | { ok: true; spec: SpecJson }
  | { ok: false; error: string };

export type NextAction =
  | { kind: 'generate' | 'review'; phase: PhaseKey; label: string }
  | { kind: 'implement'; label: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const normalizeApproval = (value: unknown): PhaseApproval => {
  const record = isRecord(value) ? value : {};
  return {
    generated: record.generated === true,
    approved: record.approved === true,
  };
};

export const normalizeSpecJson = (raw: Record<string, unknown>): SpecJson => {
  const approvalsRaw = isRecord(raw.approvals) ? raw.approvals : {};
  const approvals = {} as Record<PhaseKey, PhaseApproval>;

  for (const phase of PHASES) {
    approvals[phase] = normalizeApproval(approvalsRaw[phase]);
  }

  return {
    ...raw,
    approvals,
    ready_for_implementation: raw.ready_for_implementation === true,
  };
};

export const parseSpecJson = (text: string): ParseSpecResult => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Invalid JSON: ${message}` };
  }

  if (!isRecord(raw)) {
    return { ok: false, error: 'spec.json must contain a JSON object.' };
  }

  return { ok: true, spec: normalizeSpecJson(raw) };
};

export const serializeSpecJson = (spec: SpecJson): string =>
  `${JSON.stringify(spec, null, 2)}\n`;

/**
 * Update a single approval without inventing new phase values.
 * The extension owns approval state; agents keep writing the artifacts.
 */
export const withApproval = (
  spec: SpecJson,
  phase: PhaseKey,
  approved: boolean,
  now: Date = new Date(),
): SpecJson => {
  const next = JSON.parse(JSON.stringify(spec)) as SpecJson;
  next.approvals[phase] = { generated: true, approved };
  next.updated_at = now.toISOString();
  next.ready_for_implementation = PHASES.every((key) => next.approvals[key].approved);
  return next;
};

export const allApproved = (spec: SpecJson): boolean =>
  PHASES.every((phase) => spec.approvals[phase].approved);

export const nextAction = (spec: SpecJson): NextAction => {
  for (const phase of PHASES) {
    const approval = spec.approvals[phase];
    if (!approval.approved) {
      return approval.generated
        ? { kind: 'review', phase, label: `Review and approve ${phase}` }
        : { kind: 'generate', phase, label: `Generate ${phase}` };
    }
  }

  return { kind: 'implement', label: 'Ready for implementation' };
};

export const phaseStatus = (
  spec: SpecJson | null,
  phase: PhaseKey,
  exists: boolean,
): PhaseStatus => {
  if (!exists) {
    return 'missing';
  }

  const approval = spec?.approvals[phase];
  if (approval?.approved) {
    return 'approved';
  }
  if (approval?.generated) {
    return 'generated';
  }
  return 'draft';
};
