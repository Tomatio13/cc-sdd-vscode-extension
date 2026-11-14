import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { renderImplementationTasks } from '../src/ui/implementationTasks';
import { parseTasks } from '../src/core/tasks';
import type { SpecProgress } from '../src/core/progress';
import type { SpecRecord } from '../src/core/repository';
import type { TaskTreeNode, TaskTreeProvider } from '../src/ui/taskTree';

const provider = {
  toTaskNode: (record: SpecRecord, _progress: SpecProgress, task: { checked: boolean }) => ({
    kind: 'task',
    record,
    task,
    waiting: [],
    next: false,
    running: false,
  }),
  getTreeItem: (node: Extract<TaskTreeNode, { kind: 'task' }>) => ({
    id: `task:${node.record.id}:${node.task.id}`,
    label: `${node.task.id}. ${node.task.title}`,
    contextValue: node.task.checked ? 'task-done' : 'task-todo',
    command: {
      command: 'ccSdd.openTask',
      title: 'Open',
      arguments: [{ record: node.record, task: node.task }],
    },
  }),
} as unknown as TaskTreeProvider;

function render(id: string, markdown: string) {
  const record = { id } as SpecRecord;
  const progress = { tasks: parseTasks(markdown) } as SpecProgress;
  const commands: vscode.Command[] = [];
  const html = renderImplementationTasks(record, progress, provider, (label, command) => {
    if (command) commands.push(command);
    return `<button>${label}</button>`;
  });
  return { html, commands };
}

describe('embedded implementation tasks', () => {
  it('keeps nested tasks and completed tasks folded without repeating verification', () => {
    const { html } = render('alpha', '- [ ] 1. Parent\n- [ ] 1.1 Child\n- [x] 2. Done');
    expect(html).toContain('task-children');
    expect(html).toContain('Child');
    expect(html).toContain('data-key="completed:alpha"');
    expect(html).not.toContain('data-key="completed:alpha" open');
    expect(html).not.toContain('Verification');
  });

  it('binds each task operation to its own spec regardless of the selected spec', () => {
    for (const id of ['alpha', 'beta']) {
      const { commands } = render(id, '- [ ] 1. Implement');
      expect(commands.map((command) => command.command)).toEqual([
        'ccSdd.openTask',
        'ccSdd.toggleTask',
        'ccSdd.runTask',
        'ccSdd.runFromTask',
      ]);
      for (const command of commands) expect(command.arguments?.[0].record.id).toBe(id);
    }
  });
});
