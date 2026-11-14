import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { SpecTreeProvider, SpecTreeNode } from './specTree';
import { renderImplementationTasks } from './implementationTasks';
import type { TaskTreeProvider } from './taskTree';
import type { RunState } from '../run/claudeRunner';
import { phaseStateLabel } from './treeState';
import { IMPLEMENTATION_SKILL, PHASE_META, VALIDATE_IMPL_SKILL } from '../core/phases';

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

const percentLabel = (value: number): string => `${Number(value.toFixed(1))}%`;

/** Uses the existing tree's state and commands as the timeline's source of truth. */
export class SpecTimeline implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private timer?: NodeJS.Timeout;
  private revision = 0;
  private commands = new Map<string, vscode.Command>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly provider: SpecTreeProvider,
    private readonly getRuns: () => RunState[],
    private readonly openRun: (id: string) => void,
    private readonly tasks?: TaskTreeProvider,
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
    view.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${asset('specTimeline.css')}"></head>
      <body><main id="timeline" aria-label="Spec timeline">Loading specs…</main>
      <script nonce="${nonce}" src="${asset('specTimeline.js')}"></script></body></html>`;
    this.subscriptions.push(
      view.webview.onDidReceiveMessage((message: unknown) => {
        if (!message || typeof message !== 'object') return;
        const { type, id } = message as { type?: unknown; id?: unknown };
        if (type === 'ready') this.refresh();
        if (type !== 'action' || typeof id !== 'string') return;
        const command = this.commands.get(id);
        if (!command) return;
        if (command.command === 'timeline.openRun') {
          this.openRun(command.arguments![0]);
          return;
        }
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

  refresh(): void {
    // Invalidate in-flight reads immediately, including while updates coalesce.
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
    const commandId = (command: vscode.Command): string => {
      const id = `${revision}:${commands.size}`;
      commands.set(id, command);
      return id;
    };
    const button = (label: string, command?: vscode.Command, className = ''): string => {
      if (!command) return `<span>${escapeHtml(label)}</span>`;
      const id = commandId(command);
      return `<button class="${className}" data-action="${id}" data-focus="${escapeHtml(command.command + ':' + label)}">${escapeHtml(label)}</button>`;
    };
    const action = (label: string, command: string, arg?: unknown): string =>
      button(
        label,
        { command, title: label, arguments: arg === undefined ? [] : [arg] },
        'secondary',
      );
    try {
      const roots = await this.provider.getChildren();
      const runs = this.getRuns();
      const sections = await Promise.all(
        roots.map(async (node) => {
          const item = this.provider.getTreeItem(node);
          const label = typeof item.label === 'string' ? item.label : (item.label?.label ?? '');
          const description = typeof item.description === 'string' ? item.description : '';
          if (node.kind !== 'spec') {
            return `<div class="workspace-row">${button(label, item.command)}<small>${escapeHtml(description)}</small>${node.kind === 'steering' ? action('Run', 'ccSdd.runSteering') : ''}</div>`;
          }
          const children = await this.provider.getChildren(node);
          const rows = children
            .map((child) => this.renderRow(child, button, action, runs))
            .join('');
          const progress = node.progress;
          const recent = runs
            .filter((run) => run.feature === node.record.id && run.status !== 'preview')
            .sort((a, b) => b.startedAt - a.startedAt)
            .slice(0, 5);
          const history = recent.length
            ? `<details class="history" data-key="history:${escapeHtml(node.record.id)}"><summary>Recent runs · ${recent.length}</summary><ol>${recent
                .map((run) => {
                  const state = run.pending ? 'waiting' : run.status;
                  const time = new Date(run.startedAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  });
                  return `<li class="event ${escapeHtml(state)}"><time>${escapeHtml(time)}</time>${button(run.skill.replace(/^kiro-/, ''), { command: 'timeline.openRun', title: 'Open run', arguments: [run.id] })}<small>${escapeHtml(run.pending ? 'Input waiting' : run.status)}</small></li>`;
                })
                .join('')}</ol></details>`
            : '';
          const selectId = commandId({
            command: 'ccSdd.selectSpec',
            title: 'Select Spec',
            arguments: [node.record],
          });
          const active = description.split(' · ').includes('active');
          return `<details class="spec" data-select="${selectId}" data-active="${active}" data-key="spec:${escapeHtml(node.record.id)}" ${progress.completed ? '' : 'open'}>
          <summary><span class="spec-name">${escapeHtml(label)}</span><small>${escapeHtml(description)}</small></summary>
          <div class="spec-body">
          <ol class="stages">${rows}</ol>${history}
          <details class="spec-options" data-key="options:${escapeHtml(node.record.id)}"><summary>Spec actions</summary><div class="spec-tools">${action('Select', 'ccSdd.selectSpec', node.record)}${action('spec.json', 'ccSdd.openSpecJson', node.record)}${action('Gap check', 'ccSdd.runValidateGap', node.record)}${action('Design check', 'ccSdd.runValidateDesign', node.record)}</div></details></div></details>`;
        }),
      );
      if (!roots.some((node) => node.kind === 'spec')) {
        sections.push(
          `<div class="empty">No cc-sdd specs found.<div class="spec-tools">${action('Create a spec', 'ccSdd.newSpec')}${action('Install cc-sdd', 'ccSdd.install')}</div></div>`,
        );
      }
      if (revision !== this.revision || this.view !== view) return;
      this.commands = commands;
      await view.webview.postMessage({
        type: 'render',
        html: sections.join(''),
      });
    } catch (error) {
      if (revision !== this.revision || this.view !== view) return;
      await view.webview.postMessage({
        type: 'error',
        text: `Unable to load specs: ${String(error)}`,
      });
    }
  }

  private renderRow(
    node: SpecTreeNode,
    button: (label: string, command?: vscode.Command, className?: string) => string,
    action: (label: string, command: string, arg?: unknown) => string,
    runs: RunState[],
  ): string {
    const item = this.provider.getTreeItem(node);
    let label = (typeof item.label === 'string' ? item.label : (item.label?.label ?? '')).replace(
      /^\d+\. /,
      '',
    );
    let description = typeof item.description === 'string' ? item.description : '';
    if (node.kind === 'action')
      return `<li class="next">${button(label, item.command)}<small>${escapeHtml(description)}</small></li>`;
    if (node.kind !== 'stage')
      return `<li class="notice">${escapeHtml(label)}<small>${escapeHtml(description)}</small></li>`;
    const skill =
      node.stage === 'implementation'
        ? IMPLEMENTATION_SKILL
        : node.stage === 'verification'
          ? VALIDATE_IMPL_SKILL
          : PHASE_META[node.stage].skill;
    const live = runs.find(
      (run) =>
        run.feature === node.record.id &&
        run.skill === skill &&
        run.status !== 'preview' &&
        (run.pending || run.status === 'running'),
    );
    const context = item.contextValue ?? '';
    let state = /approved|complete|verified/.test(context)
      ? 'done'
      : /failed|error/.test(context)
        ? 'error'
        : /generated|draft|stale|manual|unconfirmed/.test(context)
          ? 'waiting'
          : node.current
            ? 'current'
            : 'future';
    if (node.stage === 'tasks') {
      label = 'Task planning';
      description = phaseStateLabel(node.progress.approvals.tasks);
    }
    const percentage =
      node.stage === 'implementation'
        ? node.progress.tasksTotal > 0
          ? (node.progress.tasksDone / node.progress.tasksTotal) * 100
          : 0
        : node.stage === 'verification'
          ? node.progress.verification.status === 'verified'
            ? 100
            : 0
          : node.progress.approvals[node.stage] === 'approved'
            ? 100
            : 0;
    if (node.stage === 'implementation' && percentage < 100 && state === 'done') {
      state = node.current ? 'current' : 'future';
    }
    if (live) {
      state = live.pending ? 'waiting' : 'running';
      description = live.pending ? 'Input waiting' : 'Running';
    }
    const controls: string[] = [];
    if (live)
      controls.push(
        button(
          'Open run',
          {
            command: 'timeline.openRun',
            title: 'Open run',
            arguments: [live.id],
          },
          'secondary',
        ),
      );
    if (node.stage === 'requirements' || node.stage === 'design' || node.stage === 'tasks') {
      const arg = { record: node.record, phase: node.stage };
      if (!live && /^phase-(missing|draft|generated)$/.test(context))
        controls.push(action('Run', 'ccSdd.runPhase', arg));
      if (/^phase-(draft|generated)$/.test(context))
        controls.push(action('Approve', 'ccSdd.approvePhase', arg));
      if (context === 'phase-approved') controls.push(action('Revoke', 'ccSdd.revokePhase', arg));
    }
    if (context === 'impl-in-progress') controls.push(action('Run', 'ccSdd.runImpl', node.record));
    if (/^verification-(none|failed|stale|manual|unconfirmed|error)$/.test(context) && !live)
      controls.push(action('Verify', 'ccSdd.runValidateImpl', node.record));
    const tooltip = typeof item.tooltip === 'string' ? item.tooltip : '';
    const activity = live?.segments
      ?.slice()
      .reverse()
      .find((segment) => (segment.kind === 'tool' || segment.kind === 'text') && segment.text);
    const activityText = live?.pending?.summary ?? activity?.text;
    const detail = activityText ? activityText.replace(/\s+/g, ' ').trim().slice(0, 180) : '';
    const open = Boolean(live);
    const primary = !live && item.command ? button('Open', item.command, 'secondary') : '';
    const tasksHtml =
      node.stage === 'implementation' && this.tasks
        ? renderImplementationTasks(node.record, node.progress, this.tasks, button)
        : '';
    return `<li class="stage ${state}" ${node.current ? 'aria-current="step"' : ''}><span class="dot" aria-hidden="true">${state === 'done' ? '✓' : ''}</span><details class="stage-content" data-key="row:${escapeHtml(node.record.id)}:${node.stage}" ${open ? 'open' : ''}><summary title="${escapeHtml(tooltip)}"><span class="stage-title">${escapeHtml(label)}</span><small class="stage-status">${escapeHtml(description)}</small>${node.stage === 'tasks' ? '' : `<span class="stage-progress"><progress aria-label="${escapeHtml(label)} progress" value="${percentage}" max="100"></progress><span>${percentLabel(percentage)}</span></span>`}</summary><div class="stage-detail">${detail ? `<p class="activity" title="${escapeHtml(detail)}">${escapeHtml(detail)}</p>` : ''}<div class="actions">${primary}${controls.join('')}</div>${tasksHtml}</div></details></li>`;
  }

  dispose(): void {
    this.revision += 1;
    if (this.timer) clearTimeout(this.timer);
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.commands.clear();
  }
}
