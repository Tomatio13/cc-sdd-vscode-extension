import type { NextStepState, PhaseKey } from './spec';

export interface PhaseMeta {
  key: PhaseKey;
  label: string;
  file: string;
  skill: string;
  description: string;
}

export const PHASE_META: Record<PhaseKey, PhaseMeta> = {
  requirements: {
    key: 'requirements',
    label: 'Requirements',
    file: 'requirements.md',
    skill: 'kiro-spec-requirements',
    description: 'EARS requirements and acceptance criteria',
  },
  design: {
    key: 'design',
    label: 'Design',
    file: 'design.md',
    skill: 'kiro-spec-design',
    description: 'Architecture, boundaries, and file structure plan',
  },
  tasks: {
    key: 'tasks',
    label: 'Tasks',
    file: 'tasks.md',
    skill: 'kiro-spec-tasks',
    description: 'Implementation tasks with boundaries and dependencies',
  },
};

export const IMPLEMENTATION_SKILL = 'kiro-impl';
export const NEW_SPEC_SKILL = 'kiro-spec-init';
export const DISCOVERY_SKILL = 'kiro-discovery';
export const VALIDATE_IMPL_SKILL = 'kiro-validate-impl';
export const STEERING_SKILL = 'kiro-steering';
export const VALIDATE_GAP_SKILL = 'kiro-validate-gap';
export const VALIDATE_DESIGN_SKILL = 'kiro-validate-design';

/** Label shown after "Next:" in both the Specs tree and the Overview. */
export const nextStepLabel = (step: NextStepState): string | undefined => {
  switch (step.kind) {
    case 'generate':
      return `Generate ${PHASE_META[step.phase].label.toLowerCase()}`;
    case 'review':
      return `Review ${PHASE_META[step.phase].label}`;
    case 'implement':
      return 'Run implementation';
    case 'done':
    case 'missing':
      return undefined;
  }
};
