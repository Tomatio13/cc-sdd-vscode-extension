import type { PhaseStatus } from '../core/spec';

/** One status vocabulary shared by the Specs, Tasks, and Sessions trees. */
export const phaseStateLabel = (status: PhaseStatus): string => {
  switch (status) {
    case 'missing':
      return 'not started';
    case 'draft':
      return 'draft';
    case 'generated':
      return 'in review';
    case 'approved':
      return 'approved';
  }
};

export const phaseStateIcon = (status: PhaseStatus): string => {
  switch (status) {
    case 'missing':
      return 'circle-slash';
    case 'draft':
      return 'circle-outline';
    case 'generated':
      return 'diff';
    case 'approved':
      return 'pass-filled';
  }
};

export const taskStateIcon = (checked: boolean): string =>
  checked ? 'pass-filled' : 'circle-outline';

export const taskStateLabel = (checked: boolean): string => (checked ? 'done' : 'not started');

export const countLabel = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`;
