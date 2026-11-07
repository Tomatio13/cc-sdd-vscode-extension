// "cc-sdd Runs" webview console: shows live progress of headless claude runs.
import * as vscode from 'vscode';
import {
  applyRunEvent,
  startClaudeRun,
  type ClaudeRunHandle,
  type PhaseActions,
  type PhaseActionTarget,
  type RunSegment,
  type RunState,
} from '../run/claudeRunner';

export type { PhaseActions, PhaseActionTarget };

export interface RunsConsoleOptions {
  getWorkspaceRoot: () => string | undefined;
  getBinary: () => string;
  getPhaseActions: (skill: string, feature: string) => Promise<PhaseActions>;
  approvePhase: (feature: string, phase: string) => Promise<void>;
  runPhase: (feature: string, phase: string) => Promise<void>;
  runImplementation: (feature: string) => Promise<void>;
  openPath: (filePath: string) => Promise<void>;
  rerun: (skill: string, feature: string) => Promise<void>;
  resumeTerminal: (sessionId: string) => Promise<void>;
}

interface ConsoleMessage {
  type: string;
  runId?: string;
  phase?: string;
  pendingId?: string;
  decision?: string;
  labels?: unknown;
  instruction?: string;
  permissionMode?: string;
}

const RUN_LIMIT = 30;

const snapshot = (runs: RunState[]): RunState[] =>
  JSON.parse(
    JSON.stringify(
      runs.map((run) => ({
        ...run,
        // History is delivered once via a dedicated message; keep snapshots small.
        history: undefined,
      })),
    ),
  ) as RunState[];

