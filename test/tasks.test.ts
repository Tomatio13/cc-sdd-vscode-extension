import { describe, expect, it } from 'vitest';
import { buildTaskTree, parseTasks, toggleTaskInMarkdown } from '../src/core/tasks';

const SAMPLE = `# Implementation Plan

## Task List

- [ ] 1. Set up project foundation
- [ ] 1.1 (P) Initialize the app
  - Create the backend and frontend skeleton
  - _Boundary: backend, frontend_
  - _Depends: 2.1, 2.2_
  - _Requirements: 1.1, 1.2_
- [x] 1.2 Configure storage
  - _Requirements: 2.1_
- [ ]* 2. Auth
  - [ ] 2.1 Login
  - _Requirements: 3.1_
`;

describe('parseTasks', () => {
  it('parses tasks, checkboxes, parallel markers, and metadata', () => {
    const tasks = parseTasks(SAMPLE);

    expect(tasks).toHaveLength(5);
    expect(tasks.map((task) => task.id)).toEqual(['1', '1.1', '1.2', '2', '2.1']);

    const parallel = tasks.find((task) => task.id === '1.1');
    expect(parallel).toMatchObject({
      checked: false,
      parallel: true,
      boundary: 'backend, frontend',
      depends: ['2.1', '2.2'],
      requirements: ['1.1', '1.2'],
      line: 5,
    });

    const done = tasks.find((task) => task.id === '1.2');
    expect(done).toMatchObject({ checked: true, requirements: ['2.1'] });
  });

  it('supports deferred-test checkboxes', () => {
    const task = parseTasks(SAMPLE).find((candidate) => candidate.id === '2');
    expect(task?.checked).toBe(false);
    expect(task?.title).toBe('Auth');
  });

  it('strips template guidance from metadata values', () => {
    const task = parseTasks(
      `- [ ] 1.1 (P) Parallel task
  - _Boundary: backend_ (Only for (P) tasks. Omit when scope is obvious.)
  - _Requirements: 1.1, 1.2_ (IDs only; do not add descriptions or parentheses.)
`,
    )[0];

    expect(task.boundary).toBe('backend');
    expect(task.requirements).toEqual(['1.1', '1.2']);
  });

  it('builds a parent/child tree from numeric task IDs', () => {
    const roots = buildTaskTree(parseTasks(SAMPLE));

    expect(roots.map((task) => task.id)).toEqual(['1', '2']);
    expect(roots[0].children.map((task) => task.id)).toEqual(['1.1', '1.2']);
    expect(roots[1].children.map((task) => task.id)).toEqual(['2.1']);
  });
});

describe('toggleTaskInMarkdown', () => {
  it('flips a checkbox without touching other lines', () => {
    const updated = toggleTaskInMarkdown(SAMPLE, 4);
    expect(updated.split('\n')[4]).toBe('- [x] 1. Set up project foundation');
    expect(updated.split('\n')[10]).toBe('- [x] 1.2 Configure storage');
  });

  it('unchecks a completed task', () => {
    const updated = toggleTaskInMarkdown(SAMPLE, 10);
    expect(updated.split('\n')[10]).toBe('- [ ] 1.2 Configure storage');
  });

  it('preserves CRLF line endings', () => {
    const crlf = SAMPLE.replace(/\n/g, '\r\n');
    const updated = toggleTaskInMarkdown(crlf, 4);
    expect(updated).toContain('\r\n');
    expect(updated.split('\r\n')[4]).toBe('- [x] 1. Set up project foundation');
  });

  it('rejects a line that is not a task', () => {
    expect(() => toggleTaskInMarkdown(SAMPLE, 0)).toThrow(/not a task checkbox/);
  });
});
