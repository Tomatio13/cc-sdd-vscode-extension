// "cc-sdd Overview": a team-facing portfolio over repository spec state and
// the local run records visible in this window. The header states that scope
// explicitly so local activity is not mistaken for team-wide truth.
import * as vscode from 'vscode';
import type { OverviewModel } from '../core/overview';
import { webviewThemeCss } from './webviewTheme';

export interface OverviewPanelOptions {
  load: () => Promise<OverviewModel>;
  openSpec: (specId: string) => Promise<void>;
  openRun: (runId: string) => void;
  openRuns: () => void;
}

interface OverviewMessage {
  type: string;
  specId?: string;
  runId?: string;
}

const getNonce = (): string => {
  let text = '';
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  for (let index = 0; index < 24; index += 1) {
    text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return text;
};

const REFRESH_DEBOUNCE_MS = 350;

export class OverviewPanel {
  private panel?: vscode.WebviewPanel;
  private refreshTimer?: NodeJS.Timeout;
  private loading = false;
  private pendingRefresh = false;
  private disposed = false;

  constructor(private readonly options: OverviewPanelOptions) {}

  show(): void {
    if (this.panel) {
      if (!this.panel.visible) {
        this.panel.reveal(undefined, true);
      }
      this.scheduleRefresh(0);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'ccSdd.overview',
      'cc-sdd Overview',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    panel.webview.html = this.buildHtml(panel.webview);
    panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
    panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.visible) {
        this.scheduleRefresh(0);
      }
    });
    panel.onDidDispose(() => {
      this.panel = undefined;
      if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = undefined;
      }
    });
    this.panel = panel;
    this.scheduleRefresh(0);
  }

  /** Coalesces file watcher and run notification bursts. */
  scheduleRefresh(delay = REFRESH_DEBOUNCE_MS): void {
    if (this.disposed || !this.panel?.visible) {
      return;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.loadAndPost();
    }, delay);
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.panel?.dispose();
    this.panel = undefined;
  }

  private async loadAndPost(): Promise<void> {
    if (!this.panel) {
      return;
    }
    if (this.loading) {
      this.pendingRefresh = true;
      return;
    }
    this.loading = true;
    try {
      const model = await this.options.load();
      if (!this.panel) {
        return;
      }
      void this.panel.webview.postMessage({ type: 'state', model });
    } catch (error) {
      if (this.panel) {
        void this.panel.webview.postMessage({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.loading = false;
      if (this.pendingRefresh) {
        this.pendingRefresh = false;
        this.scheduleRefresh(0);
      }
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const typed = message as OverviewMessage;
    switch (typed.type) {
      case 'ready':
      case 'refresh':
        await this.loadAndPost();
        return;
      case 'openSpec':
        if (typeof typed.specId === 'string') {
          await this.options.openSpec(typed.specId);
        }
        return;
      case 'openRun':
        if (typeof typed.runId === 'string') {
          this.options.openRun(typed.runId);
        }
        return;
      case 'openRuns':
        this.options.openRuns();
        return;
      default:
        return;
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>cc-sdd Overview</title>
  <style nonce="${nonce}">
${webviewThemeCss}
    body { display: flex; flex-direction: column; gap: 16px; }
    #app { display: flex; flex-direction: column; gap: 16px; }

    .app-header { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
    .brand { min-width: 0; }
    .brand-row { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
    .brand-title { margin: 0; font-size: 18px; font-weight: 600; }
    .brand-hint { margin: 4px 0 0; font-size: 12px; color: var(--cc-muted); }
    .brand-hint strong { color: var(--cc-fg); font-weight: 600; }
    .generated { font-family: var(--cc-mono); font-size: 11px; color: var(--cc-dim); font-variant-numeric: tabular-nums; }
    .app-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

    .kpis {
      display: grid; grid-template-columns: repeat(5, minmax(0, 1fr));
      background: var(--cc-surface); border: 1px solid var(--cc-border);
      border-radius: var(--cc-radius-lg); overflow: hidden;
    }
    .kpi {
      position: relative; display: flex; flex-direction: column; gap: 2px;
      text-align: left; line-height: 1.4; padding: 12px 16px;
      color: var(--cc-fg); background: transparent; border: 0;
      border-left: 1px solid var(--cc-border); border-radius: 0;
      min-height: 0; cursor: pointer;
      transition: background-color .12s var(--cc-ease);
    }
    .kpi:first-child { border-left: 0; }
    .kpi:hover { background: var(--cc-surface-hover); }
    .kpi.static { cursor: default; }
    .kpi.static:hover { background: transparent; }
    .kpi.active { background: var(--cc-surface-strong); }
    .kpi.active::after {
      content: ""; position: absolute; left: 0; right: 0; bottom: 0;
      height: 2px; background: var(--cc-accent);
    }
    .kpi .n { font-size: 20px; font-weight: 600; line-height: 1.2; font-variant-numeric: tabular-nums; }
    .kpi .k { font-size: 11px; font-weight: 500; color: var(--cc-muted); }
    .kpi .s { font-size: 11px; color: var(--cc-dim); }
    .kpi.alert .n { color: var(--cc-accent); }

    .section { padding-top: 16px; border-top: 1px solid var(--cc-border); }
    .section-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
    .section-title { margin: 0; font-size: 12px; font-weight: 600; }
    .section-hint { font-size: 11px; color: var(--cc-dim); }
    .notice {
      padding: 14px; font-size: 12px; color: var(--cc-muted);
      background: var(--cc-surface); border: 1px solid var(--cc-border);
      border-radius: var(--cc-radius);
    }

    .spec-table {
      width: 100%; border-collapse: collapse; table-layout: auto;
      background: var(--cc-surface); border: 1px solid var(--cc-border);
      border-radius: var(--cc-radius-lg); overflow: hidden;
    }
    .spec-table th, .spec-table td { padding: 10px 12px; text-align: left; vertical-align: top; }
    .spec-table th {
      font-size: 11px; font-weight: 600; color: var(--cc-muted);
      background: var(--cc-surface-strong); border-bottom: 1px solid var(--cc-border);
      white-space: nowrap;
    }
    .spec-table td { border-top: 1px solid var(--cc-border); font-size: 12px; }
    .spec-table tbody tr:first-child td { border-top: 0; }
    .spec-table tbody tr { cursor: pointer; }
    .spec-table tbody tr:hover { background: var(--cc-surface-hover); }
    .spec-table tbody tr.selected { background: var(--cc-surface-strong); }
    .spec-table tbody tr:focus-visible { outline: 2px solid var(--cc-accent); outline-offset: -2px; }
    .spec-cell { min-width: 180px; }
    .spec-name { display: block; font-size: 13px; font-weight: 600; }
    .spec-id { display: block; font-family: var(--cc-mono); font-size: 11px; color: var(--cc-dim); margin-top: 2px; }
    .stage {
      display: inline-flex; align-items: center; padding: 1px 7px;
      font-family: var(--cc-mono); font-size: 11px; color: var(--cc-muted);
      border: 1px solid var(--cc-border-strong); border-radius: 999px;
      white-space: nowrap;
    }
    .tasks { font-family: var(--cc-mono); font-size: 11px; color: var(--cc-muted); font-variant-numeric: tabular-nums; }
    .bar { height: 3px; margin-top: 5px; border-radius: 2px; background: var(--cc-surface-strong); overflow: hidden; }
    .bar span { display: block; height: 100%; background: var(--cc-success); border-radius: 2px; }
    .status-primary { display: block; }
    .status-detail { display: block; margin-top: 2px; font-size: 11px; color: var(--cc-dim); }
    .status-blocked { color: var(--cc-error-ink); }
    .status-failed { color: var(--cc-error-ink); }
    .status-input { color: var(--cc-warn-ink); }
    .status-running { color: var(--cc-warn-ink); }
    .status-verification { color: var(--cc-warn-ink); }
    .updated { font-family: var(--cc-mono); font-size: 11px; color: var(--cc-muted); white-space: nowrap; }
    .run-button {
      padding: 2px 8px; font-size: 11px; color: var(--cc-fg);
      background: var(--cc-surface-strong); border: 1px solid var(--cc-border-strong);
      border-radius: var(--cc-radius-sm); cursor: pointer;
    }
    .run-button:hover { background: var(--cc-surface-hover); }

    .dep-list, .event-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
    .dep, .event {
      display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
      padding: 8px 10px; font-size: 12px;
      background: var(--cc-surface); border: 1px solid var(--cc-border);
      border-radius: var(--cc-radius);
    }
    .event { cursor: pointer; }
    .event:hover { background: var(--cc-surface-hover); }
    .event:focus-visible { outline: 2px solid var(--cc-accent); outline-offset: -2px; }
    .dep-tag, .scope-tag {
      font-family: var(--cc-mono); font-size: 10px; text-transform: uppercase;
      letter-spacing: .04em; color: var(--cc-muted); white-space: nowrap;
    }
    .dep-waiting .dep-tag { color: var(--cc-warn-ink); }
    .dep-ready .dep-tag { color: var(--cc-success-ink); }
    .dep-revalidation .dep-tag { color: var(--cc-warn-ink); }
    .dep-spec, .event-spec { font-weight: 600; }
    .dep-text, .event-text { color: var(--cc-muted); }
    .event-time { margin-left: auto; font-family: var(--cc-mono); font-size: 11px; color: var(--cc-dim); white-space: nowrap; }
    .event-run { margin-left: 4px; }
    .link {
      padding: 0; color: inherit; background: transparent; border: 0;
      font: inherit; font-weight: 600; cursor: pointer;
    }
    .link:hover { text-decoration: underline; }
    .muted { color: var(--cc-dim); }

    .completed-head {
      display: flex; align-items: center; gap: 8px; width: 100%;
      padding: 8px 0; text-align: left; color: var(--cc-fg);
      background: transparent; border: 0; cursor: pointer;
    }
    .completed-head:hover .section-title { text-decoration: underline; }
    .completed-count { font-family: var(--cc-mono); font-size: 11px; color: var(--cc-dim); }
    .chevron { margin-left: auto; color: var(--cc-dim); }

    .empty-state {
      padding: 24px; background: var(--cc-surface);
      border: 1px solid var(--cc-border); border-radius: var(--cc-radius-lg);
    }
    .empty-title { margin: 0; font-size: 14px; font-weight: 600; }
    .empty-body { margin: 4px 0 0; max-width: 56ch; font-size: 12px; color: var(--cc-muted); }
    .empty { color: var(--cc-muted); font-size: 12px; padding: 16px 0; }
    .error {
      padding: 12px 14px; font-size: 12px; color: var(--cc-error-ink);
      border: 1px solid color-mix(in srgb, var(--cc-error) 40%, transparent);
      border-radius: var(--cc-radius);
    }

    @media (max-width: 900px) {
      .kpis { grid-template-columns: repeat(6, minmax(0, 1fr)); }
      .kpi { grid-column: span 2; }
      .kpi:nth-child(3n + 1) { border-left: 0; }
      .kpi:nth-child(n + 4) { grid-column: span 3; border-top: 1px solid var(--cc-border); }
      .app-actions { margin-left: 0; width: 100%; justify-content: flex-end; }
    }
    @media (max-width: 760px) {
      .spec-table thead { display: none; }
      .spec-table, .spec-table tbody, .spec-table tr, .spec-table td { display: block; width: 100%; }
      .spec-table tr { padding: 12px 14px; border-top: 1px solid var(--cc-border); }
      .spec-table tbody tr:first-child { border-top: 0; }
      .spec-table td { border: 0; padding: 2px 0; }
      .spec-table td[data-label]::before {
        content: attr(data-label) ": "; color: var(--cc-dim);
        font-family: var(--cc-mono); font-size: 11px;
      }
      .spec-table td.spec-cell::before { display: none; }
      .updated { white-space: normal; }
    }
    @media (max-width: 700px) {
      body { padding: 16px; }
    }
    @media (max-width: 560px) {
      .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .kpi { grid-column: auto; border-top: 0; border-left: 1px solid var(--cc-border); }
      .kpi:nth-child(odd) { border-left: 0; }
      .kpi:nth-child(n + 3) { border-top: 1px solid var(--cc-border); }
      .kpi:last-child { grid-column: 1 / -1; border-left: 0; }
    }

  </style>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
    const timeAgo = (timestamp) => {
      if (!timestamp) return '';
      const diff = Date.now() - timestamp;
      if (!isFinite(diff) || diff < 0) return 'just now';
      if (diff < 60000) return Math.max(1, Math.floor(diff / 1000)) + 's ago';
      if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
      if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
      return Math.floor(diff / 86400000) + 'd ago';
    };
    const fmtAbsolute = (timestamp) => {
      if (!timestamp || !isFinite(timestamp)) return '';
      return new Date(timestamp).toLocaleString();
    };

    const STAGE_LABELS = {
      requirements: 'Requirements',
      design: 'Design',
      tasks: 'Tasks',
      implementation: 'Implementation',
      verification: 'Verification',
      done: 'Done',
      unknown: 'Unknown',
    };
    const FILTER_LABELS = {
      all: 'all',
      'in-progress': 'in progress',
      blocked: 'blocked',
      review: 'review pending',
      verification: 'verification pending',
      done: 'completed',
    };
    const refreshIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.2 8.2a5.2 5.2 0 1 1-1.5-3.7"/><path d="M13.2 2.8v3.1h-3.1"/></svg>';

    let model = null;
    let activeFilter = 'all';
    let completedOpen = false;
    let eventsExpanded = false;
    let selectedSpecId = null;
    let lastError = '';

    function post(type, extra) {
      vscode.postMessage(Object.assign({ type: type }, extra || {}));
    }

    function matchesFilter(spec) {
      if (activeFilter === 'blocked') return Boolean(spec.blockedReason);
      if (activeFilter === 'review') return spec.reviewPhases.length > 0;
      if (activeFilter === 'verification') return spec.implementationComplete && !spec.completed;
      if (activeFilter === 'done') return false;
      return true;
    }

    function statusClass(spec) {
      if (spec.error) return 'status-failed';
      if (spec.blockedReason) return 'status-blocked';
      if (spec.runState === 'input' || spec.dependencyUnknown.length > 0) return 'status-input';
      if (spec.runState === 'running') return 'status-running';
      if (spec.runState === 'failed' || (spec.implementationComplete && spec.verification.status === 'failed')) {
        return 'status-failed';
      }
      if (
        spec.implementationComplete &&
        (spec.verification.status === 'stale' ||
          spec.verification.status === 'manual' ||
          spec.verification.status === 'unconfirmed' ||
          spec.verification.status === 'error' ||
          spec.stage === 'verification')
      ) {
        return 'status-verification';
      }
      return '';
    }

    function verificationLabel(spec) {
      const verification = spec.verification || { status: 'none' };
      if (verification.status === 'verified') return 'GO';
      if (verification.status === 'failed') return verification.decision || 'NO-GO';
      if (verification.status === 'manual') return verification.decision || 'MANUAL';
      if (verification.status === 'stale') {
        return (verification.decision || 'Result') + ' · stale';
      }
      if (verification.status === 'unconfirmed') return 'Recorded · unconfirmed';
      if (verification.status === 'error') return 'Unavailable';
      return 'No result';
    }

    function verificationTitle(spec) {
      const verification = spec.verification || {};
      const parts = [];
      if (verification.status) parts.push('Status: ' + verification.status);
      if (verification.decision) parts.push('Decision: ' + verification.decision);
      if (verification.at) parts.push('Recorded: ' + fmtAbsolute(verification.at));
      if (verification.path) parts.push(verification.path);
      if (verification.detail) parts.push(verification.detail);
      return parts.join('\\n');
    }

    function renderKpis() {
      const kpi = model.kpi;
      const items = [
        {
          key: 'in-progress',
          n: kpi.inProgress,
          k: 'In progress',
          s: kpi.blocked + ' blocked · ' + kpi.verificationPending + ' verification',
        },
        {
          key: 'blocked',
          n: kpi.blocked,
          k: 'Blocked',
          s: kpi.blockedExplicit + ' explicit · ' + kpi.blockedDependency + ' dependency',
          alert: kpi.blocked > 0,
        },
        {
          key: 'review',
          n: kpi.reviewPending,
          k: 'Review pending',
          s: kpi.reviews + ' approval' + (kpi.reviews === 1 ? '' : 's') + ' waiting',
        },
        {
          key: 'verification',
          n: kpi.verificationPending,
          k: 'Verification pending',
          s: kpi.verificationFailed
            ? kpi.verificationFailed + ' failed'
            : 'awaiting result',
          alert: kpi.verificationFailed > 0,
        },
        {
          key: 'done',
          n: kpi.done,
          k: 'Done',
          s: 'verified',
        },
      ];
      return '<div class="kpis" role="group" aria-label="Project overview">' + items.map(function (item) {
        const active = activeFilter === item.key ? ' active' : '';
        const pressed = ' aria-pressed="' + (activeFilter === item.key ? 'true' : 'false') + '"';
        const classes = 'kpi' + (item.alert ? ' alert' : '') + active;
        return '<button class="' + classes + '" data-kpi="' + item.key + '"' + pressed + '>' +
          '<span class="n">' + esc(item.n) + '</span>' +
          '<span class="k">' + esc(item.k) + '</span>' +
          '<span class="s">' + esc(item.s) + '</span></button>';
      }).join('') + '</div>';
    }

    function renderSpecRow(spec) {
      const pct = spec.tasksTotal > 0 ? Math.round((spec.tasksDone / spec.tasksTotal) * 100) : 0;
      const tasks = spec.tasksTotal > 0
        ? '<span class="tasks">' + spec.tasksDone + '/' + spec.tasksTotal + '</span>' +
          '<span class="bar"><span style="width:' + pct + '%"></span></span>'
        : '<span class="muted" title="No tasks recorded">—</span>';
      const updated = spec.updatedAt
        ? '<span title="Last updated: ' + esc(fmtAbsolute(spec.updatedAt)) + '">' + esc(timeAgo(spec.updatedAt)) + '</span>'
        : '<span class="muted">No timestamp</span>';
      const detail = spec.statusDetail
        ? '<span class="status-detail">' + esc(spec.statusDetail) + '</span>'
        : '';
      const statusTitle = spec.implementationComplete ? verificationTitle(spec) : '';
      const runButton = spec.runs.length > 1
        ? '<button class="run-button" data-act="open-runs" title="Open the Runs console">Runs</button>'
        : spec.latestRunId
          ? '<button class="run-button" data-run-id="' + esc(spec.latestRunId) + '" title="Open local run">Run</button>'
          : '';
      let html = '<tr data-spec-id="' + esc(spec.id) + '" tabindex="0" title="Open ' + esc(spec.label) + '"' +
        (selectedSpecId === spec.id ? ' class="selected"' : '') + '>';
      html += '<td class="spec-cell"><span class="spec-name">' + esc(spec.label) + '</span>' +
        (spec.label === spec.id ? '' : '<span class="spec-id">' + esc(spec.id) + '</span>') + '</td>';
      html += '<td data-label="Stage"><span class="stage">' + esc(STAGE_LABELS[spec.stage] || spec.stage) + '</span></td>';
      html += '<td data-label="Tasks">' + tasks + '</td>';
      html += '<td data-label="Current status"' +
        (statusTitle ? ' title="' + esc(statusTitle) + '"' : '') + '><span class="status-primary ' + statusClass(spec) + '">' +
        esc(spec.status) + '</span>' + detail + '</td>';
      html += '<td data-label="Updated"><span class="updated">' + updated + '</span></td>';
      html += '<td data-label="Action">' + runButton + '</td>';
      html += '</tr>';
      return html;
    }

    function renderInProgress() {
      const specs = model.specs.filter(function (spec) {
        return !spec.completed && matchesFilter(spec);
      });
      const hint = model.kpi.inProgress + ' in progress · ' +
        model.kpi.tasksDone + '/' + model.kpi.tasksTotal + ' tasks done (reference)';
      let html = '<section class="section"><div class="section-head">' +
        '<h2 class="section-title">In-progress specs</h2>' +
        '<span class="section-hint">' + esc(hint) + '</span></div>';
      if (activeFilter === 'done') {
        html += '<div class="notice">Completed specs are shown below.</div></section>';
        return html;
      }
      if (!specs.length) {
        html += '<div class="notice">No in-progress specs match this filter.</div></section>';
        return html;
      }
      html += '<table class="spec-table"><thead><tr>' +
        '<th>Spec</th><th>Stage</th><th>Tasks</th><th>Current status</th><th>Updated</th><th>Action</th>' +
        '</tr></thead><tbody>' + specs.map(renderSpecRow).join('') + '</tbody></table></section>';
      return html;
    }

    function renderDependencies() {
      let html = '<section class="section"><div class="section-head">' +
        '<h2 class="section-title">Dependencies & candidates</h2>' +
        '<span class="section-hint">explicit records only</span></div>';
      if (model.dependencyInfo === 'none') {
        html += '<div class="notice">No dependency information (roadmap.md not found or empty).</div></section>';
        return html;
      }
      if (!model.dependencies.length) {
        html += '<div class="notice">No dependency candidates recorded.</div></section>';
        return html;
      }
      html += '<ul class="dep-list">' + model.dependencies.map(function (item) {
        return '<li class="dep dep-' + esc(item.kind) + '">' +
          '<span class="dep-tag">' + esc(item.kind) + '</span>' +
          '<button class="link" data-spec-id="' + esc(item.specId) + '">' + esc(item.specLabel) + '</button>' +
          '<span class="dep-text">' + esc(item.text) + '</span></li>';
      }).join('') + '</ul></section>';
      return html;
    }

    function renderEvents() {
      const events = model.events;
      let html = '<section class="section"><div class="section-head">' +
        '<h2 class="section-title">Recent updates</h2>' +
        '<span class="section-hint">recorded updates and local run events</span></div>';
      if (!events.length) {
        html += '<div class="notice">No recorded events.</div></section>';
        return html;
      }
      const visible = eventsExpanded ? events : events.slice(0, 10);
      html += '<ul class="event-list">' + visible.map(function (event) {
        const runButton = event.runId
          ? '<button class="run-button event-run" data-run-id="' + esc(event.runId) + '" title="Open local run">Run</button>'
          : '';
        const scope = event.scope === 'local'
          ? '<span class="scope-tag">local</span>'
          : '';
        const attrs = event.specId
          ? ' data-spec-id="' + esc(event.specId) + '" tabindex="0" role="button"'
          : '';
        return '<li class="event"' + attrs + '>' +
          '<span class="event-spec">' + esc(event.specLabel || '') + '</span>' +
          scope +
          '<span class="event-text">' + esc(event.text) + '</span>' +
          runButton +
          '<span class="event-time">' + esc(timeAgo(event.at)) + '</span></li>';
      }).join('') + '</ul>';
      if (events.length > 10) {
        html += '<button class="text-button" data-act="toggle-events">' +
          (eventsExpanded ? 'Show less' : 'Show all ' + events.length) + '</button>';
      }
      html += '</section>';
      return html;
    }

    function renderCompleted() {
      const completed = model.specs.filter(function (spec) { return spec.completed; });
      const open = completedOpen || activeFilter === 'done';
      let html = '<section class="section"><button class="completed-head" data-act="toggle-completed" ' +
        'aria-expanded="' + (open ? 'true' : 'false') + '">' +
        '<span class="section-title">Completed specs</span>' +
        '<span class="completed-count">' + completed.length + '</span>' +
        '<span class="chevron">' + (open ? '▾' : '▸') + '</span></button>';
      if (!open) {
        return html + '</section>';
      }
      if (!completed.length) {
        return html + '<div class="notice">No verified specs yet.</div></section>';
      }
      html += '<table class="spec-table"><thead><tr>' +
        '<th>Spec</th><th>Verification</th><th>Completed</th><th>Action</th>' +
        '</tr></thead><tbody>' + completed.map(function (spec) {
          const stamp = spec.completedAt || spec.updatedAt;
          const updated = stamp
            ? '<span title="' + esc(fmtAbsolute(stamp)) + '">' + esc(timeAgo(stamp)) + '</span>'
            : '<span class="muted">No timestamp</span>';
          return '<tr data-spec-id="' + esc(spec.id) + '" tabindex="0" title="Open ' + esc(spec.label) + '"' +
            (selectedSpecId === spec.id ? ' class="selected"' : '') + '>' +
            '<td class="spec-cell"><span class="spec-name">' + esc(spec.label) + '</span>' +
            (spec.label === spec.id ? '' : '<span class="spec-id">' + esc(spec.id) + '</span>') + '</td>' +
            '<td data-label="Verification" title="' + esc(verificationTitle(spec)) + '">' + esc(verificationLabel(spec)) + '</td>' +
            '<td data-label="Completed"><span class="updated">' + updated + '</span></td>' +
            '<td data-label="Action"><span class="muted">Verified</span></td>' +
            '</tr>';
        }).join('') + '</tbody></table></section>';
      return html;
    }

    function render() {
      const app = document.getElementById('app');
      if (!model) {
        app.innerHTML = lastError
          ? '<div class="error" role="alert">' + esc(lastError) + '</div>'
          : '<div class="empty">Loading overview…</div>';
        return;
      }
      const scrollY = window.scrollY;
      const filterHint = activeFilter === 'all'
        ? ''
        : ' · filter: ' + FILTER_LABELS[activeFilter];

      let html = '<header class="app-header"><div class="brand"><div class="brand-row">' +
        '<h1 class="brand-title">cc-sdd Overview</h1>' +
        '<span class="generated" data-generated="' + model.generatedAt + '">Updated ' +
        esc(timeAgo(model.generatedAt)) + '</span></div>' +
        '<p class="brand-hint"><strong>' + esc(model.projectName) + '</strong>' +
        ' · Specs: this workspace · Run state: records visible in this VS Code window' +
        esc(filterHint) + '</p>' +
        '</div><div class="app-actions">';
      html += '<button class="icon-button" data-act="refresh" title="Refresh" aria-label="Refresh">' +
        refreshIcon + '</button>';
      if (activeFilter !== 'all') {
        html += '<button class="text-button" data-act="clear-filter">Show all</button>';
      }
      html += '</div></header>';

      if (lastError) {
        html += '<div class="error" role="alert">' + esc(lastError) + '</div>';
      }

      if (!model.specs.length) {
        html += '<div class="empty-state"><p class="empty-title">No specs found in .kiro/specs</p>' +
          '<p class="empty-body">Create a spec from the Specs view or run /kiro-discovery.</p></div>';
      } else {
        html += renderKpis();
        html += renderInProgress();
        html += renderDependencies();
        html += renderEvents();
        html += renderCompleted();
      }

      app.innerHTML = html;
      window.scrollTo(0, scrollY);
    }

    let timer = null;
    function startTimer() {
      if (timer) clearInterval(timer);
      timer = setInterval(function () {
        document.querySelectorAll('[data-generated]').forEach(function (element) {
          element.textContent = 'Updated ' +
            timeAgo(Number(element.getAttribute('data-generated')));
        });
      }, 1000);
    }

    function openSpec(target) {
      const spec = target.closest('[data-spec-id]');
      if (spec) {
        selectedSpecId = spec.getAttribute('data-spec-id');
        render();
        post('openSpec', { specId: selectedSpecId });
        return true;
      }
      return false;
    }

    document.getElementById('app').addEventListener('click', function (event) {
      const run = event.target.closest('[data-run-id]');
      if (run) {
        event.stopPropagation();
        post('openRun', { runId: run.getAttribute('data-run-id') });
        return;
      }

      const kpi = event.target.closest('[data-kpi]');
      if (kpi) {
        const key = kpi.getAttribute('data-kpi');
        activeFilter = activeFilter === key ? 'all' : key;
        if (key === 'done' && activeFilter === 'done') completedOpen = true;
        render();
        return;
      }

      const action = event.target.closest('[data-act]');
      if (action) {
        const act = action.getAttribute('data-act');
        if (act === 'refresh') {
          post('refresh');
        } else if (act === 'clear-filter') {
          activeFilter = 'all';
          render();
        } else if (act === 'toggle-completed') {
          completedOpen = !completedOpen;
          render();
        } else if (act === 'toggle-events') {
          eventsExpanded = !eventsExpanded;
          render();
        } else if (act === 'open-runs') {
          post('openRuns');
        }
        return;
      }

      openSpec(event.target);
    });

    document.getElementById('app').addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.target.closest('button')) return;
      const target = event.target.closest('[data-spec-id]');
      if (target) {
        event.preventDefault();
        openSpec(target);
      }
    });

    window.addEventListener('message', function (event) {
      const data = event.data;
      if (!data) return;
      if (data.type === 'state') {
        lastError = '';
        model = data.model;
        render();
        startTimer();
      } else if (data.type === 'error') {
        lastError = data.message || 'Could not load the overview.';
        render();
      }
    });

    post('ready');
  </script>
</body>
</html>`;
  }
}
