import * as vscode from 'vscode';
import { formatWhen, type SessionRecord } from '../core/sessions';

export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionRecord> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly load: () => Promise<SessionRecord[]>) {}

  refresh(): void {
    this.changed.fire();
  }

  getChildren(element?: SessionRecord): vscode.ProviderResult<SessionRecord[]> {
    if (element) {
      return [];
    }
    return this.load();
  }

  getTreeItem(session: SessionRecord): vscode.TreeItem {
    const item = new vscode.TreeItem(session.title, vscode.TreeItemCollapsibleState.None);
    item.description = formatWhen(session.updatedAt);
    item.iconPath = new vscode.ThemeIcon('history');
    item.contextValue = 'session';
    item.tooltip = new vscode.MarkdownString(
      [
        `**${session.title}**`,
        '',
        session.lastMessage ? `> ${session.lastMessage}` : undefined,
        session.lastMessage ? '' : undefined,
        `- id: \`${session.id}\``,
        `- updated: ${new Date(session.updatedAt).toLocaleString()}`,
        session.cwd ? `- cwd: \`${session.cwd}\`` : undefined,
        `- file: \`${session.filePath}\``,
      ]
        .filter((line): line is string => line !== undefined)
        .join('\n'),
    );
    item.command = {
      command: 'ccSdd.previewSession',
      title: 'Preview Session',
      arguments: [session],
    };
    return item;
  }
}
