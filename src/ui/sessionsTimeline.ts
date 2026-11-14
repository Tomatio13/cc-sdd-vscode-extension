import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { SessionTreeNode, SessionsTreeProvider } from './sessionsTree';
import { formatTokenCount } from '../core/sessions';

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

export function sessionWhen(timestamp: number, now = new Date()): string {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return date.toDateString() === now.toDateString()
    ? time
    : `${date.toLocaleDateString([], { month: '2-digit', day: '2-digit', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}) })} ${time}`;
}

/** Same session ownership and activity rules, presented as a monochrome history. */
export class SessionsTimeline implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private timer?: NodeJS.Timeout;
  private revision = 0;
  private commands = new Map<string, vscode.Command>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly provider: SessionsTreeProvider,
  ) {
    this.subscriptions.push(provider.onDidChangeTreeData(() => this.refresh()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = randomBytes(16).toString('hex');
    const asset = (name: string): string =>
      view.webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString();
    view.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${asset('specTimeline.css')}"></head><body><main id="timeline" class="sessions-timeline" aria-label="Session history">Loading history…</main><script nonce="${nonce}" src="${asset('specTimeline.js')}"></script></body></html>`;
    this.subscriptions.push(
      view.webview.onDidReceiveMessage((message: unknown) => {
        if (!message || typeof message !== 'object') return;
        const { type, id } = message as { type?: unknown; id?: unknown };
        if (type === 'ready') this.refresh();
        if (type !== 'action' || typeof id !== 'string') return;
        const command = this.commands.get(id);
        if (command)
          void Promise.resolve(
            vscode.commands.executeCommand(command.command, ...(command.arguments ?? [])),
          ).catch((error: unknown) => vscode.window.showErrorMessage(`cc-sdd: ${String(error)}`));
      }),
      view.onDidChangeVisibility(() => {
        if (view.visible) this.refresh();
      }),
      view.onDidDispose(() => {
        if (this.view === view) this.view = undefined;
      }),
    );
  }

  private refresh(): void {
    this.revision += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.update();
    }, 100);
  }

  private async update(): Promise<void> {
    const view = this.view;
    if (!view?.visible) return;
    const revision = this.revision;
    const commands = new Map<string, vscode.Command>();
    const button = (label: string, command: vscode.Command): string => {
      const id = `${revision}:${commands.size}`;
      commands.set(id, command);
      return `<button class="secondary" data-action="${id}" data-focus="${escapeHtml(command.command + ':' + label)}">${escapeHtml(label)}</button>`;
    };
    const action = (label: string, command: string, arg: unknown): string =>
      button(label, { command, title: label, arguments: [arg] });
    const render = (node: Extract<SessionTreeNode, { kind: 'session' }>): string => {
      const { session } = node;
      const excerpt = (session.lastMessage ?? session.title).replace(/\s+/g, ' ').trim();
      const status =
        node.viewState === 'running'
          ? 'Running'
          : node.viewState === 'waiting'
            ? 'Input waiting'
            : node.viewState === 'stale'
              ? 'Activity unconfirmed'
              : 'History';
      const controls = [action('Open', 'ccSdd.previewSession', session)];
      if (node.hasRun) controls.push(action('Open run', 'ccSdd.openSessionRun', session));
      if (!node.active) controls.push(action('Resume', 'ccSdd.resumeSession', session));
      const tokens = session.usage
        ? formatTokenCount(session.usage.inputTokens + session.usage.outputTokens)
        : undefined;
      return `<li class="session-event ${node.active ? 'session-active' : ''}"><details data-key="session:${escapeHtml(session.id)}"><summary><time datetime="${new Date(session.updatedAt).toISOString()}" title="${escapeHtml(new Date(session.updatedAt).toLocaleString())}">${escapeHtml(sessionWhen(session.updatedAt))}</time><span class="session-stage">${escapeHtml(node.stage)}${node.showSpec ? `<small> · ${escapeHtml(node.specLabel ?? 'Unlinked')}</small>` : ''}</span>${node.active ? `<small class="session-state">${status}</small>` : ''}<span class="session-excerpt" title="${escapeHtml(excerpt)}">${escapeHtml(excerpt)}</span></summary><div class="session-detail"><small>${status}${tokens ? ` · ${tokens} tokens` : ''}</small><p>${escapeHtml(excerpt)}</p><div class="actions">${controls.join('')}</div></div></details></li>`;
    };
    try {
      const roots = await this.provider.getChildren();
      const sections = await Promise.all(
        roots.map(async (node) => {
          if (node.kind === 'group') {
            const nodes = await this.provider.getChildren(node);
            const sessions = nodes
              .filter(
                (item): item is Extract<SessionTreeNode, { kind: 'session' }> =>
                  item.kind === 'session',
              )
              .sort((a, b) => b.session.updatedAt - a.session.updatedAt);
            return `<section class="session-section"><h2>${node.group === 'active' ? 'Active & waiting' : 'History'}<small>${sessions.length}</small></h2><ol class="session-events">${sessions.map(render).join('')}</ol></section>`;
          }
          const item = this.provider.getTreeItem(node);
          const label = typeof item.label === 'string' ? item.label : (item.label?.label ?? '');
          if (item.command)
            return `<div class="session-scope">${button(label, item.command)}</div>`;
          const detail = typeof item.description === 'string' ? item.description : '';
          return `<div class="notice">${escapeHtml(label)}<small>${escapeHtml(detail)}</small></div>`;
        }),
      );
      if (revision !== this.revision || view !== this.view) return;
      this.commands = commands;
      await view.webview.postMessage({ type: 'render', html: sections.join('') });
    } catch (error) {
      if (revision === this.revision && view === this.view)
        await view.webview.postMessage({
          type: 'error',
          text: `Unable to load session history: ${String(error)}`,
        });
    }
  }

  dispose(): void {
    this.revision += 1;
    if (this.timer) clearTimeout(this.timer);
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.commands.clear();
  }
}
