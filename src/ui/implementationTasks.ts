import type * as vscode from 'vscode';
import type { SpecRecord } from '../core/repository';
import type { SpecProgress } from '../core/progress';
import { buildTaskTree, type ParsedTask } from '../core/tasks';
import type { TaskTreeProvider } from './taskTree';

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

/** Render from this spec's progress, never the globally selected spec. */
export function renderImplementationTasks(
  record: SpecRecord,
  progress: SpecProgress,
  provider: TaskTreeProvider,
  button: (label: string, command?: vscode.Command, className?: string) => string,
): string {
  const action = (label: string, command: string, arg: unknown): string =>
    button(label, { command, title: label, arguments: [arg] }, 'secondary');
  const render = (task: ParsedTask): string => {
    const node = provider.toTaskNode(record, progress, task);
    const item = provider.getTreeItem(node);
    const label = typeof item.label === 'string' ? item.label : (item.label?.label ?? '');
    const description = typeof item.description === 'string' ? item.description : '';
    const arg = { record, task };
    const controls = [
      button('Open', item.command, 'secondary'),
      action(task.checked ? 'Mark incomplete' : 'Complete', 'ccSdd.toggleTask', arg),
    ];
    if (item.contextValue === 'task-todo')
      controls.push(
        action('Run', 'ccSdd.runTask', arg),
        action('Run remaining', 'ccSdd.runFromTask', arg),
      );
    if (node.running) controls.push(action('Open run', 'ccSdd.openSpecRun', record));
    const state = node.running
      ? 'Running'
      : node.waiting.length
        ? 'Waiting'
        : node.next
          ? 'Next'
          : task.checked
            ? 'Done'
            : '';
    return `<details class="task-row" data-key="${escapeHtml(item.id!)}"><summary><span class="task-marker" aria-hidden="true">${task.checked ? '✓' : node.running ? '●' : '○'}</span><span class="task-name" title="${escapeHtml(label)}">${escapeHtml(label)}</span><small>${escapeHtml(state)}</small></summary><div class="task-detail"><small>${escapeHtml(description)}</small><div class="actions">${controls.join('')}</div>${task.children.length ? `<div class="task-children">${task.children.map(render).join('')}</div>` : ''}</div></details>`;
  };
  const roots = buildTaskTree(progress.tasks);
  const open = roots.filter((task) => !task.checked);
  const done = roots.filter((task) => task.checked);
  return `<div class="implementation-tasks">${open.map(render).join('')}${done.length ? `<details class="task-group" data-key="completed:${escapeHtml(record.id)}"><summary><span>Completed tasks</span><small>${done.length}</small></summary><div class="task-group-body">${done.map(render).join('')}</div></details>` : ''}${roots.length ? '' : '<small>No implementation tasks yet</small>'}</div>`;
}
