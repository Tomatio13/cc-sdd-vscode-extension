// "cc-sdd Overview": a leader / PM board over live runs, recent sessions, and
// spec progress. Runs are authoritative for this window; sessions reveal work
// happening in other windows or terminals.
import * as vscode from 'vscode';
import type { OverviewModel } from '../core/overview';
import { webviewThemeCss } from './webviewTheme';

export interface OverviewPanelOptions {
  load: () => Promise<OverviewModel>;
  openRun: (runId: string) => void;
  previewSession: (sessionId: string) => Promise<void>;
  openSpec: (specId: string) => Promise<void>;
  openArtifact: (specId: string, phase: string) => Promise<void>;
  openRuns: () => void;
  runDiscovery: () => Promise<void>;
}

interface OverviewMessage {
  type: string;
  runId?: string;
  sessionId?: string;
  specId?: string;
  phase?: string;
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

  /** Coalesces run streaming events and file watcher bursts. */
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
      case 'openRun':
        if (typeof typed.runId === 'string') {
          this.options.openRun(typed.runId);
        }
        return;
      case 'previewSession':
        if (typeof typed.sessionId === 'string') {
          await this.options.previewSession(typed.sessionId);
        }
        return;
      case 'openSpec':
        if (typeof typed.specId === 'string') {
          await this.options.openSpec(typed.specId);
        }
        return;
      case 'openArtifact':
        if (typeof typed.specId === 'string' && typeof typed.phase === 'string') {
          await this.options.openArtifact(typed.specId, typed.phase);
        }
        return;
      case 'openRuns':
        this.options.openRuns();
        return;
      case 'runDiscovery':
        await this.options.runDiscovery();
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
    .brand { min-width: 200px; }
    .brand-row { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
    .brand-title { margin: 0; font-size: 14px; font-weight: 600; }
    .brand-hint { margin: 2px 0 0; font-size: 12px; color: var(--cc-muted); }
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
    .kpi.failed.alert .n { color: var(--cc-error); }

    .board { display: grid; grid-template-columns: 1.15fr 1.15fr .85fr .85fr; gap: 20px; align-items: stretch; }
    .column { display: flex; flex-direction: column; min-width: 0; transition: opacity .12s var(--cc-ease); }
    .column.dim { opacity: .45; }
    .column-head {
      display: flex; align-items: center; gap: 8px; flex: none;
      padding: 0 2px 8px; border-bottom: 1px solid var(--cc-border);
    }
    .column-title { margin: 0; font-size: 12px; font-weight: 600; }
    .column-count {
      margin-left: auto; font-family: var(--cc-mono); font-size: 11px;
      color: var(--cc-muted); font-variant-numeric: tabular-nums;
    }
    .column-body {
      display: flex; flex-direction: column; gap: 8px; flex: 1 1 auto;
      min-height: 132px; padding-top: 8px; max-height: 46vh; overflow-y: auto;
    }
    .column-empty { margin: auto 0; padding: 8px 2px; font-size: 12px; color: var(--cc-dim); }
    .lamp.review { background: var(--cc-warn); }

    .card {
      display: flex; flex-direction: column; gap: 6px; width: 100%;
      text-align: left; padding: 12px; color: var(--cc-fg); line-height: 1.4;
      background: var(--cc-card); border: 1px solid var(--cc-border);
      border-radius: var(--cc-radius); cursor: pointer;
      transition: background-color .12s var(--cc-ease), border-color .12s var(--cc-ease);
    }
    .card:hover { background: var(--cc-surface); border-color: var(--cc-border-strong); }
    .card.tone-cancelled .card-feature { color: var(--cc-muted); }
    .card-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .card-feature { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card-elapsed {
      margin-left: auto; font-family: var(--cc-mono); font-size: 11px;
      color: var(--cc-muted); font-variant-numeric: tabular-nums; flex: none;
    }
    .card-skill {
      font-family: var(--cc-mono); font-size: 11px; color: var(--cc-muted);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .card-label { font-size: 11px; font-weight: 500; color: var(--cc-muted); }
    .tone-attention .card-label { color: var(--cc-accent-ink); }
    .tone-failed .card-label { color: var(--cc-error-ink); }
    .card-detail {
      font-size: 12px; line-height: 1.45; color: var(--cc-fg); opacity: .86;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      overflow: hidden; word-break: break-word;
    }
    .card-meta {
      display: flex; flex-wrap: wrap; align-items: center;
      font-family: var(--cc-mono); font-size: 11px; color: var(--cc-muted);
      font-variant-numeric: tabular-nums;
    }
    .card-meta > span + span::before { content: "·"; padding: 0 6px; color: var(--cc-border-strong); }
    .card-meta .session { color: var(--cc-accent-ink); }

    .portfolio { padding-top: 16px; border-top: 1px solid var(--cc-border); }
    .section-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
    .section-title { margin: 0; font-size: 12px; font-weight: 600; }
    .section-hint { font-size: 11px; color: var(--cc-dim); }
    .spec-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
    .spec-card {
      display: flex; flex-direction: column; gap: 10px; width: 100%;
      text-align: left; padding: 12px 14px; color: var(--cc-fg); line-height: 1.4;
      background: var(--cc-surface); border: 1px solid var(--cc-border);
      border-radius: var(--cc-radius); cursor: pointer;
      transition: background-color .12s var(--cc-ease), border-color .12s var(--cc-ease);
    }
    .spec-card:hover { background: var(--cc-surface-strong); border-color: var(--cc-border-strong); }
    .spec-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .spec-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .spec-phase { margin-left: auto; font-family: var(--cc-mono); font-size: 11px; color: var(--cc-muted); flex: none; }
    .approvals { display: flex; flex-wrap: wrap; gap: 12px; font-size: 11px; color: var(--cc-muted); }
    .approval { display: inline-flex; align-items: center; gap: 4px; }
    .approval em { font-style: normal; font-family: var(--cc-mono); }
    .approval.approved { color: var(--cc-success-ink); }
    .approval.generated { color: var(--cc-warn-ink); }
    .approval.missing { color: var(--cc-dim); }
    .bar { height: 3px; border-radius: 2px; background: var(--cc-surface-strong); overflow: hidden; }
    .bar span { display: block; height: 100%; background: var(--cc-success); border-radius: 2px; }
    .spec-meta {
      display: flex; flex-wrap: wrap; align-items: center;
      font-family: var(--cc-mono); font-size: 11px; color: var(--cc-muted);
      font-variant-numeric: tabular-nums;
    }
    .spec-meta > span + span::before { content: "·"; padding: 0 6px; color: var(--cc-border-strong); }
    .spec-meta .attention { color: var(--cc-accent-ink); }
    .spec-meta .running { color: var(--cc-warn-ink); }
    .spec-meta .ready { color: var(--cc-success-ink); }
    .spec-meta .review { color: var(--cc-warn-ink); }
    .spec-next { font-size: 11px; color: var(--cc-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .spec-next .next-label { color: var(--cc-dim); }

    .empty-state {
      padding: 24px; background: var(--cc-surface);
      border: 1px solid var(--cc-border); border-radius: var(--cc-radius-lg);
    }
    .empty-title { margin: 0; font-size: 14px; font-weight: 600; }
    .empty-body { margin: 4px 0 16px; max-width: 56ch; font-size: 12px; color: var(--cc-muted); }
    .empty-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .empty { color: var(--cc-muted); font-size: 12px; padding: 16px 0; }
    .error {
      padding: 12px 14px; font-size: 12px; color: var(--cc-error-ink);
      border: 1px solid color-mix(in srgb, var(--cc-error) 40%, transparent);
      border-radius: var(--cc-radius);
    }

    @media (max-width: 900px) {
      .board { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px 20px; }
      .kpis { grid-template-columns: repeat(6, minmax(0, 1fr)); }
      .kpi { grid-column: span 2; }
      .kpi:nth-child(3n + 1) { border-left: 0; }
      .kpi:nth-child(n + 4) { grid-column: span 3; border-top: 1px solid var(--cc-border); }
      .app-actions { margin-left: 0; width: 100%; justify-content: flex-end; }
    }
    @media (max-width: 700px) {
      body { padding: 16px; }
    }
    @media (max-width: 560px) {
      .board { grid-template-columns: 1fr; }
      .column-body { max-height: none; }
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
    const fmtDuration = (ms) => {
      if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '';
      if (ms < 1000) return Math.round(ms) + 'ms';
      const s = ms / 1000;
      if (s < 60) return s.toFixed(1) + 's';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm' + Math.round(s % 60) + 's';
      return Math.floor(m / 60) + 'h' + (m % 60) + 'm';
    };
    const fmtTokens = (value) => {
      const n = Number(value) || 0;
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
      return String(Math.round(n));
    };
    const fmtCost = (value) => {
      if (typeof value !== 'number' || !isFinite(value)) return '';
      if (value > 0 && value < 0.01) return '<$0.01';
      return '$' + value.toFixed(2);
    };
    const timeAgo = (timestamp) => {
      if (!timestamp) return '';
      const diff = Date.now() - timestamp;
      if (!isFinite(diff) || diff < 0) return 'just now';
      if (diff < 60000) return Math.max(1, Math.floor(diff / 1000)) + 's ago';
      if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
      if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
      return Math.floor(diff / 86400000) + 'd ago';
    };

    const COLUMNS = [
      { key: 'attention', label: 'Needs you', empty: 'Nothing waiting' },
      { key: 'running', label: 'Running', empty: 'Nothing running' },
      { key: 'done', label: 'Done', empty: 'Nothing finished today' },
      { key: 'failed', label: 'Failed', empty: 'No failures' },
    ];
    const APPROVALS = ['requirements', 'design', 'tasks'];
    const refreshIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.2 8.2a5.2 5.2 0 1 1-1.5-3.7"/><path d="M13.2 2.8v3.1h-3.1"/></svg>';
    const consoleIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5 6.8 8 3 11.5"/><path d="M8.4 11.5h4.6"/></svg>';

    let model = null;
    let columnFilter = null;
    let lastError = '';

    function cardElapsed(card) {
      if (card.column === 'running' || card.column === 'attention') {
        return '<span class="card-elapsed elapsed" data-start="' + card.startedAt + '"></span>';
      }
      if (card.endedAt) {
        return '<span class="card-elapsed">' + esc(fmtDuration(card.endedAt - card.startedAt)) + '</span>';
      }
      return '<span class="card-elapsed">' + esc(timeAgo(card.updatedAt)) + '</span>';
    }

    function renderCard(card) {
      const attrs = card.runId
        ? ' data-run-id="' + esc(card.runId) + '"'
        : (card.source === 'review'
          ? ' data-review-spec="' + esc(card.specId) + '" data-review-phase="' + esc(card.reviewPhase) + '"'
          : ' data-session-id="' + esc(card.sessionId) + '"');
      const action = card.runId ? 'Open run' : (card.source === 'review' ? 'Open artifact' : 'Preview session');
      const showLabel = card.source === 'review' || card.source === 'session' || card.column === 'attention';
      let html = '<button class="card tone-' + esc(card.tone) + '"' + attrs +
        ' title="' + action + ': ' + esc(card.feature) + '">';
      html += '<span class="card-top"><span class="lamp ' + esc(card.tone) + '"></span>' +
        '<span class="card-feature">' + esc(card.feature) + '</span>' +
        cardElapsed(card) + '</span>';
      html += '<span class="card-skill">' +
        (card.source === 'review' ? 'spec approval' : '/' + esc(card.skill)) + '</span>';
      if (showLabel && card.label) {
        html += '<span class="card-label">' + esc(card.label) + '</span>';
      }
      if (card.detail) {
        html += '<span class="card-detail">' + esc(card.detail) + '</span>';
      }
      const meta = [];
      if (card.source === 'session') meta.push('<span class="session">session</span>');
      if (card.permissionMode) meta.push('<span>' + esc(card.permissionMode) + '</span>');
      if (card.tokens) meta.push('<span>' + esc(fmtTokens(card.tokens)) + ' tokens</span>');
      if (typeof card.costUsd === 'number') meta.push('<span>' + esc(fmtCost(card.costUsd)) + '</span>');
      if (meta.length) html += '<span class="card-meta">' + meta.join('') + '</span>';
      html += '</button>';
      return html;
    }

    function renderBoard() {
      let html = '<div class="board">';
      COLUMNS.forEach(function (column) {
        const cards = model.columns[column.key] || [];
        const dimmed = columnFilter && columnFilter !== column.key;
        const lamp = cards.length ? column.key : 'off';
        html += '<section class="column ' + column.key + (dimmed ? ' dim' : '') + '">';
        html += '<div class="column-head"><span class="lamp ' + lamp + '"></span>' +
          '<h2 class="column-title">' + esc(column.label) + '</h2>' +
          '<span class="column-count">' + cards.length + '</span></div>';
        html += '<div class="column-body" data-scroll="' + column.key + '">';
        if (!cards.length) {
          html += '<div class="column-empty">' + esc(column.empty) + '</div>';
        } else {
          html += cards.map(renderCard).join('');
        }
        html += '</div></section>';
      });
      html += '</div>';
      return html;
    }

    function specBadges(spec) {
      const badges = [];
      if (spec.attention > 0) badges.push('<span class="attention">' + spec.attention + ' needs you</span>');
      if (spec.active > 0) badges.push('<span class="running">' + spec.active + ' running</span>');
      if (spec.reviewPhases.length) {
        badges.push('<span class="review">review: ' + esc(spec.reviewPhases.join(', ')) + '</span>');
      }
      if (spec.ready) badges.push('<span class="ready">ready</span>');
      return badges.join('');
    }

    function specState(spec) {
      if (spec.error) return 'failed';
      if (spec.attention > 0) return 'attention';
      if (spec.active > 0) return 'running';
      if (spec.reviewPhases.length) return 'review';
      if (spec.ready) return 'done';
      return 'off';
    }

    function renderSpec(spec) {
      const pct = spec.tasksTotal > 0 ? Math.round((spec.tasksDone / spec.tasksTotal) * 100) : 0;
      let html = '<button class="spec-card" data-spec-id="' + esc(spec.id) +
        '" title="' + esc(spec.label) + ' — ' + esc(spec.tasksPath) + '">';
      html += '<span class="spec-head"><span class="lamp ' + specState(spec) + '"></span>' +
        '<span class="spec-name">' + esc(spec.label) + '</span>' +
        '<span class="spec-phase">' + esc(spec.phase) + '</span></span>';
      html += '<span class="approvals">';
      APPROVALS.forEach(function (phase) {
        const status = spec.approvals[phase] || 'missing';
        const mark = status === 'approved' ? '✓' : status === 'generated' ? '●' : status === 'draft' ? '○' : '–';
        html += '<span class="approval ' + esc(status) + '" title="' + esc(phase + ': ' + status) + '">' +
          mark + '<em>' + esc(phase) + '</em></span>';
      });
      html += '</span>';
      html += '<span class="bar"><span style="width:' + pct + '%"></span></span>';
      const meta = [];
      meta.push('<span>' + spec.tasksDone + '/' + spec.tasksTotal + ' tasks</span>');
      if (spec.costTodayUsd) meta.push('<span>' + esc(fmtCost(spec.costTodayUsd)) + ' today</span>');
      if (spec.updatedAt) meta.push('<span>' + esc(timeAgo(spec.updatedAt)) + '</span>');
      const badges = specBadges(spec);
      if (badges) meta.push(badges);
      html += '<span class="spec-meta">' + meta.join('') + '</span>';
      html += '<span class="spec-next"><span class="next-label">Next:</span> ' +
        esc(spec.nextLabel) + (spec.error ? ' · ' + esc(spec.error) : '') + '</span>';
      html += '</button>';
      return html;
    }

    function renderKpi() {
      const kpi = model.kpi;
      const items = [
        { key: 'attention', n: kpi.needsYou, k: 'Needs you',
          s: kpi.reviews + ' approval' + (kpi.reviews === 1 ? '' : 's') + ' waiting',
          alert: kpi.needsYou > 0 },
        { key: 'running', n: kpi.running, k: 'Running',
          s: kpi.activeSpecs + ' spec' + (kpi.activeSpecs === 1 ? '' : 's') + ' in flight' },
        { key: 'failed', cls: 'failed', n: kpi.failed, k: 'Failed today',
          s: kpi.failed
            ? kpi.failed + ' run' + (kpi.failed === 1 ? '' : 's') + ' errored'
            : 'No failures',
          alert: kpi.failed > 0 },
        { n: kpi.tasksDone + '/' + kpi.tasksTotal, k: 'Tasks done',
          s: kpi.specs + ' spec' + (kpi.specs === 1 ? '' : 's') },
        { n: fmtCost(kpi.spendTodayUsd), k: 'Spend today',
          s: kpi.sessionsToday + ' session' + (kpi.sessionsToday === 1 ? '' : 's') },
      ];
      return '<div class="kpis" role="group" aria-label="Overview totals">' + items.map(function (item) {
        const active = item.key && columnFilter === item.key ? ' active' : '';
        const attrs = item.key ? ' data-kpi="' + item.key + '"' : '';
        const pressed = item.key ? ' aria-pressed="' + (columnFilter === item.key ? 'true' : 'false') + '"' : '';
        const classes = 'kpi' + (item.key ? '' : ' static') + (item.cls ? ' ' + item.cls : '') +
          (item.alert ? ' alert' : '') + active;
        const tag = item.key ? 'button' : 'div';
        return '<' + tag + ' class="' + classes + '"' + attrs + pressed + '>' +
          '<span class="n">' + esc(item.n) + '</span>' +
          '<span class="k">' + esc(item.k) + '</span>' +
          '<span class="s">' + esc(item.s) + '</span></' + tag + '>';
      }).join('') + '</div>';
    }

    function render() {
      const app = document.getElementById('app');
      if (!model) {
        app.innerHTML = '<div class="empty">Loading overview…</div>';
        return;
      }
      const previous = {};
      document.querySelectorAll('[data-scroll]').forEach(function (element) {
        previous[element.getAttribute('data-scroll')] = element.scrollTop;
      });

      let html = '<header class="app-header"><div class="brand"><div class="brand-row">' +
        '<h1 class="brand-title">cc-sdd Overview</h1>' +
        '<span class="generated" data-generated="' + model.generatedAt + '">Updated ' +
        esc(timeAgo(model.generatedAt)) + '</span></div>' +
        '<p class="brand-hint">Live runs in this window and sessions active in the last 3 min</p>' +
        '</div><div class="app-actions">';
      html += '<button class="icon-button" data-act="refresh" title="Refresh" aria-label="Refresh">' +
        refreshIcon + '</button>';
      if (columnFilter) {
        html += '<button class="text-button" data-act="clear-filter">Show all</button>';
      }
      html += '<button class="secondary" data-act="run-discovery">Run discovery</button>' +
        '<button class="with-icon" data-act="open-runs">' + consoleIcon + 'Runs console</button>';
      html += '</div></header>';

      if (lastError) {
        html += '<div class="error" role="alert">' + esc(lastError) + '</div>';
      }

      html += renderKpi();

      const totalCards = COLUMNS.reduce(function (total, column) {
        return total + (model.columns[column.key] || []).length;
      }, 0);
      if (!model.specs.length && totalCards === 0) {
        html += '<div class="empty-state"><p class="empty-title">No specs or runs yet</p>' +
          '<p class="empty-body">Run discovery to find the specs in this workspace, ' +
          'or open the Runs console to watch headless work.</p>' +
          '<div class="empty-actions"><button data-act="run-discovery">Run discovery</button>' +
          '<button class="secondary" data-act="open-runs">Open Runs console</button></div></div>';
      } else {
        html += renderBoard();
        html += '<section class="portfolio"><div class="section-head">' +
          '<h2 class="section-title">Spec portfolio</h2>' +
          '<span class="section-hint">' + model.specs.length + ' spec' +
          (model.specs.length === 1 ? '' : 's') + ', needs-you first</span>' +
          '</div><div class="spec-grid">';
        html += model.specs.length
          ? model.specs.map(renderSpec).join('')
          : '<div class="empty-state"><p class="empty-title">No specs found in .kiro/specs</p>' +
            '<p class="empty-body">Run discovery to create the first spec for this workspace.</p>' +
            '<div class="empty-actions"><button data-act="run-discovery">Run discovery</button></div></div>';
        html += '</div></section>';
      }

      app.innerHTML = html;

      document.querySelectorAll('[data-scroll]').forEach(function (element) {
        const key = element.getAttribute('data-scroll');
        if (previous[key]) element.scrollTop = previous[key];
      });

    }

    let timer = null;
    function startTimer() {
      if (timer) clearInterval(timer);
      timer = setInterval(function () {
        document.querySelectorAll('.elapsed[data-start]').forEach(function (element) {
          element.textContent = fmtDuration(Date.now() - Number(element.getAttribute('data-start')));
        });
        document.querySelectorAll('[data-generated]').forEach(function (element) {
          element.textContent = 'Updated ' +
            timeAgo(Number(element.getAttribute('data-generated')));
        });
      }, 1000);
    }

    document.getElementById('app').addEventListener('click', function (event) {
      const kpi = event.target.closest('[data-kpi]');
      if (kpi) {
        const key = kpi.getAttribute('data-kpi');
        columnFilter = columnFilter === key ? null : key;
        render();
        return;
      }

      const action = event.target.closest('[data-act]');
      if (action) {
        const act = action.getAttribute('data-act');
        if (act === 'refresh') {
          vscode.postMessage({ type: 'refresh' });
        } else if (act === 'open-runs') {
          vscode.postMessage({ type: 'openRuns' });
        } else if (act === 'run-discovery') {
          vscode.postMessage({ type: 'runDiscovery' });
        } else if (act === 'clear-filter') {
          columnFilter = null;
          render();
        }
        return;
      }

      const spec = event.target.closest('[data-spec-id]');
      if (spec) {
        vscode.postMessage({ type: 'openSpec', specId: spec.getAttribute('data-spec-id') });
        return;
      }

      const run = event.target.closest('[data-run-id]');
      if (run) {
        vscode.postMessage({ type: 'openRun', runId: run.getAttribute('data-run-id') });
        return;
      }

      const review = event.target.closest('[data-review-spec]');
      if (review) {
        vscode.postMessage({
          type: 'openArtifact',
          specId: review.getAttribute('data-review-spec'),
          phase: review.getAttribute('data-review-phase'),
        });
        return;
      }

      const session = event.target.closest('[data-session-id]');
      if (session) {
        vscode.postMessage({ type: 'previewSession', sessionId: session.getAttribute('data-session-id') });
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

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
