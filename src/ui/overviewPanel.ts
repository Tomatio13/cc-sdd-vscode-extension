// "cc-sdd Overview": a leader / PM board over live runs, recent sessions, and
// spec progress. Runs are authoritative for this window; sessions reveal work
// happening in other windows or terminals.
import * as vscode from 'vscode';
import type { OverviewModel } from '../core/overview';

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
    :root {
      color-scheme: light dark;
      --cc-accent: var(--vscode-textLink-foreground, #4c9aff);
      --cc-success: var(--vscode-testing-iconPassed, #4ade80);
      --cc-error: var(--vscode-errorForeground, #f87171);
      --cc-warn: var(--vscode-editorWarning-foreground, #fbbf24);
      --cc-muted: var(--vscode-descriptionForeground, #9aa4b2);
      --cc-fg: var(--vscode-foreground, #e6edf3);
      --cc-border: var(--vscode-panel-border, rgba(148,163,184,.18));
      --cc-surface: var(--vscode-editorWidget-background, rgba(148,163,184,.06));
      --cc-surface-strong: var(--vscode-input-background, rgba(148,163,184,.12));
      --cc-bg: var(--vscode-editor-background, #1e1e1e);
      --cc-mono: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
      --cc-radius: 10px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 14px 18px 18px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      color: var(--cc-fg);
      background: var(--vscode-panel-background, var(--cc-bg));
      display: flex; flex-direction: column; height: 100vh; overflow: hidden;
    }
    #app { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
    button {
      font-family: var(--vscode-font-family); font-size: 12px; font-weight: 500;
      color: var(--vscode-button-foreground, #ffffff);
      background: var(--vscode-button-background, #0e639c);
      border: 1px solid transparent; border-radius: 6px; padding: 4px 12px; cursor: pointer;
    }
    button:hover { filter: brightness(1.12); }
    button.secondary {
      color: var(--vscode-button-secondaryForeground, var(--cc-fg));
      background: transparent; border-color: var(--cc-border);
    }
    button.secondary:hover { background: var(--cc-surface-strong); }
    select {
      font-family: var(--vscode-font-family); font-size: 12px;
      color: var(--vscode-dropdown-foreground, var(--cc-fg));
      background: var(--vscode-dropdown-background, var(--cc-surface-strong));
      border: 1px solid var(--cc-border); border-radius: 6px; padding: 4px 8px;
    }

    .app-header { display: flex; align-items: flex-start; gap: 12px; flex: none; margin-bottom: 12px; }
    .brand { display: flex; flex-direction: column; gap: 2px; }
    .brand-title { font-weight: 600; letter-spacing: .2px; font-size: 14px; }
    .brand-hint { color: var(--cc-muted); font-size: 11.5px; }
    .app-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .filter { display: flex; align-items: center; gap: 6px; color: var(--cc-muted); font-size: 11.5px; }
    .generated { color: var(--cc-muted); font-family: var(--cc-mono); font-size: 10.5px; }

    .kpis { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 8px; flex: none; margin-bottom: 12px; }
    .kpi {
      text-align: left; padding: 9px 12px; border-radius: var(--cc-radius);
      border: 1px solid var(--cc-border); background: var(--cc-surface); cursor: pointer;
      color: var(--cc-fg); display: flex; flex-direction: column; gap: 1px;
    }
    .kpi:hover { border-color: color-mix(in srgb, var(--cc-accent) 45%, var(--cc-border)); }
    .kpi.active { border-color: var(--cc-accent); background: color-mix(in srgb, var(--cc-accent) 10%, transparent); }
    .kpi .n { font-size: 20px; font-weight: 650; line-height: 1.15; font-variant-numeric: tabular-nums; }
    .kpi .k { font-size: 11px; font-weight: 600; color: var(--cc-muted); text-transform: uppercase; letter-spacing: .5px; }
    .kpi .s { font-size: 10.5px; color: var(--cc-muted); }
    .kpi.attention .n { color: var(--cc-accent); }
    .kpi.running .n { color: var(--cc-warn); }
    .kpi.failed .n { color: var(--cc-error); }
    .kpi.tasks .n { color: var(--cc-success); }

    .board-wrap { flex: 1 1 auto; min-height: 220px; display: flex; flex-direction: column; min-width: 0; }
    .board { display: grid; grid-template-columns: repeat(4, minmax(180px, 1fr)); gap: 10px;
      flex: 1 1 auto; min-height: 0; overflow-x: auto; }
    .column { display: flex; flex-direction: column; min-width: 0; min-height: 0;
      border: 1px solid var(--cc-border); border-radius: var(--cc-radius); background: var(--cc-surface); }
    .column-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px;
      border-bottom: 1px solid var(--cc-border); flex: none; }
    .column-title { font-size: 11.5px; font-weight: 650; letter-spacing: .3px; text-transform: uppercase; }
    .column-count { font-family: var(--cc-mono); font-size: 10.5px; color: var(--cc-muted);
      border: 1px solid var(--cc-border); border-radius: 999px; padding: 0 6px; }
    .column-hint { margin-left: auto; font-size: 10px; color: var(--cc-muted); }
    .column.attention .column-title { color: var(--cc-accent); }
    .column.running .column-title { color: var(--cc-warn); }
    .column.done .column-title { color: var(--cc-success); }
    .column.failed .column-title { color: var(--cc-error); }
    .column-body { padding: 8px; display: flex; flex-direction: column; gap: 7px;
      overflow-y: auto; min-height: 0; flex: 1 1 auto; }
    .column-empty { color: var(--cc-muted); font-size: 11.5px; padding: 8px 4px; }

    .card { border: 1px solid var(--cc-border); border-radius: 8px; background: var(--cc-bg);
      padding: 8px 9px; cursor: pointer; display: flex; flex-direction: column; gap: 4px;
      transition: border-color .12s ease, transform .12s ease; }
    .card:hover { border-color: color-mix(in srgb, var(--cc-accent) 55%, var(--cc-border));
      transform: translateY(-1px); }
    .card.tone-attention { border-color: color-mix(in srgb, var(--cc-accent) 55%, transparent);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--cc-accent) 25%, transparent) inset; }
    .card.tone-failed { border-color: color-mix(in srgb, var(--cc-error) 42%, transparent); }
    .card.tone-cancelled { opacity: .72; }
    .card-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .dot { width: 7px; height: 7px; border-radius: 999px; flex: none; }
    .dot.attention { background: var(--cc-accent); animation: pulse 1.5s ease-in-out infinite; }
    .dot.running { background: var(--cc-warn); animation: pulse 1.5s ease-in-out infinite; }
    .dot.done { background: var(--cc-success); }
    .dot.failed { background: var(--cc-error); }
    .dot.cancelled { background: var(--cc-muted); }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
    .card-feature { font-weight: 600; font-size: 12.5px; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .card-skill { font-family: var(--cc-mono); font-size: 10px; color: var(--cc-muted);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card-elapsed { margin-left: auto; font-family: var(--cc-mono); font-size: 10px;
      color: var(--cc-muted); flex: none; }
    .card-label { font-size: 10px; font-weight: 650; text-transform: uppercase;
      letter-spacing: .5px; color: var(--cc-muted); }
    .tone-attention .card-label { color: var(--cc-accent); }
    .tone-failed .card-label { color: var(--cc-error); }
    .card-detail { font-size: 11.5px; line-height: 1.45; color: var(--cc-fg); opacity: .85;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      overflow: hidden; word-break: break-word; }
    .card-meta { display: flex; gap: 5px; flex-wrap: wrap; align-items: center;
      font-family: var(--cc-mono); font-size: 10px; color: var(--cc-muted); }
    .tag { border: 1px solid var(--cc-border); border-radius: 999px; padding: 0 6px;
      background: var(--cc-surface-strong); }
    .tag.session { color: var(--cc-accent); border-color: color-mix(in srgb, var(--cc-accent) 40%, transparent); }

    .portfolio { flex: none; margin-top: 14px; max-height: 36vh; overflow-y: auto;
      border-top: 1px solid var(--cc-border); padding-top: 12px; }
    .section-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
    .section-title { font-size: 12px; font-weight: 650; letter-spacing: .3px; text-transform: uppercase; }
    .section-hint { color: var(--cc-muted); font-size: 11px; }
    .spec-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 8px; }
    .spec-card { border: 1px solid var(--cc-border); border-radius: var(--cc-radius);
      background: var(--cc-surface); padding: 9px 11px; cursor: pointer; display: flex;
      flex-direction: column; gap: 6px; transition: border-color .12s ease; }
    .spec-card:hover { border-color: color-mix(in srgb, var(--cc-accent) 50%, var(--cc-border)); }
    .spec-card.attention { border-color: color-mix(in srgb, var(--cc-accent) 45%, transparent); }
    .spec-card.active { border-color: color-mix(in srgb, var(--cc-warn) 40%, transparent); }
    .spec-head { display: flex; align-items: center; gap: 7px; min-width: 0; }
    .spec-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .phase-pill { margin-left: auto; font-family: var(--cc-mono); font-size: 9.5px;
      color: var(--cc-muted); border: 1px solid var(--cc-border); border-radius: 999px;
      padding: 0 6px; flex: none; }
    .approvals { display: flex; gap: 4px; }
    .approval { display: inline-flex; align-items: center; gap: 3px; font-size: 10px;
      border: 1px solid var(--cc-border); border-radius: 999px; padding: 0 5px;
      color: var(--cc-muted); background: var(--cc-surface-strong); }
    .approval em { font-style: normal; font-family: var(--cc-mono); }
    .approval.approved { color: var(--cc-success); border-color: color-mix(in srgb, var(--cc-success) 40%, transparent); }
    .approval.generated { color: var(--cc-warn); border-color: color-mix(in srgb, var(--cc-warn) 40%, transparent); }
    .approval.draft { color: var(--cc-muted); }
    .approval.missing { opacity: .5; }
    .bar { height: 4px; border-radius: 999px; background: var(--cc-surface-strong); overflow: hidden; }
    .bar span { display: block; height: 100%; background: var(--cc-success);
      border-radius: 999px; }
    .spec-meta { display: flex; gap: 6px; flex-wrap: wrap; font-size: 10.5px; color: var(--cc-muted);
      font-family: var(--cc-mono); }
    .spec-next { font-size: 10.5px; color: var(--cc-muted); overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; }
    .badge { border-radius: 999px; padding: 0 6px; font-size: 9.5px; font-weight: 600;
      border: 1px solid var(--cc-border); }
    .badge.run { color: var(--cc-warn); border-color: color-mix(in srgb, var(--cc-warn) 40%, transparent); }
    .badge.wait { color: var(--cc-accent); border-color: color-mix(in srgb, var(--cc-accent) 40%, transparent); }
    .badge.review { color: var(--vscode-charts-orange, #fb923c);
      border-color: color-mix(in srgb, var(--vscode-charts-orange, #fb923c) 40%, transparent); }
    .badge.done { color: var(--cc-success); border-color: color-mix(in srgb, var(--cc-success) 40%, transparent); }
    .empty { color: var(--cc-muted); font-size: 12px; padding: 18px 6px; text-align: center; }
    .error { color: var(--cc-error); font-size: 12px; padding: 8px 10px;
      border: 1px solid color-mix(in srgb, var(--cc-error) 40%, transparent);
      border-radius: 8px; margin-bottom: 8px; }
    @media (max-width: 900px) {
      .kpis { grid-template-columns: repeat(3, minmax(110px, 1fr)); }
      .board { grid-template-columns: repeat(2, minmax(180px, 1fr)); }
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
      return '$' + value.toFixed(value < 1 ? 3 : 2);
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
      { key: 'attention', label: 'Needs you', hint: 'permission / answer' },
      { key: 'running', label: 'Running', hint: 'in flight' },
      { key: 'done', label: 'Done', hint: 'finished' },
      { key: 'failed', label: 'Failed', hint: 'error / cancelled' },
    ];
    const APPROVALS = ['requirements', 'design', 'tasks'];

    let model = null;
    let specFilter = '';
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
      let html = '<article class="card tone-' + esc(card.tone) + '"' + attrs +
        ' title="' + action + '">';
      html += '<div class="card-top"><span class="dot ' + esc(card.tone) + '"></span>' +
        '<span class="card-feature">' + esc(card.feature) + '</span>' +
        cardElapsed(card) + '</div>';
      html += '<div class="card-skill">' +
        (card.source === 'review' ? 'spec approval' : '/' + esc(card.skill)) + '</div>';
      html += '<div class="card-label">' + esc(card.label) + '</div>';
      if (card.detail) {
        html += '<div class="card-detail">' + esc(card.detail) + '</div>';
      }
      const meta = [];
      if (card.source === 'session') meta.push('<span class="tag session">session</span>');
      if (card.source === 'review') meta.push('<span class="tag">approval</span>');
      if (card.permissionMode) meta.push('<span class="tag">' + esc(card.permissionMode) + '</span>');
      if (card.tokens) meta.push('<span>↑' + esc(fmtTokens(card.tokens)) + '</span>');
      if (typeof card.costUsd === 'number') meta.push('<span>' + esc(fmtCost(card.costUsd)) + '</span>');
      if (meta.length) html += '<div class="card-meta">' + meta.join('') + '</div>';
      html += '</article>';
      return html;
    }

    function visibleColumns() {
      const result = {};
      COLUMNS.forEach(function (column) {
        const cards = (model.columns[column.key] || []).filter(function (card) {
          return !specFilter || card.feature === specFilter;
        });
        result[column.key] = cards;
      });
      return result;
    }

    function renderBoard() {
      const columns = visibleColumns();
      let html = '<div class="board">';
      COLUMNS.forEach(function (column) {
        const cards = columns[column.key];
        const hiddenByKpi = columnFilter && columnFilter !== column.key;
        html += '<section class="column ' + column.key + (hiddenByKpi ? ' dim' : '') + '">';
        html += '<div class="column-head"><span class="column-title">' + esc(column.label) +
          '</span><span class="column-count">' + cards.length + '</span>' +
          '<span class="column-hint">' + esc(column.hint) + '</span></div>';
        html += '<div class="column-body" data-scroll="' + column.key + '">';
        if (hiddenByKpi) {
          html += '<div class="column-empty">Filtered out — click the KPI again to show.</div>';
        } else if (!cards.length) {
          html += '<div class="column-empty">—</div>';
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
      if (spec.attention > 0) badges.push('<span class="badge wait">' + spec.attention + ' needs you</span>');
      if (spec.active > 0) badges.push('<span class="badge run">' + spec.active + ' running</span>');
      if (spec.reviewPhases.length) {
        badges.push('<span class="badge review">review: ' + esc(spec.reviewPhases.join(', ')) + '</span>');
      }
      if (spec.ready) badges.push('<span class="badge done">ready</span>');
      return badges.join('');
    }

    function renderSpec(spec) {
      const pct = spec.tasksTotal > 0 ? Math.round((spec.tasksDone / spec.tasksTotal) * 100) : 0;
      const attention = spec.attention > 0 ? ' attention' : (spec.active > 0 ? ' active' : '');
      let html = '<article class="spec-card' + attention + '" data-spec-id="' + esc(spec.id) +
        '" title="Open ' + esc(spec.tasksPath) + '">';
      html += '<div class="spec-head"><span class="spec-name">' + esc(spec.label) + '</span>' +
        '<span class="phase-pill">' + esc(spec.phase) + '</span></div>';
      html += '<div class="approvals">';
      APPROVALS.forEach(function (phase) {
        const status = spec.approvals[phase] || 'missing';
        const mark = status === 'approved' ? '✓' : status === 'generated' ? '●' : status === 'draft' ? '○' : '–';
        html += '<span class="approval ' + esc(status) + '" title="' + esc(phase + ': ' + status) + '">' +
          mark + '<em>' + esc(phase) + '</em></span>';
      });
      html += '</div>';
      html += '<div class="bar"><span style="width:' + pct + '%"></span></div>';
      const meta = [];
      meta.push('<span>' + spec.tasksDone + ' / ' + spec.tasksTotal + ' tasks</span>');
      if (spec.costTodayUsd) meta.push('<span>' + esc(fmtCost(spec.costTodayUsd)) + ' today</span>');
      if (spec.updatedAt) meta.push('<span>' + esc(timeAgo(spec.updatedAt)) + '</span>');
      const badges = specBadges(spec);
      if (badges) meta.push(badges);
      html += '<div class="spec-meta">' + meta.join('') + '</div>';
      html += '<div class="spec-next">Next: ' + esc(spec.nextLabel) + (spec.error ? ' · ' + esc(spec.error) : '') + '</div>';
      html += '</article>';
      return html;
    }

    function renderKpi() {
      const kpi = model.kpi;
      const items = [
        { key: 'attention', cls: 'attention', n: kpi.needsYou, k: 'Needs you',
          s: kpi.reviews + ' approval' + (kpi.reviews === 1 ? '' : 's') + ' waiting' },
        { key: 'running', cls: 'running', n: kpi.running, k: 'Running',
          s: kpi.activeSpecs + ' spec' + (kpi.activeSpecs === 1 ? '' : 's') + ' in flight' },
        { key: 'failed', cls: 'failed', n: kpi.failed, k: 'Failed today',
          s: kpi.failed ? 'open the card for details' : 'no failures' },
        { cls: 'tasks', n: kpi.tasksDone + '/' + kpi.tasksTotal, k: 'Tasks done',
          s: kpi.specs + ' spec' + (kpi.specs === 1 ? '' : 's') },
        { cls: 'cost', n: fmtCost(kpi.spendTodayUsd), k: 'Spend today',
          s: kpi.sessionsToday + ' session' + (kpi.sessionsToday === 1 ? '' : 's') },
      ];
      return '<div class="kpis">' + items.map(function (item) {
        const active = item.key && columnFilter === item.key ? ' active' : '';
        const attrs = item.key ? ' data-kpi="' + item.key + '"' : '';
        return '<button class="kpi ' + item.cls + active + '"' + attrs + '>' +
          '<span class="n">' + esc(item.n) + '</span>' +
          '<span class="k">' + esc(item.k) + '</span>' +
          '<span class="s">' + esc(item.s) + '</span></button>';
      }).join('') + '</div>';
    }

    function render() {
      const app = document.getElementById('app');
      if (!model) {
        app.innerHTML = '<div class="empty">Loading overview…</div>';
        return;
      }
      if (specFilter && !model.specs.some(function (spec) { return spec.id === specFilter; })) {
        specFilter = '';
      }

      const previous = {};
      document.querySelectorAll('[data-scroll]').forEach(function (element) {
        previous[element.getAttribute('data-scroll')] = element.scrollTop;
      });

      let html = '<header class="app-header"><div class="brand">' +
        '<span class="brand-title">cc-sdd Overview</span>' +
        '<span class="brand-hint">Live runs in this window + sessions active in the last 3 minutes. ' +
        'Click a card to open the run; click a spec to open tasks.md.</span>' +
        '<span class="generated">updated ' + esc(timeAgo(model.generatedAt)) + '</span>' +
        '</div><div class="app-actions">';
      html += '<label class="filter">Spec <select id="spec-filter"><option value="">All specs</option>';
      model.specs.forEach(function (spec) {
        html += '<option value="' + esc(spec.id) + '"' +
          (spec.id === specFilter ? ' selected' : '') + '>' + esc(spec.label) + '</option>';
      });
      html += '</select></label>';
      if (specFilter || columnFilter) {
        html += '<button class="secondary" data-act="clear-filter">Clear filter</button>';
      }
      html += '<button class="secondary" data-act="refresh">Refresh</button>' +
        '<button class="secondary" data-act="open-runs">Runs console</button>' +
        '<button class="secondary" data-act="run-discovery">Run Discovery</button>';
      html += '</div></header>';

      if (lastError) {
        html += '<div class="error">' + esc(lastError) + '</div>';
      }

      html += renderKpi();
      html += '<div class="board-wrap">';

      const totalCards = COLUMNS.reduce(function (total, column) {
        return total + (model.columns[column.key] || []).length;
      }, 0);
      if (!model.specs.length && totalCards === 0) {
        html += '<div class="empty">No specs or runs yet. Start with <strong>Run Discovery</strong>, ' +
          'or open the Runs console to see headless work.</div>';
      } else {
        html += renderBoard();
      }

      html += '</div>';
      html += '<section class="portfolio"><div class="section-head">' +
        '<span class="section-title">Spec portfolio</span>' +
        '<span class="section-hint">' + model.specs.length + ' specs · review / active / ready first</span>' +
        '</div><div class="spec-grid">';
      html += model.specs.length
        ? model.specs.map(renderSpec).join('')
        : '<div class="empty">No specs found under .kiro/specs.</div>';
      html += '</div></section>';

      app.innerHTML = html;

      document.querySelectorAll('[data-scroll]').forEach(function (element) {
        const key = element.getAttribute('data-scroll');
        if (previous[key]) element.scrollTop = previous[key];
      });

      const select = document.getElementById('spec-filter');
      if (select) {
        select.addEventListener('change', function (event) {
          specFilter = event.target.value;
          render();
        });
      }
    }

    let timer = null;
    function startTimer() {
      if (timer) clearInterval(timer);
      timer = setInterval(function () {
        document.querySelectorAll('.elapsed[data-start]').forEach(function (element) {
          element.textContent = fmtDuration(Date.now() - Number(element.getAttribute('data-start')));
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
          specFilter = '';
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
