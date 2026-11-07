import { PHASE_META } from './phases';
import type { PhaseKey } from './spec';
import { buildTaskTree, flattenTasks, parseTasks } from './tasks';

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

const PLACEHOLDER_RE = /\{\{[A-Z0-9_]+\}\}/g;

const unique = (values: string[]): string[] => [...new Set(values)];

const countHeadings = (content: string, level: number): number =>
  (content.match(new RegExp(`^#{${level}}\\s+`, 'gm')) ?? []).length;

/**
 * Gate checks run before an approval is recorded.
 * Errors block approval; warnings require explicit confirmation in the UI.
 *
 * Section names are only checked for English documents. Other languages use
 * structural checks so that Kiro-compatible translated specs are not blocked.
 */
export const validateArtifact = (
  phase: PhaseKey,
  content: string | undefined,
  language = 'en',
): ValidationResult => {
  const meta = PHASE_META[phase];
  const errors: string[] = [];
  const warnings: string[] = [];
  const english = !language || language.toLowerCase().startsWith('en');

  if (content === undefined) {
    errors.push(`${meta.file} does not exist. Run /${meta.skill} first.`);
    return { errors, warnings };
  }

  if (content.trim().length < 40) {
    errors.push(`${meta.file} is empty or too short to review.`);
  }

  const placeholders = unique(Array.from(content.matchAll(PLACEHOLDER_RE), (match) => match[0]));
  if (placeholders.length > 0) {
    errors.push(
      `${meta.file} still contains template placeholders: ${placeholders.join(', ')}`,
    );
  }

  if (!/^#\s+\S/m.test(content)) {
    errors.push(`${meta.file} has no top-level heading.`);
  }

  if (phase === 'requirements') {
    validateRequirements(content, english, errors, warnings);
  } else if (phase === 'design') {
    validateDesign(content, english, errors, warnings);
  } else {
    validateTasks(content, errors, warnings);
  }

  return { errors: unique(errors), warnings: unique(warnings) };
};

const validateRequirements = (
  content: string,
  english: boolean,
  errors: string[],
  warnings: string[],
): void => {
  // A numbered level-3 heading is language-independent: "### Requirement 1" or "### 要件1".
  const requirementHeadings = content.match(/^###\s+.*\d.*$/gim) ?? [];

  if (requirementHeadings.length === 0) {
    errors.push(
      'requirements.md has no numbered requirement headings (for example "### Requirement 1: ...").',
    );
  }

  if (english) {
    if (!/^##\s+Requirements\b/im.test(content)) {
      warnings.push('requirements.md has no "## Requirements" section.');
    }
    if (!/^##\s+Introduction\b/im.test(content)) {
      warnings.push('requirements.md has no "## Introduction" section.');
    }
    if (!/^####\s+Acceptance Criteria\b/im.test(content)) {
      warnings.push('requirements.md has no "#### Acceptance Criteria" section.');
    }
  } else {
    if (countHeadings(content, 2) === 0) {
      warnings.push('requirements.md has no level-2 sections.');
    }
    if (countHeadings(content, 4) === 0) {
      warnings.push('requirements.md has no level-4 sections (acceptance criteria).');
    }
  }
};

const validateDesign = (
  content: string,
  english: boolean,
  errors: string[],
  warnings: string[],
): void => {
  if (english) {
    if (!/^##\s+Overview\b/im.test(content)) {
      errors.push('design.md has no "## Overview" section.');
    }

    if (!/^##\s+(?:Architecture|Components and Interfaces)\b/im.test(content)) {
      errors.push(
        'design.md has no "## Architecture" or "## Components and Interfaces" section.',
      );
    }

    if (!/^##\s+File Structure Plan\b/im.test(content)) {
      warnings.push('design.md has no "## File Structure Plan" section (cc-sdd v3 expects it).');
    }

    if (!/^##\s+Boundary Commitments\b/im.test(content)) {
      warnings.push('design.md has no "## Boundary Commitments" section.');
    }

    if (!/^##\s+Requirements Traceability\b/im.test(content)) {
      warnings.push('design.md has no "## Requirements Traceability" section.');
    }
  } else {
    const levelTwoSections = countHeadings(content, 2);
    if (levelTwoSections < 2) {
      errors.push('design.md needs at least two level-2 sections.');
    } else if (levelTwoSections < 4) {
      warnings.push(
        `design.md has only ${levelTwoSections} level-2 sections; check that architecture and boundary decisions are covered.`,
      );
    }
  }
};

const validateTasks = (
  content: string,
  errors: string[],
  warnings: string[],
): void => {
  const tasks = parseTasks(content);

  if (tasks.length === 0) {
    errors.push('tasks.md contains no checkbox tasks.');
    return;
  }

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) {
      duplicates.add(task.id);
    }
    seen.add(task.id);
  }

  if (duplicates.size > 0) {
    warnings.push(`tasks.md has duplicate task IDs: ${[...duplicates].join(', ')}`);
  }

  const parallelWithoutBoundary = tasks.filter((task) => task.parallel && !task.boundary);
  if (parallelWithoutBoundary.length > 0) {
    warnings.push(
      `tasks.md has ${parallelWithoutBoundary.length} parallel task(s) without _Boundary:_ metadata: ${parallelWithoutBoundary
        .map((task) => task.id)
        .join(', ')}`,
    );
  }

  // Only leaf tasks are expected to carry traceability metadata. A major task
  // with sub-tasks can omit it because the leaves carry the requirement links.
  const leaves = flattenTasks(buildTaskTree(tasks)).filter(
    (task) => task.children.length === 0,
  );
  const missingRequirements = leaves.filter((task) => task.requirements.length === 0);
  if (missingRequirements.length > 0) {
    warnings.push(
      `tasks.md has ${missingRequirements.length} leaf task(s) without _Requirements:_ metadata: ${missingRequirements
        .map((task) => task.id)
        .join(', ')}`,
    );
  }
};
