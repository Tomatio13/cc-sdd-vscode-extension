import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listSpecs,
  readArtifact,
  toggleTaskCheckbox,
  updateApproval,
} from '../src/core/repository';

let root: string;

const specJson = (approved = false): string =>
  `${JSON.stringify(
    {
      feature_name: 'alpha',
      phase: 'requirements-generated',
      approvals: {
        requirements: { generated: true, approved },
        design: { generated: false, approved: false },
        tasks: { generated: false, approved: false },
      },
      ready_for_implementation: false,
    },
    null,
    2,
  )}\n`;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-sdd-vscode-'));
  const specDir = path.join(root, '.kiro', 'specs', 'alpha');
  await fs.mkdir(specDir, { recursive: true });
  await fs.writeFile(path.join(specDir, 'spec.json'), specJson(), 'utf8');
  await fs.writeFile(path.join(specDir, 'requirements.md'), '# Requirements\n', 'utf8');
  await fs.writeFile(
    path.join(specDir, 'tasks.md'),
    '# Implementation Plan\n\n- [ ] 1. First task\n  - _Requirements: 1_\n',
    'utf8',
  );
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('listSpecs', () => {
  it('lists spec directories and artifact existence', async () => {
    const records = await listSpecs(root, '.kiro');

    expect(records).toHaveLength(1);
    expect(records[0].id).toBe('alpha');
    expect(records[0].spec?.feature_name).toBe('alpha');
    expect(records[0].exists).toEqual({
      requirements: true,
      design: false,
      tasks: true,
    });
  });

  it('returns an empty list when the specs directory does not exist', async () => {
    await expect(listSpecs(root, 'missing')).resolves.toEqual([]);
  });
});

describe('readArtifact', () => {
  it('returns undefined for a missing artifact', async () => {
    const [record] = await listSpecs(root, '.kiro');
    await expect(readArtifact(record, 'design')).resolves.toBeUndefined();
  });
});

describe('updateApproval', () => {
  it('writes approval state atomically and keeps the rest of the file', async () => {
    const updated = await updateApproval(root, '.kiro', 'alpha', 'design', true);

    expect(updated.approvals.design).toEqual({ generated: true, approved: true });
    expect(updated.feature_name).toBe('alpha');

    const written = JSON.parse(
      await fs.readFile(path.join(root, '.kiro', 'specs', 'alpha', 'spec.json'), 'utf8'),
    );
    expect(written.approvals.design).toEqual({ generated: true, approved: true });
    expect(written.approvals.requirements.approved).toBe(false);
    expect(written.ready_for_implementation).toBe(false);
  });

  it('rejects an unknown spec id', async () => {
    await expect(updateApproval(root, '.kiro', 'missing', 'design', true)).rejects.toThrow(
      /not found/,
    );
  });

  it('rejects path traversal', async () => {
    await expect(updateApproval(root, '.kiro', '../escape', 'design', true)).rejects.toThrow(
      /Invalid spec id/,
    );
  });
});

describe('toggleTaskCheckbox', () => {
  it('updates tasks.md through the repository layer', async () => {
    const [record] = await listSpecs(root, '.kiro');
    await toggleTaskCheckbox(record, 2);

    const content = await fs.readFile(record.artifacts.tasks, 'utf8');
    expect(content).toContain('- [x] 1. First task');
  });
});