const getNonce = (): string => {
  let text = '';
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  for (let index = 0; index < 24; index += 1) {
    text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return text;
};

const formatDuration = (ms?: number): string => {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    return '';
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds - minutes * 60)}s`;
};

const formatCost = (costUsd?: number): string =>
  typeof costUsd === 'number' && Number.isFinite(costUsd)
    ? `$${costUsd.toFixed(costUsd < 1 ? 3 : 2)}`
    : '';

export class RunsConsole {
  // Open webview panels: undefined filter = the main console (all runs),
  // a run id = a single-run pop-out tab.
  private panels = new Map<vscode.WebviewPanel, string | undefined>();
  private runs: RunState[] = [];
  private seq = 0;
  private handles = new Map<string, ClaudeRunHandle>();
  private deliveredHistory = new Map<vscode.WebviewPanel, Set<string>>();
  private updateTimer?: NodeJS.Timeout;

  constructor(private readonly options: RunsConsoleOptions) {}

  startRun(input: {
    skill: string;
    feature: string;
    prompt: string;
    permissionMode: string;
    resume?: string;
    history?: RunSegment[];
  }): void {
    const root = this.options.getWorkspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage('cc-sdd: open a workspace first.');
      return;
    }

    this.seq += 1;
    const run: RunState = {
      id: `run-${this.seq}`,
      skill: input.skill,
      feature: input.feature,
      prompt: input.prompt,
      permissionMode: input.permissionMode,
      status: 'running',
      segments: [],
      history: input.history,
      startedAt: Date.now(),
    };
    if (input.history?.length) {
      run.segments.push({
        kind: 'system',
        text: `resumed session · ${input.history.length} history entries`,
      });
    }
    this.runs.push(run);
    if (this.runs.length > RUN_LIMIT) {
      this.runs = this.runs.slice(-RUN_LIMIT);
    }

    this.attachRunner(run, {
      prompt: input.prompt,
      permissionMode: input.permissionMode,
      resume: input.resume,
    });

    this.ensureMainPanel();
    this.updateAll();
    for (const panel of this.panels.keys()) {
      this.pushHistoryTo(panel);
    }
  }

  private attachRunner(
    run: RunState,
    input: { prompt: string; permissionMode: string; resume?: string },
  ): void {
    const root = this.options.getWorkspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage('cc-sdd: open a workspace first.');
      return;
    }
    const handle = startClaudeRun({
      executable: this.options.getBinary(),
      cwd: root,
      prompt: input.prompt,
      permissionMode: input.permissionMode,
      resume: input.resume,
      onEvent: (event) => {
        applyRunEvent(run, event);
        this.updateAll();
        if (event.kind === 'result') {
          void this.resolveActions(run);
        }
      },
      onExit: (exitCode, interrupted) => {
        run.pending = undefined;
        if (interrupted) {
          run.status = 'cancelled';
        } else if (exitCode === 0 && run.summary?.isError !== true) {
          run.status = 'done';
        } else {
          run.status = 'error';
        }
        run.endedAt = Date.now();
        this.handles.delete(run.id);
        this.updateAll();
      },
    });
    this.handles.set(run.id, handle);
  }

  /** Turns a preview card into a live resumed run, in place. */
  private resumePreview(run: RunState, instruction: string, permissionMode: string): void {
    if (!run.preview) {
      return;
    }
    const { sessionId } = run.preview;
    run.status = 'running';
    run.permissionMode = permissionMode;
    run.prompt = instruction;
    run.preview = undefined;
    run.pending = undefined;
    run.summary = undefined;
    run.phaseActions = undefined;
    run.endedAt = undefined;
    run.startedAt = Date.now();
    run.segments = [
      { kind: 'system', text: `resumed session · ${run.history?.length ?? 0} history entries` },
    ];
    this.attachRunner(run, {
      prompt: instruction.trim() || 'Continue from where you left off.',
      permissionMode,
      resume: sessionId,
    });
    this.updateAll();
  }

  show(): void {
    this.ensureMainPanel();
    this.updateAll();
  }

  previewSession(input: {
    title: string;
    skill?: string;
    feature?: string;
    sessionId: string;
    filePath: string;
    history: RunSegment[];
    defaultPermissionMode?: string;
  }): void {
    this.seq += 1;
    const run: RunState = {
      id: `run-${this.seq}`,
      skill: input.skill ?? 'session',
      feature: input.feature ?? input.title,
      prompt: '',
      permissionMode: 'read-only',
      status: 'preview',
      segments: [],
      history: input.history,
      preview: {
        sessionId: input.sessionId,
        filePath: input.filePath,
        defaultPermissionMode: input.defaultPermissionMode,
      },
      startedAt: Date.now(),
    };
    this.runs.push(run);
    if (this.runs.length > RUN_LIMIT) {
      this.runs = this.runs.slice(-RUN_LIMIT);
    }
    this.ensureMainPanel();
    this.updateAll();
    for (const panel of this.panels.keys()) {
      this.pushHistoryTo(panel);
    }
  }

  dispose(): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = undefined;
    }
    for (const handle of this.handles.values()) {
      handle.cancel();
    }
    this.handles.clear();
    for (const panel of this.panels.keys()) {
      panel.dispose();
    }
    this.panels.clear();
  }

  private ensureMainPanel(): void {
    const main = [...this.panels.entries()].find(([, filter]) => filter === undefined);
    if (main) {
      if (!main[0].visible) {
        main[0].reveal(undefined, true);
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'ccSdd.runs',
      'cc-sdd Runs',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    this.attachPanel(panel, undefined);
  }

  private openRunTab(runId: string): void {
    const run = this.byId(runId);
    if (!run) {
      return;
    }
    const existing = [...this.panels.entries()].find(([, filter]) => filter === runId);
    if (existing) {
      if (!existing[0].visible) {
        existing[0].reveal(undefined, true);
      }
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'ccSdd.run',
      `cc-sdd · ${run.feature || run.skill}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    this.attachPanel(panel, runId);
  }

  private attachPanel(panel: vscode.WebviewPanel, filter: string | undefined): void {
    panel.onDidChangeViewState(
      (event) => {
        if (event.webviewPanel.visible) {
          this.pushTo(event.webviewPanel);
        }
      },
      null,
      [],
    );
    panel.onDidDispose(() => {
      this.panels.delete(panel);
      this.deliveredHistory.delete(panel);
    });
    panel.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(panel, message));
    panel.webview.html = this.buildHtml(panel.webview);
    this.panels.set(panel, filter);
    this.pushTo(panel);
    this.pushHistoryTo(panel);
  }

  private pushHistoryTo(panel: vscode.WebviewPanel): void {
    let delivered = this.deliveredHistory.get(panel);
    if (!delivered) {
      delivered = new Set<string>();
      this.deliveredHistory.set(panel, delivered);
    }
    for (const run of this.runs) {
      if (!run.history?.length || delivered.has(run.id)) {
        continue;
      }
      delivered.add(run.id);
      void panel.webview.postMessage({ type: 'history', runId: run.id, segments: run.history });
    }
  }

  private pushTo(panel: vscode.WebviewPanel): void {
    const filter = this.panels.get(panel);
    const list = filter ? this.runs.filter((run) => run.id === filter) : this.runs;
    void panel.webview.postMessage({ type: 'state', runs: snapshot(list) });
  }

  private updateAll(): void {
    // Coalesce bursts of streaming events into one webview update.
    if (this.updateTimer) {
      return;
    }
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      for (const panel of this.panels.keys()) {
        this.pushTo(panel);
      }
    }, 80);
  }

  private byId(runId: unknown): RunState | undefined {
    if (typeof runId !== 'string') {
      return undefined;
    }
    return this.runs.find((run) => run.id === runId);
  }

  private removeRun(runId: string): void {
    this.handles.get(runId)?.cancel();
    this.handles.delete(runId);
    this.runs = this.runs.filter((run) => run.id !== runId);
    for (const [panel, filter] of [...this.panels.entries()]) {
      if (filter === runId) {
        panel.dispose();
      }
    }
    this.updateAll();
  }

  private handleMessage(panel: vscode.WebviewPanel, message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const typed = message as ConsoleMessage;
    const run = this.byId(typed.runId);

    switch (typed.type) {
      case 'ready':
        this.pushTo(panel);
        this.pushHistoryTo(panel);
        return;
      case 'clearFinished':
        this.runs = this.runs.filter((candidate) => candidate.status === 'running');
        this.updateAll();
        return;
      case 'copy':
        if (run) {
          void vscode.env.clipboard.writeText(run.prompt);
          void vscode.window.showInformationMessage('cc-sdd: prompt copied.');
        }
        return;
      case 'popout':
        if (run) {
          this.openRunTab(run.id);
        }
        return;
      case 'close':
        if (run) {
          this.removeRun(run.id);
        }
        return;
      case 'cancel':
        if (run) {
          run.pending = undefined;
          this.handles.get(run.id)?.cancel();
          this.updateAll();
        }
        return;
      case 'permission': {
        if (!run || typeof typed.pendingId !== 'string') {
          return;
        }
        const decision = typed.decision;
        if (decision === 'allow' || decision === 'always' || decision === 'deny') {
          this.handles.get(run.id)?.respondPermission(typed.pendingId, decision);
          run.pending = undefined;
          this.updateAll();
        }
        return;
      }
      case 'answer': {
        if (!run || typeof typed.pendingId !== 'string' || !run.pending?.questions) {
          return;
        }
        const labels = Array.isArray(typed.labels)
          ? typed.labels.filter((label): label is string => typeof label === 'string')
          : [];
        if (labels.length !== run.pending.questions.length) {
          return;
        }
        const answers: Record<string, string> = {};
        run.pending.questions.forEach((question, index) => {
          answers[question.question] = labels[index];
        });
        this.handles.get(run.id)?.respondQuestion(typed.pendingId, answers);
        run.pending = undefined;
        this.updateAll();
        return;
      }
      case 'rerun':
        if (run) {
          void this.options.rerun(run.skill, run.feature);
        }
        return;
      case 'resumeConsole':
        if (run?.preview) {
          const instruction = typeof typed.instruction === 'string' ? typed.instruction : '';
          const mode =
            typeof typed.permissionMode === 'string' && typed.permissionMode
              ? typed.permissionMode
              : run.preview.defaultPermissionMode ?? 'default';
          this.resumePreview(run, instruction, mode);
        }
        return;
      case 'resumeTerminal':
        if (run?.preview) {
          void this.options.resumeTerminal(run.preview.sessionId);
        }
        return;
      case 'openArtifact':
        if (run?.phaseActions?.artifactPath) {
          void this.options.openPath(run.phaseActions.artifactPath);
        }
        return;
      case 'approve':
        if (run && typeof typed.phase === 'string') {
          void this.options.approvePhase(run.feature, typed.phase);
        }
        return;
      case 'runPhase':
        if (run && typeof typed.phase === 'string') {
          void this.options.runPhase(run.feature, typed.phase);
        }
        return;
      case 'runImpl':
        if (run) {
          void this.options.runImplementation(run.feature);
        }
        return;
      default:
        return;
    }
  }

  private async resolveActions(run: RunState): Promise<void> {
    try {
      run.phaseActions = await this.options.getPhaseActions(run.skill, run.feature);
      this.updateAll();
    } catch {
      // Actions are optional; keep the console usable without them.
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
  <title>cc-sdd Runs</title>
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
      --cc-mono: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
      --cc-radius: 10px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 14px 18px 18px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      color: var(--cc-fg);
      background: var(--vscode-panel-background);
      display: flex; flex-direction: column; height: 100vh;
    }
    .app-header { display: flex; align-items: center; gap: 10px; margin: 0 0 14px; flex: none; }
    .app-title { font-weight: 600; letter-spacing: .2px; }
    .app-hint { color: var(--cc-muted); font-size: 12px; }
    .app-actions { margin-left: auto; }
    #app { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }

    button {
      font-family: var(--vscode-font-family); font-size: 12px; font-weight: 500;
      color: var(--vscode-button-foreground); background: var(--vscode-button-background);
      border: 1px solid transparent; border-radius: 6px; padding: 4px 12px; cursor: pointer;
      transition: filter .12s ease, background .12s ease;
    }
    button:hover { filter: brightness(1.12); }
    button.secondary {
      color: var(--vscode-button-secondaryForeground, var(--cc-fg));
      background: transparent; border-color: var(--cc-border);
    }
    button.secondary:hover { background: var(--cc-surface-strong); }

    .run { border: 1px solid var(--cc-border); border-radius: var(--cc-radius); margin-bottom: 16px;
      background: var(--vscode-editor-background); display: flex; flex-direction: column;
      flex: none; overflow: hidden; }
    .run.running { flex: 1 1 auto; min-height: 280px; }
    .run.running .log { flex: 1 1 auto; max-height: none; min-height: 140px; }
    .run.preview { flex: 1 1 auto; min-height: 280px; }
    .run.preview .log { flex: 1 1 auto; max-height: none; min-height: 140px; }

    .head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; flex-wrap: wrap;
      background: var(--cc-surface); border-bottom: 1px solid var(--cc-border); }
    .status-dot { width: 8px; height: 8px; border-radius: 999px; flex: none; }
    .status-dot.running { background: var(--cc-warn); animation: pulse 1.4s ease-in-out infinite; }
    .status-dot.done { background: var(--cc-success); }
    .status-dot.error { background: var(--cc-error); }
    .status-dot.cancelled { background: var(--cc-muted); }
    .status-dot.preview { background: var(--cc-accent); }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
    .title { font-weight: 600; display: inline-flex; align-items: center; gap: 8px; }
    .skilltag { font-family: var(--cc-mono); font-size: 11px; font-weight: 500;
      color: var(--cc-muted); background: var(--cc-surface-strong);
      border: 1px solid var(--cc-border); border-radius: 999px; padding: 1px 8px; }
    .pill { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .6px;
      padding: 2px 8px; border-radius: 999px; border: 1px solid var(--cc-border);
      color: var(--cc-muted); background: var(--cc-surface-strong); }
    .pill.running { color: var(--cc-warn);
      border-color: color-mix(in srgb, var(--cc-warn) 45%, transparent);
      background: color-mix(in srgb, var(--cc-warn) 10%, transparent); }
    .pill.waiting { color: var(--cc-accent);
      border-color: color-mix(in srgb, var(--cc-accent) 55%, transparent);
      background: color-mix(in srgb, var(--cc-accent) 12%, transparent);
      animation: pulse 1.6s ease-in-out infinite; }
    .pill.done { color: var(--cc-success);
      border-color: color-mix(in srgb, var(--cc-success) 45%, transparent);
      background: color-mix(in srgb, var(--cc-success) 10%, transparent); }
    .pill.error { color: var(--cc-error);
      border-color: color-mix(in srgb, var(--cc-error) 45%, transparent);
      background: color-mix(in srgb, var(--cc-error) 10%, transparent); }
    .pill.preview { color: var(--cc-accent);
      border-color: color-mix(in srgb, var(--cc-accent) 45%, transparent);
      background: color-mix(in srgb, var(--cc-accent) 10%, transparent); }
    .mode { font-family: var(--cc-mono); font-size: 11px; color: var(--cc-muted); }
    .elapsed { font-family: var(--cc-mono); font-size: 11px; color: var(--cc-muted); }
    .spacer { flex: 1; }

    .progress { height: 2px; background: var(--cc-surface-strong); overflow: hidden; flex: none; }
    .progress span { display: block; height: 100%; width: 32%;
      background: linear-gradient(90deg, transparent, var(--cc-accent), transparent);
      animation: slide 1.6s linear infinite; }
    @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(400%); } }

    .log { margin: 0; padding: 12px 14px 8px; overflow-y: auto; max-height: 440px;
      display: flex; flex-direction: column; gap: 6px;
      font-size: 12.5px; line-height: 1.6; }

    .event.system { display: flex; align-items: center; gap: 8px; color: var(--cc-muted);
      font-family: var(--cc-mono); font-size: 11px; }
    .event.system::before { content: ""; width: 5px; height: 5px; border-radius: 999px; background: var(--cc-border); }

    details.tool { border: 1px solid var(--cc-border); border-radius: 8px; background: var(--cc-surface); }
    details.tool > summary { display: flex; align-items: center; gap: 8px; padding: 6px 10px;
      cursor: pointer; list-style: none; }
    details.tool > summary::-webkit-details-marker { display: none; }
    details.tool > summary::before { content: "\\203a"; color: var(--cc-muted); font-weight: 600;
      transition: transform .12s ease; flex: none; }
    details.tool[open] > summary::before { transform: rotate(90deg); }
    details.tool.no-body > summary { cursor: default; }
    details.tool.no-body > summary::before { display: none; }
    .chip { font-family: var(--cc-mono); font-size: 10.5px; font-weight: 600;
      padding: 1px 8px; border-radius: 999px; border: 1px solid var(--cc-border);
      color: var(--cc-muted); background: var(--cc-surface-strong); flex: none; }
    .chip.read { color: var(--cc-accent);
      border-color: color-mix(in srgb, var(--cc-accent) 40%, transparent);
      background: color-mix(in srgb, var(--cc-accent) 12%, transparent); }
    .chip.write { color: var(--cc-warn);
      border-color: color-mix(in srgb, var(--cc-warn) 40%, transparent);
      background: color-mix(in srgb, var(--cc-warn) 12%, transparent); }
    .chip.bash { color: var(--vscode-terminal-ansiMagenta, #c084fc);
      border-color: color-mix(in srgb, var(--vscode-terminal-ansiMagenta, #c084fc) 40%, transparent);
      background: color-mix(in srgb, var(--vscode-terminal-ansiMagenta, #c084fc) 12%, transparent); }
    .chip.search { color: var(--vscode-charts-teal, #2dd4bf);
      border-color: color-mix(in srgb, var(--vscode-charts-teal, #2dd4bf) 40%, transparent);
      background: color-mix(in srgb, var(--vscode-charts-teal, #2dd4bf) 12%, transparent); }
    .chip.agent { color: var(--cc-success);
      border-color: color-mix(in srgb, var(--cc-success) 40%, transparent);
      background: color-mix(in srgb, var(--cc-success) 12%, transparent); }
    .chip.web { color: var(--vscode-charts-orange, #fb923c);
      border-color: color-mix(in srgb, var(--vscode-charts-orange, #fb923c) 40%, transparent);
      background: color-mix(in srgb, var(--vscode-charts-orange, #fb923c) 12%, transparent); }
    .tool-summary { font-family: var(--cc-mono); font-size: 12px; color: var(--cc-fg);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
    .badge { font-size: 10px; font-weight: 600; padding: 1px 7px; border-radius: 999px; flex: none; }
    .badge.error { color: var(--cc-error); background: color-mix(in srgb, var(--cc-error) 14%, transparent); }
    .tool-output { margin: 0; padding: 8px 12px 10px; border-top: 1px solid var(--cc-border);
      font-family: var(--cc-mono); font-size: 11.5px; line-height: 1.5;
      color: var(--cc-fg); white-space: pre-wrap; word-break: break-word;
      max-height: 260px; overflow: auto; opacity: .9; }

    .prose { color: var(--cc-fg); font-size: 13px; line-height: 1.65; }
    .prose p { margin: 2px 0 8px; }
    .prose h1, .prose h2, .prose h3, .prose h4 { margin: 12px 0 6px; font-weight: 600; line-height: 1.35; }
    .prose h1 { font-size: 17px; } .prose h2 { font-size: 15px; }
    .prose h3 { font-size: 14px; } .prose h4 { font-size: 13px; }
    .prose ul, .prose ol { margin: 4px 0 8px 20px; padding: 0; }
    .prose li { margin: 2px 0; }
    .prose code { font-family: var(--cc-mono); font-size: 12px;
      background: var(--cc-surface-strong); border: 1px solid var(--cc-border);
      border-radius: 4px; padding: 0 4px; }
    .prose pre.code { margin: 6px 0 10px; padding: 10px 12px; border-radius: 8px;
      background: var(--vscode-textCodeBlock-background, var(--cc-surface));
      border: 1px solid var(--cc-border); overflow: auto; max-height: 320px;
      font-family: var(--cc-mono); font-size: 12px; line-height: 1.5; }
    .prose pre.code code { background: none; border: none; padding: 0; font-size: inherit; }
    .prose strong { font-weight: 600; }
    .prose table { border-collapse: collapse; margin: 6px 0 10px; font-size: 12px; }
    .prose th, .prose td { border: 1px solid var(--cc-border); padding: 4px 10px; text-align: left; vertical-align: top; }
    .prose th { background: var(--cc-surface-strong); font-weight: 600; }

    .history { border: 1px solid var(--cc-border); border-radius: 8px;
      background: var(--cc-surface); margin-bottom: 6px; }
    .history > summary { cursor: pointer; padding: 8px 12px; list-style: none;
      font-size: 11.5px; font-weight: 600; color: var(--cc-muted); }
    .history > summary::-webkit-details-marker { display: none; }
    .history[open] > summary { border-bottom: 1px solid var(--cc-border); }
    .history-body { padding: 10px 12px 4px; display: flex; flex-direction: column; gap: 6px; }

    .event.user { display: flex; gap: 8px; align-items: flex-start; }
    .user-badge { flex: none; font-size: 10px; font-weight: 700; letter-spacing: .4px;
      text-transform: uppercase; color: var(--cc-accent);
      border: 1px solid color-mix(in srgb, var(--cc-accent) 45%, transparent);
      background: color-mix(in srgb, var(--cc-accent) 10%, transparent);
      border-radius: 999px; padding: 1px 8px; margin-top: 2px; }
    .event.user .prose { flex: 1; min-width: 0; }

    .errorline { color: var(--cc-error); font-family: var(--cc-mono); font-size: 12px;
      background: color-mix(in srgb, var(--cc-error) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--cc-error) 35%, transparent);
      border-radius: 8px; padding: 6px 10px; white-space: pre-wrap; word-break: break-word; }

    .pending { margin: 10px 14px 12px; padding: 12px 14px; border-radius: 10px;
      border: 1px solid color-mix(in srgb, var(--cc-accent) 55%, transparent);
      background: color-mix(in srgb, var(--cc-accent) 8%, transparent); }
    .pending-kind { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .7px;
      color: var(--cc-accent); margin-bottom: 6px; }
    .pending-title { font-weight: 600; margin-bottom: 4px; }
    .pending-detail { font-family: var(--cc-mono); font-size: 12px; color: var(--cc-muted);
      white-space: pre-wrap; word-break: break-word; margin-bottom: 10px; }
    .pending-actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .question { margin-bottom: 12px; }
    .question:last-of-type { margin-bottom: 6px; }
    .option { display: block; width: 100%; text-align: left; margin: 5px 0; padding: 8px 12px;
      background: var(--cc-surface); color: var(--cc-fg);
      border: 1px solid var(--cc-border); border-radius: 8px; cursor: pointer;
      font-family: var(--vscode-font-family); font-size: 12.5px; }
    .option:hover { border-color: var(--cc-accent); }
    .option.selected { border-color: var(--cc-accent);
      box-shadow: 0 0 0 1px var(--cc-accent) inset; }
    .option .optdesc { display: block; margin-top: 3px; font-size: 11.5px; color: var(--cc-muted); }
    .options-hint { font-size: 11px; color: var(--cc-muted); }

    .summary { margin: 12px 14px 14px; border-radius: 10px; border: 1px solid var(--cc-border);
      background: var(--cc-surface); padding: 12px 14px; }
    .summary.is-error { border-color: color-mix(in srgb, var(--cc-error) 45%, transparent); }
    .summary-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .7px;
      color: var(--cc-muted); margin-bottom: 6px; }
    .summary.is-error .summary-label { color: var(--cc-error); }
    .summary-text { white-space: pre-wrap; word-break: break-word; line-height: 1.6; }
    .stats { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
    .stat-chip { font-family: var(--cc-mono); font-size: 11px; color: var(--cc-muted);
      background: var(--cc-surface-strong); border: 1px solid var(--cc-border);
      border-radius: 999px; padding: 1px 8px; }

    .button-row { display: flex; gap: 6px; flex-wrap: wrap; padding: 10px 14px;
      border-top: 1px solid var(--cc-border); background: var(--cc-surface); }

    .resume-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
      padding: 10px 14px; border-top: 1px solid var(--cc-border); background: var(--cc-surface); }
    .resume-input { flex: 1 1 320px; min-width: 200px; outline: none;
      font-family: var(--vscode-font-family); font-size: 12.5px;
      color: var(--vscode-input-foreground, var(--cc-fg));
      background: var(--vscode-input-background, var(--cc-surface-strong));
      border: 1px solid var(--cc-border); border-radius: 6px; padding: 6px 10px; }
    .resume-input:focus { border-color: var(--cc-accent); }
    .resume-mode { font-family: var(--cc-mono); font-size: 11.5px;
      color: var(--vscode-dropdown-foreground, var(--cc-fg));
      background: var(--vscode-dropdown-background, var(--cc-surface-strong));
      border: 1px solid var(--cc-border); border-radius: 6px; padding: 6px 8px; }
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
      if (typeof ms !== 'number' || ms < 0) return '';
      if (ms < 1000) return Math.round(ms) + 'ms';
      const s = ms / 1000;
      return s < 60 ? s.toFixed(1) + 's' : Math.floor(s / 60) + 'm' + Math.round(s % 60) + 's';
    };
    const fmtCost = (cost) => (typeof cost === 'number' ? '$' + cost.toFixed(cost < 1 ? 3 : 2) : '');

    function button(act, runId, label, secondary, phase) {
      const attrs = 'data-act="' + esc(act) + '" data-run="' + esc(runId) + '"' +
        (phase ? ' data-phase="' + esc(phase) + '"' : '');
      return '<button ' + attrs + (secondary ? ' class="secondary"' : '') + '>' + esc(label) + '</button>';
    }

    function rawButton(runId, act, label, attrs, secondary) {
      let extra = '';
      const data = attrs || {};
      Object.keys(data).forEach(function (key) {
        extra += ' data-' + key + '="' + esc(data[key]) + '"';
      });
      return '<button data-act="' + esc(act) + '" data-run="' + esc(runId) + '"' + extra +
        (secondary ? ' class="secondary"' : '') + '>' + esc(label) + '</button>';
    }

    function classify(name) {
      const lower = String(name || '').toLowerCase();
      if (lower === 'bash' || lower === 'powershell') return 'bash';
      if (lower === 'read') return 'read';
      if (lower === 'edit' || lower === 'write' || lower === 'notebookedit') return 'write';
      if (lower === 'grep' || lower === 'glob' || lower === 'ls') return 'search';
      if (lower === 'task' || lower === 'agent' || lower === 'workflow') return 'agent';
      if (lower.indexOf('web') === 0) return 'web';
      return 'other';
    }

    function inline(text) {
      let out = esc(text);
      out = out.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
      out = out.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      return out;
    }

    function splitRow(row) {
      return row.trim().replace(/^\\|/, '').replace(/\\|$/, '').split('|').map(function (cell) {
        return cell.trim();
      });
    }

    function renderMarkdown(text) {
      const lines = String(text).split('\\n');
      let html = '';
      let list = null;
      const closeList = () => {
        if (list) { html += '</' + list + '>'; list = null; }
      };
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].replace(/\\s+$/, '');
        const nextLine = (lines[index + 1] || '').replace(/\\s+$/, '');
        const isTableStart = /^\\s*\\|.*\\|\\s*$/.test(line) && /^\\s*\\|[\\s:|-]+\\|\\s*$/.test(nextLine);
        if (isTableStart) {
          closeList();
          const header = splitRow(line);
          let rows = '';
          let cursor = index + 2;
          while (cursor < lines.length && /^\\s*\\|.*\\|\\s*$/.test(lines[cursor])) {
            rows += '<tr>' + splitRow(lines[cursor]).map(function (cell) {
              return '<td>' + inline(cell) + '</td>';
            }).join('') + '</tr>';
            cursor += 1;
          }
          html += '<table><thead><tr>' + header.map(function (cell) {
            return '<th>' + inline(cell) + '</th>';
          }).join('') + '</tr></thead><tbody>' + rows + '</tbody></table>';
          index = cursor - 1;
          continue;
        }
        const heading = /^(#{1,6})\\s+(.*)$/.exec(line);
        if (heading) {
          closeList();
          const level = Math.min(6, heading[1].length + 2);
          html += '<h' + level + '>' + inline(heading[2]) + '</h' + level + '>';
          continue;
        }
        if (/^\\s*[-*]\\s+/.test(line)) {
          if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
          html += '<li>' + inline(line.replace(/^\\s*[-*]\\s+/, '')) + '</li>';
          continue;
        }
        if (/^\\s*\\d+[.)]\\s+/.test(line)) {
          if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
          html += '<li>' + inline(line.replace(/^\\s*\\d+[.)]\\s+/, '')) + '</li>';
          continue;
        }
        if (!line.trim()) { closeList(); continue; }
        closeList();
        html += '<p>' + inline(line) + '</p>';
      }
      closeList();
      return html;
    }

    function renderProse(text) {
      const parts = String(text).split('\`\`\`');
      let html = '';
      parts.forEach(function (part, index) {
        if (index % 2 === 1) {
          const body = part.replace(/^[a-zA-Z0-9_+-]*\\n/, '').replace(/\\n$/, '');
          html += '<pre class="code"><code>' + esc(body) + '</code></pre>';
        } else if (part.trim()) {
          html += renderMarkdown(part);
        }
      });
      return '<div class="event prose">' + html + '</div>';
    }

    function buildItems(segments) {
      const items = [];
      let skipResult = false;
      for (const seg of segments || []) {
        if (seg.kind === 'tool') {
          const text = String(seg.text || '');
          const split = text.indexOf(': ');
          const name = split > 0 ? text.slice(0, split) : text;
          const summary = split > 0 ? text.slice(split + 2) : '';
          // The question card below already represents this call.
          if (name === 'AskUserQuestion') {
            skipResult = true;
            continue;
          }
          items.push({ type: 'tool', name: name, summary: summary, result: '', isError: false });
        } else if (seg.kind === 'toolresult') {
          if (skipResult) {
            skipResult = false;
            continue;
          }
          const last = items[items.length - 1];
          if (last && last.type === 'tool' && !last.result) {
            last.result = String(seg.text || '');
            last.isError = seg.isError === true;
          } else {
            items.push({ type: 'result', text: String(seg.text || ''), isError: seg.isError === true });
          }
        } else if (seg.kind === 'text') {
          items.push({ type: 'text', text: String(seg.text || '') });
        } else if (seg.kind === 'user') {
          items.push({ type: 'user', text: String(seg.text || '') });
        } else if (seg.kind === 'system') {
          items.push({ type: 'system', text: String(seg.text || '') });
        } else if (seg.kind === 'error') {
          items.push({ type: 'error', text: String(seg.text || '') });
        }
      }
      return items;
    }

    function renderItems(items) {
      let html = '';
      for (const item of items) {
        if (item.type === 'text') {
          html += renderProse(item.text);
        } else if (item.type === 'user') {
          html += '<div class="event user"><span class="user-badge">You</span>' +
            renderProse(item.text) + '</div>';
        } else if (item.type === 'system') {
          html += '<div class="event system">' + esc(item.text) + '</div>';
        } else if (item.type === 'tool') {
          const kind = classify(item.name);
          const hasBody = item.result !== '' && item.result.trim() !== '';
          html += '<details class="event tool' + (hasBody ? '' : ' no-body') + '">';
          html += '<summary><span class="chip ' + kind + '">' + esc(item.name) + '</span>';
          html += '<span class="tool-summary">' + esc(item.summary) + '</span>';
          if (item.isError) html += '<span class="badge error">error</span>';
          html += '</summary>';
          if (hasBody) html += '<pre class="tool-output">' + esc(item.result) + '</pre>';
          html += '</details>';
        } else if (item.type === 'result') {
          html += '<div class="event toolresult">' + esc(item.text) + '</div>';
        } else if (item.type === 'error') {
          html += '<div class="event errorline">' + esc(item.text) + '</div>';
        }
      }
      return html;
    }

    function renderHead(run) {
      const running = run.status === 'running';
      const preview = run.status === 'preview';
      const pending = !!run.pending;
      const label = pending ? 'waiting for you' : run.status;
      const duration = running || preview
        ? ''
        : fmtDuration((run.endedAt || Date.now()) - run.startedAt);

      let html = '<div class="head">';
      html += '<span class="status-dot ' + esc(run.status) + '"></span>';
      html += '<span class="title">' + esc(run.feature || run.skill) +
        ' <span class="skilltag">/' + esc(run.skill) + '</span></span>';
      html += '<span class="pill ' + (pending ? 'waiting' : esc(run.status)) + '">' + esc(label) + '</span>';
      html += '<span class="mode">' + esc(run.permissionMode) + '</span>';
      if (running) {
        html += '<span class="elapsed" data-start="' + run.startedAt + '">' +
          fmtDuration(Date.now() - run.startedAt) + '</span>';
      } else if (duration) {
        html += '<span class="elapsed">' + esc(duration) + '</span>';
      }
      html += '<span class="spacer"></span>';
      if (preview) {
        html += button('close', run.id, 'Close', true);
      } else {
        if (running) html += button('popout', run.id, 'New tab', true);
        html += button('copy', run.id, 'Copy prompt', true);
        if (running) html += button('cancel', run.id, 'Cancel');
        else html += button('rerun', run.id, 'Re-run', true);
        if (!running) html += button('close', run.id, 'Close', true);
      }
      html += '</div>';
      return html;
    }

    function renderResumeBar(run) {
      const modes = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
      const preferred = (run.preview && run.preview.defaultPermissionMode) || 'default';
      let options = '';
      modes.forEach(function (mode) {
        options += '<option value="' + esc(mode) + '"' +
          (mode === preferred ? ' selected' : '') + '>' + esc(mode) + '</option>';
      });
      return '<div class="resume-bar">' +
        '<input class="resume-input" data-run="' + esc(run.id) +
        '" placeholder="Message to continue (leave empty to just continue)" />' +
        '<select class="resume-mode" data-run="' + esc(run.id) + '">' + options + '</select>' +
        '<button data-act="resumeConsole" data-run="' + esc(run.id) + '">Resume in console</button>' +
        '<button class="secondary" data-act="resumeTerminal" data-run="' + esc(run.id) + '">Terminal</button>' +
        '</div>';
    }

    function renderPending(run, pending) {
      if (pending.kind === 'permission') {
        let html = '<div class="pending">';
        html += '<div class="pending-kind">permission required</div>';
        html += '<div class="pending-title">Allow ' + esc(pending.toolName || 'tool') + '?</div>';
        if (pending.summary) html += '<div class="pending-detail">' + esc(pending.summary) + '</div>';
        html += '<div class="pending-actions">';
        html += rawButton(run.id, 'permission', 'Allow once', { pending: pending.id, decision: 'allow' }, false);
        html += rawButton(run.id, 'permission', 'Always allow ' + (pending.toolName || 'this tool'), { pending: pending.id, decision: 'always' }, true);
        html += rawButton(run.id, 'permission', 'Deny', { pending: pending.id, decision: 'deny' }, true);
        html += '</div></div>';
        return html;
      }

      const questions = pending.questions || [];
      let html = '<div class="pending">';
      html += '<div class="pending-kind">question</div>';
      questions.forEach(function (question, index) {
        html += '<div class="question">';
        html += '<div class="pending-title">' + esc((question.header ? question.header + ' — ' : '') + question.question) + '</div>';
        (question.options || []).forEach(function (option) {
          html += '<button class="option" data-act="option" data-run="' + esc(run.id) +
            '" data-pending="' + esc(pending.id) + '" data-q="' + index +
            '" data-label="' + esc(option.label) + '">' + esc(option.label) +
            (option.description ? '<span class="optdesc">' + esc(option.description) + '</span>' : '') +
            '</button>';
        });
        html += '</div>';
      });
      if (questions.length > 1) {
        html += '<div class="options-hint">Answer every question to continue.</div>';
      }
      html += '</div>';
      return html;
    }

    function renderSummary(summary) {
      const stats = [
        fmtCost(summary.costUsd),
        summary.turns ? summary.turns + ' turns' : '',
        fmtDuration(summary.durationMs),
      ].filter(Boolean);
      let html = '<div class="summary' + (summary.isError ? ' is-error' : '') + '">';
      html += '<div class="summary-label">' + (summary.isError ? 'run failed' : 'run finished') + '</div>';
      html += '<div class="summary-text">' + esc(summary.text) + '</div>';
      if (stats.length) {
        html += '<div class="stats">' + stats.map(function (stat) {
          return '<span class="stat-chip">' + esc(stat) + '</span>';
        }).join('') + '</div>';
      }
      html += '</div>';
      return html;
    }

    function renderActions(run) {
      const actions = run.phaseActions;
      const running = run.status === 'running';
      const show = !running && actions && (
        actions.artifactPath || actions.approve || actions.runNextPhase || actions.runImpl);
      if (!show) return '';
      let html = '<div class="button-row">';
      if (actions.artifactPath) html += button('openArtifact', run.id, 'Open artifact', true);
      if (actions.approve) html += button('approve', run.id, 'Approve ' + actions.approve.label, false, actions.approve.phase);
      if (actions.runNextPhase) html += button('runPhase', run.id, 'Run next: ' + actions.runNextPhase.label, true, actions.runNextPhase.phase);
      if (actions.runImpl) html += button('runImpl', run.id, 'Run implementation', false);
      html += '</div>';
      return html;
    }

    function renderRun(run) {
      const running = run.status === 'running';
      let html = '<div class="run ' + (running ? 'running' : esc(run.status)) + '" id="' + esc(run.id) + '">';
      html += renderHead(run);
      if (running) html += '<div class="progress"><span></span></div>';
      html += '<div class="log">' + renderHistory(run) + renderItems(buildItems(run.segments)) + '</div>';
      if (run.status === 'preview') html += renderResumeBar(run);
      if (run.pending) html += renderPending(run, run.pending);
      if (run.summary && run.summary.text) html += renderSummary(run.summary);
      html += renderActions(run);
      html += '</div>';
      return html;
    }

    const historyByRun = {};
    const openedHistory = {};
    const historyHtmlCache = {};

    function renderHistory(run) {
      const segments = historyByRun[run.id];
      if (!segments || !segments.length) return '';
      const open = openedHistory[run.id] !== undefined
        ? openedHistory[run.id] === true
        : run.status === 'preview';
      let body = '';
      if (open) {
        const key = run.id + ':' + segments.length;
        if (!historyHtmlCache[key]) {
          historyHtmlCache[key] = renderItems(buildItems(segments));
        }
        body = '<div class="history-body">' + historyHtmlCache[key] + '</div>';
      }
      return '<details class="history" data-history-for="' + esc(run.id) + '"' + (open ? ' open' : '') + '>' +
        '<summary>Session history · ' + segments.length + ' entries' +
        (open ? '' : ' — click to expand') + '</summary>' + body + '</details>';
    }

    let latestRuns = {};
    let latestRunList = [];
    const selections = {};
    function render(runs) {
      latestRuns = {};
      latestRunList = runs;
      runs.forEach(function (run) { latestRuns[run.id] = run; });
      const app = document.getElementById('app');

      const previous = {};
      runs.forEach(function (run) {
        const log = document.getElementById(run.id) && document.getElementById(run.id).querySelector('.log');
        if (log) {
          previous[run.id] = {
            top: log.scrollTop,
            atEnd: log.scrollHeight - log.scrollTop - log.clientHeight < 80,
          };
        }
      });

      let header = '<div class="app-header">';
      header += '<span class="app-title">cc-sdd Runs</span>';
      header += '<span class="app-hint">Headless Claude Code runs. Pick agent "claude-console" in settings.</span>';
      if (runs.some(function (run) { return run.status !== 'running'; })) {
        header += '<span class="app-actions"><button class="secondary" data-act="clearFinished">Clear finished</button></span>';
      }
      header += '</div>';

      if (!runs.length) {
        app.innerHTML = header + '<div class="app-hint">No runs yet. Start a phase from the cc-sdd tree.</div>';
        return;
      }

      app.innerHTML = header + runs.map(renderRun).join('');

      runs.forEach(function (run) {
        const element = document.getElementById(run.id);
        const log = element && element.querySelector('.log');
        if (!log) return;
        const before = previous[run.id];
        const tailing = run.status === 'running' || run.status === 'preview';
        if (tailing ? (!before || before.atEnd) : (before ? !before.atEnd : false)) {
          log.scrollTop = log.scrollHeight;
        } else if (before) {
          log.scrollTop = before.top;
        }
      });

      startTimer();
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

    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'state') {
        render(event.data.runs);
      } else if (event.data && event.data.type === 'history') {
        historyByRun[event.data.runId] = event.data.segments || [];
        if (latestRunList.length) render(latestRunList);
      }
    });

    document.getElementById('app').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const input = event.target.closest('.resume-input');
      if (!input) return;
      const runId = input.getAttribute('data-run');
      const button = document.querySelector('[data-act="resumeConsole"][data-run="' + runId + '"]');
      if (button) button.click();
    });

    document.getElementById('app').addEventListener('click', (event) => {
      const historySummary = event.target.closest('details.history > summary');
      if (historySummary) {
        const details = historySummary.parentElement;
        const runId = details.getAttribute('data-history-for');
        const willOpen = !details.open;
        openedHistory[runId] = willOpen;
        if (willOpen && !details.querySelector('.history-body')) {
          const body = document.createElement('div');
          body.className = 'history-body';
          body.innerHTML = renderItems(buildItems(historyByRun[runId] || []));
          details.appendChild(body);
          const segments = historyByRun[runId] || [];
          historySummary.textContent = 'Session history · ' + segments.length + ' entries';
        }
        return;
      }

      const target = event.target.closest('[data-act]');
      if (!target) return;
      const act = target.getAttribute('data-act');

      if (act === 'resumeConsole') {
        const runId = target.getAttribute('data-run');
        const input = document.querySelector('.resume-input[data-run="' + runId + '"]');
        const select = document.querySelector('.resume-mode[data-run="' + runId + '"]');
        vscode.postMessage({
          type: 'resumeConsole',
          runId: runId,
          instruction: input ? input.value : '',
          permissionMode: select ? select.value : undefined,
        });
        return;
      }

      if (act === 'option') {
        const runId = target.getAttribute('data-run');
        const pendingId = target.getAttribute('data-pending');
        const questionIndex = Number(target.getAttribute('data-q'));
        const label = target.getAttribute('data-label');
        const run = latestRuns[runId];
        const pending = run && run.pending;
        if (!pending || !pending.questions) return;
        selections[pendingId] = selections[pendingId] || {};
        selections[pendingId][questionIndex] = label;
        const group = target.closest('.question');
        if (group) {
          group.querySelectorAll('.option.selected').forEach(function (element) {
            element.classList.remove('selected');
          });
        }
        target.classList.add('selected');
        if (Object.keys(selections[pendingId]).length === pending.questions.length) {
          const labels = pending.questions.map(function (question, index) {
            return selections[pendingId][index];
          });
          delete selections[pendingId];
          vscode.postMessage({ type: 'answer', runId: runId, pendingId: pendingId, labels: labels });
        }
        return;
      }

      vscode.postMessage({
        type: act,
        runId: target.getAttribute('data-run'),
        phase: target.getAttribute('data-phase') || undefined,
        pendingId: target.getAttribute('data-pending') || undefined,
        decision: target.getAttribute('data-decision') || undefined,
      });
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
