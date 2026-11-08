import * as vscode from 'vscode';
import { formatTokenCount, formatWhen, type SessionRecord } from '../core/sessions';

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
    const tokens = session.usage
      ? session.usage.inputTokens + session.usage.outputTokens
      : 0;
    item.description = [
      formatWhen(session.updatedAt),
      tokens > 0 ? `${formatTokenCount(tokens)} tok` : undefined,
      session.costUsd ? `~$${session.costUsd.toFixed(2)}` : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join(' · ');
    item.iconPath = new vscode.ThemeIcon('history');
    item.contextValue = 'session';
    item.tooltip = new vscode.MarkdownString(
      [
        `**${session.title}**`,
        '',
        session.lastMessage ? `> ${session.lastMessage}` : undefined,
        session.lastMessage ? '' : undefined,
        session.usage
          ? `- tokens: in ${formatTokenCount(session.usage.inputTokens)} · out ${formatTokenCount(
              session.usage.outputTokens,
            )} · cache read ${formatTokenCount(session.usage.cacheReadTokens)} · cache write ${formatTokenCount(
              session.usage.cacheCreationTokens,
            )}`
          : undefined,
        session.costUsd ? `- cost (est.): $${session.costUsd.toFixed(3)}` : undefined,
        session.apiMs !== undefined
          ? `- duration: api ${(session.apiMs / 1000).toFixed(1)}s · tools ${(
              (session.toolMs ?? 0) / 1000
            ).toFixed(1)}s`
          : undefined,
        session.linesAdded !== undefined || session.linesRemoved !== undefined
          ? `- lines: +${session.linesAdded ?? 0} / -${session.linesRemoved ?? 0}`
          : undefined,
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
