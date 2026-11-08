import * as vscode from 'vscode';
import type { SpecRecord } from '../core/repository';
import { buildTaskTree, parseTasks, type ParsedTask } from '../core/tasks';
import { taskStateIcon, taskStateLabel } from './treeState';

export type TaskTreeNode =
  | { kind: 'task'; record: SpecRecord; task: ParsedTask }
  | { kind: 'message'; label: string; description?: string };

const taskItem = (record: SpecRecord, task: ParsedTask): vscode.TreeItem => {
  const collapsible =
    task.children.length > 0
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;

  const item = new vscode.TreeItem(`${task.id}. ${task.title}`, collapsible);
  item.id = `task:${record.id}:${task.line}:${task.id}`;
  item.contextValue = task.checked ? 'task-done' : 'task-todo';
  item.iconPath = new vscode.ThemeIcon(taskStateIcon(task.checked));

  const description: string[] = [];
  if (task.parallel) {
    description.push('parallel');
  }
  if (task.requirements.length > 0) {
    const [first, ...rest] = task.requirements;
    description.push(`req ${first}${rest.length > 0 ? ` +${rest.length}` : ''}`);
  }
  item.description = description.join(' · ');

  item.command = {
    command: 'ccSdd.openTask',
    title: 'Open Task',
    arguments: [{ record, task }],
  };

  const tooltip = new vscode.MarkdownString();
  tooltip.supportThemeIcons = true;
  tooltip.appendMarkdown(`**${task.id}. ${task.title}**\n\n`);
  tooltip.appendMarkdown(`Line: \`${task.line + 1}\`\n\n`);
  if (task.parallel) {
    tooltip.appendMarkdown('Parallel task\n\n');
  }
  if (task.boundary) {
    tooltip.appendMarkdown(`Boundary: \`${task.boundary}\`\n\n`);
  }
  if (task.depends.length > 0) {
    tooltip.appendMarkdown(`Depends: \`${task.depends.join(', ')}\`\n\n`);
  }
  if (task.requirements.length > 0) {
    tooltip.appendMarkdown(`Requirements: \`${task.requirements.join(', ')}\`\n\n`);
  }
  tooltip.appendMarkdown(
    `${task.checked ? '$(pass-filled)' : '$(circle-outline)'} ${taskStateLabel(task.checked)}`,
  );
  item.tooltip = tooltip;

  return item;
};

export class TaskTreeProvider implements vscode.TreeDataProvider<TaskTreeNode> {
  private readonly changed = new vscode.EventEmitter<TaskTreeNode | undefined | void>();

  private active: SpecRecord | undefined;

  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly readTasks: (record: SpecRecord) => Promise<string | undefined>,
  ) {}

  setActive(record: SpecRecord | undefined): void {
    this.active = record;
    this.changed.fire();
  }

  refresh(): void {
    this.changed.fire();
  }

  async getChildren(element?: TaskTreeNode): Promise<TaskTreeNode[]> {
    if (!this.active) {
      return [
        {
          kind: 'message',
          label: 'No spec selected',
          description: 'Choose one in Specs',
        },
      ];
    }

    if (!element) {
      const content = await this.readTasks(this.active);
      if (content === undefined) {
        return [
          {
            kind: 'message',
            label: 'Tasks not generated',
            description: 'Run /kiro-spec-tasks',
          },
        ];
      }

      const tasks = buildTaskTree(parseTasks(content));
      if (tasks.length === 0) {
        return [
          {
            kind: 'message',
            label: 'No tasks',
            description: 'Run /kiro-spec-tasks',
          },
        ];
      }

      return tasks.map((task) => ({ kind: 'task', record: this.active as SpecRecord, task }));
    }

    if (element.kind === 'task') {
      return element.task.children.map((task) => ({
        kind: 'task',
        record: element.record,
        task,
      }));
    }

    return [];
  }

  getTreeItem(node: TaskTreeNode): vscode.TreeItem {
    if (node.kind === 'message') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.description = node.description;
      item.contextValue = 'message';
      return item;
    }

    return taskItem(node.record, node.task);
  }
}
