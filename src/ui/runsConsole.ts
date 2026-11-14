// "cc-sdd Runs" webview console: shows live progress of headless claude runs.
import * as vscode from 'vscode';
import { promises as fsPromises } from 'node:fs';
import * as path from 'node:path';
import {
  applyRunEvent,
  startClaudeRun,
  type ClaudeRunHandle,
  type PhaseActions,
  type PhaseActionTarget,
  type RunSegment,
  type RunState,
  type TokenUsage,
} from '../run/claudeRunner';
import { webviewThemeCss } from './webviewTheme';

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
  getRunsDir: () => string | undefined;
  openOverview?: () => void;
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
  // Each panel owns exactly one run; closing a tab does not cancel its runner.
  private panels = new Map<vscode.WebviewPanel, string>();
  private runs: RunState[] = [];
  private seq = 0;
  private handles = new Map<string, ClaudeRunHandle>();
  private deliveredHistory = new Map<vscode.WebviewPanel, Set<string>>();
  private updateTimer?: NodeJS.Timeout;
  private readonly changed = new vscode.EventEmitter<void>();

  /** Fires when the run list or a run's state changes (coalesced with updates). */
  readonly onDidChange = this.changed.event;

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
    this.trimRuns();

    this.attachRunner(run, {
      prompt: input.prompt,
      permissionMode: input.permissionMode,
      resume: input.resume,
    });

    this.openRunTab(run.id);
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
    run.usage = undefined;
    run.usageCostUsd = undefined;
    run.turnUsage = undefined;
    run.permissionDenials = undefined;
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
    const rank = (run: RunState): number => (run.pending ? 0 : run.status === 'running' ? 1 : 2);
    const runs = [...this.runs].sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt);
    if (!runs.length) {
      void vscode.window.showInformationMessage(
        'cc-sdd: no runs yet. Start a phase from Specs or open a session from Sessions.',
      );
      return;
    }
    if (runs.length === 1) {
      this.openRun(runs[0].id);
      return;
    }
    void vscode.window
      .showQuickPick(
        runs.map((run) => ({
          label: run.feature || run.skill,
          description: `${this.stageLabel(run.skill)} · ${run.pending ? 'Input waiting' : run.status}`,
          detail: new Date(run.startedAt).toLocaleString(),
          runId: run.id,
        })),
        { placeHolder: 'Open a run tab — waiting runs first', matchOnDescription: true },
      )
      .then((picked) => {
        if (picked) this.openRun(picked.runId);
      });
  }

  /** Read-only view for the overview board (history is dropped). */
  getRuns(): RunState[] {
    return this.runs.map((run) => ({ ...run, history: undefined }));
  }

  /** Opens the single-run tab, creating it if needed. */
  openRun(runId: string): void {
    this.openRunTab(runId);
    this.updateAll();
  }

  /** Continues a finished run in place by resuming its Claude session. */
  private continueRun(run: RunState, instruction: string, permissionMode: string): void {
    if (!run.sessionId) {
      void vscode.window.showWarningMessage(
        'cc-sdd: this run has no session id, so it cannot be continued. Use Re-run instead.',
      );
      return;
    }
    if (this.handles.has(run.id)) {
      return;
    }
    const prompt = instruction.trim() || 'Continue from where you left off.';
    run.status = 'running';
    run.permissionMode = permissionMode;
    run.prompt = prompt;
    run.summary = undefined;
    run.phaseActions = undefined;
    run.pending = undefined;
    run.endedAt = undefined;
    run.startedAt = Date.now();
    run.segments.push({ kind: 'system', text: `continued · ${prompt}` });
    this.attachRunner(run, { prompt, permissionMode, resume: run.sessionId });
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
    usage?: TokenUsage;
    costUsd?: number;
  }): void {
    const existing = this.runs.find(
      (run) => run.preview?.sessionId === input.sessionId || run.sessionId === input.sessionId,
    );
    if (existing) {
      this.openRun(existing.id);
      return;
    }
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
      usage: input.usage,
      usageCostUsd: input.costUsd,
      preview: {
        sessionId: input.sessionId,
        filePath: input.filePath,
        defaultPermissionMode: input.defaultPermissionMode,
      },
      startedAt: Date.now(),
    };
    this.runs.push(run);
    this.trimRuns();
    this.openRunTab(run.id);
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
    this.changed.dispose();
  }

  private stageLabel(skill: string): string {
    const labels: Record<string, string> = {
      'kiro-spec-requirements': 'Requirements',
      'kiro-spec-design': 'Design',
      'kiro-spec-tasks': 'Task planning',
      'kiro-impl': 'Implementation',
      'kiro-validate-impl': 'Verification',
      'kiro-validate-gap': 'Gap check',
      'kiro-validate-design': 'Design check',
      'kiro-steering': 'Steering',
      'kiro-discovery': 'Discovery',
      'kiro-spec-init': 'Spec init',
      session: 'Session',
    };
    return labels[skill] ?? skill.replace(/^kiro-/, '');
  }

  private trimRuns(): void {
    // Keep every live run and every open tab, even when there are over 30.
    const openIds = new Set(this.panels.values());
    for (const run of [...this.runs]) {
      if (this.runs.length <= RUN_LIMIT) break;
      if (
        run.status === 'running' ||
        run.pending ||
        this.handles.has(run.id) ||
        openIds.has(run.id)
      )
        continue;
      this.runs = this.runs.filter((candidate) => candidate.id !== run.id);
    }
  }

  private openRunTab(runId: string): void {
    const run = this.byId(runId);
    if (!run) {
      return;
    }
    const existing = [...this.panels.entries()].find(([, filter]) => filter === runId);
    if (existing) {
      existing[0].reveal(undefined, false);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'ccSdd.run',
      `${run.feature || 'Run'} · ${this.stageLabel(run.skill)}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );
    this.attachPanel(panel, runId);
  }

  private attachPanel(panel: vscode.WebviewPanel, filter: string): void {
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
    const runId = this.panels.get(panel);
    for (const run of this.runs) {
      if (run.id !== runId || !run.history?.length || delivered.has(run.id)) {
        continue;
      }
      delivered.add(run.id);
      void panel.webview.postMessage({ type: 'history', runId: run.id, segments: run.history });
    }
  }

  private pushTo(panel: vscode.WebviewPanel): void {
    const filter = this.panels.get(panel);
    const list = this.runs.filter((run) => run.id === filter);
    const run = list[0];
    if (run)
      panel.title = `${run.feature || 'Run'} · ${this.stageLabel(run.skill)}${run.pending ? ' · Input waiting' : ''}`;
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
      this.changed.fire();
    }, 80);
  }

  private byId(runId: unknown): RunState | undefined {
    if (typeof runId !== 'string') {
      return undefined;
    }
    return this.runs.find((run) => run.id === runId);
  }

  private handleMessage(panel: vscode.WebviewPanel, message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const typed = message as ConsoleMessage;
    const owner = this.panels.get(panel);
    if (typed.runId !== undefined && typed.runId !== owner) return;
    const run = this.byId(typed.runId);

    switch (typed.type) {
      case 'ready':
        // Initial postMessage calls may precede the webview's message listener.
        this.deliveredHistory.delete(panel);
        this.pushTo(panel);
        this.pushHistoryTo(panel);
        return;
      case 'overview':
        this.options.openOverview?.();
        return;
      case 'copy':
        if (run) {
          void vscode.env.clipboard.writeText(run.prompt);
          void vscode.window.showInformationMessage('cc-sdd: prompt copied.');
        }
        return;
      case 'close':
        panel.dispose();
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
              : (run.preview.defaultPermissionMode ?? 'default');
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
      case 'continue':
        if (run) {
          const instruction = typeof typed.instruction === 'string' ? typed.instruction : '';
          const mode =
            typeof typed.permissionMode === 'string' && typed.permissionMode
              ? typed.permissionMode
              : run.permissionMode;
          this.continueRun(run, instruction, mode);
        }
        return;
      case 'trace':
        if (run) {
          if (run.preview) {
            void this.saveSessionTrace(run);
          } else {
            void this.saveTrace(run);
          }
        }
        return;
      case 'exportSession':
        if (run) {
          void this.saveSessionTrace(run);
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

  private async saveTrace(run: RunState): Promise<void> {
    const dir = this.options.getRunsDir();
    if (!dir) {
      void vscode.window.showErrorMessage('cc-sdd: open a workspace first.');
      return;
    }
    try {
      await fsPromises.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const label = `${run.skill}-${run.feature || 'run'}`.replace(/[^A-Za-z0-9._-]+/g, '-');
      const filePath = path.join(dir, `${stamp}-${label}.json`);
      const payload = {
        savedAt: new Date().toISOString(),
        snapshot: run.status === 'running',
        run,
      };
      await fsPromises.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await this.options.openPath(filePath);
      void vscode.window.showInformationMessage('cc-sdd: run trace saved.');
    } catch (error) {
      void vscode.window.showErrorMessage(
        `cc-sdd: could not save run trace: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async saveSessionTrace(run: RunState): Promise<void> {
    const dir = this.options.getRunsDir();
    if (!dir || !run.preview) {
      void vscode.window.showErrorMessage('cc-sdd: open a workspace first.');
      return;
    }
    try {
      await fsPromises.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filePath = path.join(dir, `session-${stamp}-${run.preview.sessionId.slice(0, 8)}.json`);
      const payload = {
        savedAt: new Date().toISOString(),
        session: {
          id: run.preview.sessionId,
          filePath: run.preview.filePath,
          title: run.feature || run.skill,
          usage: run.usage,
          costUsd: run.usageCostUsd,
          history: run.history,
        },
      };
      await fsPromises.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await this.options.openPath(filePath);
      void vscode.window.showInformationMessage('cc-sdd: session trace saved.');
    } catch (error) {
      void vscode.window.showErrorMessage(
        `cc-sdd: could not save session trace: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Saves the most recent run or session preview (command palette entry point). */
  saveLastTrace(): void {
    const latest = this.runs[this.runs.length - 1];
    if (!latest) {
      void vscode.window.showInformationMessage(
        'cc-sdd: no run to save yet. Run a phase or open a session first.',
      );
      return;
    }
    if (latest.preview) {
      void this.saveSessionTrace(latest);
      return;
    }
    void this.saveTrace(latest);
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
    ${webviewThemeCss}

    /* Runs console: one neutral ramp, mono figures, calm surfaces. */
    :root {
      --cc-ease: cubic-bezier(.2, 0, 0, 1);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 0; height: 100vh; overflow: hidden;
      font-family: var(--vscode-font-family);
      font-size: 13px; line-height: 1.5;
      color: var(--cc-fg); background: var(--cc-bg);
    }
    #app { height: 100vh; display: flex; flex-direction: column; }

    /* A single run fills the editor tab. */
    .runs {
      flex: 1 1 auto; min-height: 0; overflow-y: auto;
      padding: 0; display: flex; flex-direction: column; gap: 0;
    }
    .run {
      position: relative; flex: none; display: flex; flex-direction: column;
      border: 0; border-radius: 0;
      background: transparent; overflow: hidden;
    }
    .runs > .run:only-child { flex: 1 1 auto; min-height: 0; }
    .runs > .run:only-child .log { flex: 1 1 auto; max-height: none; }

    /* Run header */
    .head {
      flex: none; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      min-height: 44px; padding: 8px 12px 8px 16px;
      border-bottom: 1px solid var(--cc-border); background: transparent;
    }
    .title { font-size: 14px; font-weight: 500; line-height: 1.3; }
    .skilltag { font-family: var(--cc-mono); font-size: 11px; color: var(--cc-muted); }
    .status-text { font-size: 12px; font-weight: 500; color: var(--cc-muted); }
    .status-text.attention, .status-text.preview { color: var(--cc-accent-ink); }
    .status-text.running { color: var(--cc-warn-ink); }
    .status-text.done { color: var(--cc-success-ink); }
    .status-text.error { color: var(--cc-error-ink); }
    .mode, .elapsed, .usage {
      font-family: var(--cc-mono); font-size: 11px;
      color: var(--cc-muted); font-variant-numeric: tabular-nums;
    }
    .spacer { flex: 1; }
    .head button { min-height: 26px; padding: 0 10px; }
    .head .text-button { min-height: 26px; padding: 0 4px; }

    /* Live trace line above the log. Transform only, one easing curve. */
    .progress {
      flex: none; height: 2px; background: var(--cc-border);
      position: relative; overflow: hidden;
    }
    .progress span {
      position: absolute; top: 0; bottom: 0; left: 0; width: 26%;
      background: var(--cc-accent);
      animation: trace 1.6s var(--cc-ease) infinite;
    }
    @keyframes trace {
      from { transform: translateX(-110%); }
      to { transform: translateX(490%); }
    }

    /* Log */
    .log {
      margin: 0; position: relative; flex: none;
      padding: 12px 16px 16px;
      display: flex; flex-direction: column; gap: 8px;
      min-height: 120px; max-height: 380px; overflow-y: auto;
      font-size: 13px; line-height: 1.65;
    }
    .event.system {
      display: flex; align-items: center; gap: 8px;
      color: var(--cc-muted); font-family: var(--cc-mono); font-size: 11px;
    }
    .event.toolresult {
      font-family: var(--cc-mono); font-size: 11px;
      color: var(--cc-muted); white-space: pre-wrap; word-break: break-word;
    }

    details.tool { border-bottom: 1px solid var(--cc-border); }
    details.tool:last-child { border-bottom: none; }
    details.tool > summary {
      display: flex; align-items: center; gap: 8px; min-height: 32px;
      padding: 4px 0; cursor: pointer; list-style: none;
    }
    details.tool > summary::-webkit-details-marker { display: none; }
    details.tool > summary::before {
      content: "\\203a"; width: 10px; flex: none;
      color: var(--cc-muted); font-weight: 600;
      transition: transform .12s var(--cc-ease);
    }
    details.tool[open] > summary::before { transform: rotate(90deg); }
    details.tool.no-body > summary { cursor: default; }
    details.tool.no-body > summary::before { display: none; }

    .chip {
      flex: none; width: 64px; overflow: hidden;
      font-family: var(--cc-mono); font-size: 11px; font-weight: 500;
      color: var(--cc-muted); white-space: nowrap; text-overflow: ellipsis;
    }
    .tool-summary {
      flex: 1; min-width: 0; overflow: hidden;
      font-family: var(--cc-mono); font-size: 12px; color: var(--cc-fg);
      white-space: nowrap; text-overflow: ellipsis;
    }
    .badge { flex: none; font-family: var(--cc-mono); font-size: 11px; }
    .badge.error { color: var(--cc-error-ink); }
    .tool-output {
      margin: 4px 0 12px; padding: 8px 12px; max-height: 240px; overflow: auto;
      font-family: var(--cc-mono); font-size: 12px; line-height: 1.5;
      color: var(--cc-fg); white-space: pre-wrap; word-break: break-word;
      background: var(--cc-surface); border: 1px solid var(--cc-border);
      border-radius: var(--cc-radius-sm);
    }

    /* Prose and history */
    .prose { color: var(--cc-fg); font-size: 13px; line-height: 1.65; }
    .prose p { margin: 0 0 8px; }
    .prose h1, .prose h2, .prose h3, .prose h4 {
      margin: 12px 0 6px; font-weight: 600; line-height: 1.35;
    }
    .prose h1 { font-size: 16px; } .prose h2 { font-size: 15px; }
    .prose h3 { font-size: 14px; } .prose h4 { font-size: 13px; }
    .prose ul, .prose ol { margin: 4px 0 8px 20px; padding: 0; }
    .prose li { margin: 2px 0; }
    .prose code {
      font-family: var(--cc-mono); font-size: 12px;
      background: var(--cc-surface-strong); border: 1px solid var(--cc-border);
      border-radius: 4px; padding: 0 4px;
    }
    .prose pre.code {
      margin: 6px 0 10px; padding: 10px 12px; border-radius: var(--cc-radius-sm);
      background: var(--vscode-textCodeBlock-background, var(--cc-surface));
      border: 1px solid var(--cc-border); overflow: auto; max-height: 320px;
      font-family: var(--cc-mono); font-size: 12px; line-height: 1.5;
    }
    .prose pre.code code { background: none; border: none; padding: 0; font-size: inherit; }
    .prose strong { font-weight: 600; }
    .prose table { border-collapse: collapse; margin: 6px 0 10px; font-size: 12px; }
    .prose th, .prose td {
      border: 1px solid var(--cc-border); padding: 4px 10px;
      text-align: left; vertical-align: top;
    }
    .prose th { background: var(--cc-surface-strong); font-weight: 600; }

    .history {
      border: 0; border-radius: 0; background: transparent;
    }
    .history > summary {
      display: flex; align-items: center; gap: 8px;
      cursor: pointer; padding: 4px 0; list-style: none;
      font-size: 12px; font-weight: 500; color: var(--cc-muted);
    }
    .history > summary::-webkit-details-marker { display: none; }
    .history > summary::before {
      content: "\\203a"; width: 10px; flex: none;
      transition: transform .12s var(--cc-ease);
    }
    .history[open] > summary::before { transform: rotate(90deg); }
    .history[open] > summary { border-bottom: 0; }
    .history-body {
      position: relative; padding: 8px 0;
      display: flex; flex-direction: column; gap: 8px;
    }

    .event.user { display: flex; gap: 8px; align-items: flex-start; }
    .user-badge {
      flex: none; width: 36px; margin-top: 2px;
      font-family: var(--cc-mono); font-size: 11px; color: var(--cc-muted);
    }
    .event.user .prose { flex: 1; min-width: 0; }

    .errorline {
      color: var(--cc-error-ink); font-family: var(--cc-mono); font-size: 12px;
      background: color-mix(in srgb, var(--cc-error) 6%, transparent);
      border: 1px solid color-mix(in srgb, var(--cc-error) 30%, transparent);
      border-radius: var(--cc-radius-sm); padding: 6px 10px;
      white-space: pre-wrap; word-break: break-word;
    }

    /* The one surface that asks for a decision. */
    .pending {
      margin: 0 16px 16px; padding: 12px 16px;
      border: 1px solid var(--cc-border);
      border-left: 2px solid var(--cc-accent);
      border-radius: var(--cc-radius); background: var(--cc-surface);
    }
    .pending-kind {
      margin-bottom: 6px; font-size: 12px; font-weight: 500;
      color: var(--cc-accent-ink);
    }
    .pending-title { margin-bottom: 6px; font-size: 14px; font-weight: 600; }
    .pending-detail {
      margin-bottom: 12px; font-family: var(--cc-mono); font-size: 12px;
      color: var(--cc-muted); white-space: pre-wrap; word-break: break-word;
    }
    .pending-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .question { margin-bottom: 12px; }
    .question:last-of-type { margin-bottom: 8px; }
    .option {
      display: block; width: 100%; text-align: left; margin: 4px 0; padding: 8px 12px;
      background: var(--cc-card); color: var(--cc-fg);
      border: 1px solid var(--cc-border); border-radius: var(--cc-radius-sm);
      cursor: pointer; font-family: var(--vscode-font-family); font-size: 13px;
    }
    .option:hover { background: var(--cc-surface-strong); border-color: var(--cc-border-strong); }
    .option.selected {
      border-color: var(--cc-accent);
      background: color-mix(in srgb, var(--cc-accent) 7%, transparent);
    }
    .option .optdesc { display: block; margin-top: 2px; font-size: 12px; color: var(--cc-muted); }
    .options-hint { font-size: 12px; color: var(--cc-muted); }

    /* Session usage: a quiet status bar, not a card. */
    .usage-bar {
      display: flex; align-items: baseline; flex-wrap: wrap;
      gap: 4px 12px; padding: 8px 16px;
      border-top: 1px solid var(--cc-border);
      font-family: var(--cc-mono); font-size: 11px;
      color: var(--cc-muted); font-variant-numeric: tabular-nums;
    }
    .usage-label { color: var(--cc-muted); }
    .usage-bar .stat { white-space: nowrap; }

    /* Finished-run receipt */
    .summary {
      margin: 0; padding: 12px 16px;
      border: 0; border-top: 1px solid var(--cc-border); border-radius: 0;
      background: transparent;
    }
    .summary.is-error { border-color: color-mix(in srgb, var(--cc-error) 30%, transparent); }
    .summary-label {
      margin-bottom: 6px; font-size: 12px; font-weight: 500;
      color: var(--cc-muted);
    }
    .summary.is-error .summary-label { color: var(--cc-error-ink); }
    .summary-text { white-space: pre-wrap; word-break: break-word; line-height: 1.6; }
    .stats {
      display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px;
      margin-top: 10px; font-family: var(--cc-mono); font-size: 11px;
      color: var(--cc-muted); font-variant-numeric: tabular-nums;
    }
    .summary-actions { margin-top: 12px; }

    .metrics {
      margin: 0 16px 12px; border: 1px solid var(--cc-border);
      border-radius: var(--cc-radius-sm); background: var(--cc-surface);
    }
    .metrics > summary {
      display: flex; align-items: center; gap: 8px;
      cursor: pointer; padding: 4px 0; list-style: none;
      font-size: 12px; font-weight: 500; color: var(--cc-muted);
    }
    .metrics > summary::-webkit-details-marker { display: none; }
    .metrics > summary::before {
      content: "\\203a"; width: 10px; flex: none;
      transition: transform .12s var(--cc-ease);
    }
    .metrics[open] > summary::before { transform: rotate(90deg); }
    .metrics[open] > summary { border-bottom: 1px solid var(--cc-border); }
    .metrics-body { padding: 4px 12px 8px; overflow-x: auto; }
    .metrics table {
      width: 100%; border-collapse: collapse;
      font-family: var(--cc-mono); font-size: 11px; font-variant-numeric: tabular-nums;
    }
    .metrics th, .metrics td {
      padding: 4px 8px; border-bottom: 1px solid var(--cc-border);
      text-align: right; white-space: nowrap;
    }
    .metrics th:first-child, .metrics td:first-child,
    .metrics th:nth-child(2), .metrics td:nth-child(2) { text-align: left; }
    .metrics th { color: var(--cc-muted); font-weight: 500; }
    .metrics tr:last-child td { border-bottom: none; }

    .button-row { display: flex; gap: 8px; flex-wrap: wrap; padding: 0 16px 16px; }

    .resume-bar {
      display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
      padding: 12px 16px; border-top: 1px solid var(--cc-border);
      background: var(--cc-surface);
    }
    .resume-input { flex: 1 1 320px; min-width: 180px; }
    .resume-mode { flex: none; }

    @media (max-width: 720px) {
      .app-header { padding: 0 16px; }
      .app-hint, .app-counts { display: none; }
      .runs { padding: 12px; gap: 12px; }
      .mode, .usage { display: none; }
    }

    @media (prefers-reduced-motion: reduce) {
      .progress span { animation: none; width: 100%; opacity: .25; }
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
      if (typeof ms !== 'number' || ms < 0) return '';
      if (ms < 1000) return Math.round(ms) + 'ms';
      const s = ms / 1000;
      return s < 60 ? s.toFixed(1) + 's' : Math.floor(s / 60) + 'm' + Math.round(s % 60) + 's';
    };
    const fmtCost = (cost) => (typeof cost === 'number' ? '$' + cost.toFixed(cost < 1 ? 3 : 2) : '');
    const fmtTokens = (value) => {
      const number = Number(value) || 0;
      if (number >= 1000000) return (number / 1000000).toFixed(1) + 'M';
      if (number >= 1000) return (number / 1000).toFixed(1) + 'k';
      return String(Math.round(number));
    };

    function button(act, runId, label, secondary, phase) {
      const attrs = 'data-act="' + esc(act) + '" data-run="' + esc(runId) + '"' +
        (phase ? ' data-phase="' + esc(phase) + '"' : '');
      return '<button ' + attrs + (secondary ? ' class="secondary"' : '') + '>' + esc(label) + '</button>';
    }

    function textButton(act, runId, label, phase) {
      const attrs = 'data-act="' + esc(act) + '" data-run="' + esc(runId) + '"' +
        (phase ? ' data-phase="' + esc(phase) + '"' : '');
      return '<button class="text-button" ' + attrs + '>' + esc(label) + '</button>';
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
          const hasBody = item.result !== '' && item.result.trim() !== '';
          html += '<details class="event tool' + (hasBody ? '' : ' no-body') + '">';
          html += '<summary><span class="chip" title="' + esc(item.name) + '">' + esc(item.name) + '</span>';
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

    function statusLabel(status) {
      if (status === 'error') return 'Failed';
      if (status === 'done') return 'Done';
      if (status === 'cancelled') return 'Cancelled';
      if (status === 'preview') return 'Preview';
      return 'Running';
    }

    function renderHead(run) {
      const running = run.status === 'running';
      const preview = run.status === 'preview';
      const pending = !!run.pending;
      const tone = pending ? 'attention' : run.status;
      const label = pending ? 'Needs you' : statusLabel(run.status);
      const duration = running || preview
        ? ''
        : fmtDuration((run.endedAt || Date.now()) - run.startedAt);

      let html = '<div class="head">';
      html += '<span class="lamp ' + esc(tone) + '"></span>';
      html += '<span class="skilltag">/' + esc(run.skill) + '</span>';
      html += '<span class="status-text ' + esc(tone) + '">' + esc(label) + '</span>';
      html += '<span class="mode" title="Permission mode">' + esc(run.permissionMode) + '</span>';
      const usage = (run.summary && run.summary.usage) || run.usage;
      if (usage && (usage.inputTokens || usage.outputTokens || usage.cacheReadTokens)) {
        html += '<span class="usage" title="Tokens in and out">' +
          fmtTokens(usage.inputTokens) + ' in · ' + fmtTokens(usage.outputTokens) + ' out</span>';
      }
      if (running) {
        html += '<span class="elapsed" data-start="' + run.startedAt + '">' +
          fmtDuration(Date.now() - run.startedAt) + '</span>';
      } else if (duration) {
        html += '<span class="elapsed">' + esc(duration) + '</span>';
      }
      html += '<span class="spacer"></span>';
      html += textButton('overview', run.id, 'Overview');
      if (preview) {
        html += textButton('trace', run.id, 'Trace');
        html += textButton('close', run.id, 'Close');
      } else {
        html += textButton('copy', run.id, 'Copy prompt');
        if (running) {
          html += textButton('trace', run.id, 'Trace');
          html += button('cancel', run.id, 'Cancel', true);
        } else {
          html += button('rerun', run.id, 'Re-run', true);
          html += textButton('trace', run.id, 'Trace');
          html += textButton('close', run.id, 'Close');
        }
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
        '" placeholder="Message to continue" />' +
        '<select class="resume-mode" data-run="' + esc(run.id) + '">' + options + '</select>' +
        '<button class="secondary" data-act="resumeConsole" data-run="' + esc(run.id) + '">Resume in console</button>' +
        '<button class="secondary" data-act="resumeTerminal" data-run="' + esc(run.id) + '">Terminal</button>' +
        '</div>';
    }

    function renderContinueBar(run) {
      const modes = ['default', 'acceptEdits', 'bypassPermissions', 'plan'];
      const preferred = modes.indexOf(run.permissionMode) >= 0 ? run.permissionMode : 'default';
      let options = '';
      modes.forEach(function (mode) {
        options += '<option value="' + esc(mode) + '"' +
          (mode === preferred ? ' selected' : '') + '>' + esc(mode) + '</option>';
      });
      return '<div class="resume-bar">' +
        '<input class="resume-input continue-input" data-run="' + esc(run.id) +
        '" placeholder="Message to continue" />' +
        '<select class="resume-mode" data-run="' + esc(run.id) + '">' + options + '</select>' +
        '<button class="secondary" data-act="continue" data-run="' + esc(run.id) + '">Send</button>' +
        '</div>';
    }

    function renderPending(run, pending) {
      if (pending.kind === 'permission') {
        let html = '<div class="pending">';
        html += '<div class="pending-kind">Permission required</div>';
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
      html += '<div class="pending-kind">Question</div>';
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
        html += '<div class="options-hint">Answer every question to continue</div>';
      }
      html += '</div>';
      return html;
    }

    function renderTurnMetrics(run) {
      const turns = (run.turnUsage || []).slice(-100);
      if (turns.length < 2) return '';
      const rows = turns.map(function (turn, index) {
        const previous = index > 0 ? turns[index - 1].at : undefined;
        const gap = turn.at && previous ? fmtDuration(turn.at - previous) : '';
        return '<tr><td>' + (index + 1) + '</td><td>' + esc(turn.model || '') + '</td>' +
          '<td>' + fmtTokens(turn.inputTokens) + '</td>' +
          '<td>' + fmtTokens(turn.outputTokens) + '</td>' +
          '<td>' + fmtTokens(turn.cacheReadTokens) + '</td>' +
          '<td>' + fmtTokens(turn.cacheCreationTokens) + '</td>' +
          '<td>' + esc(gap) + '</td></tr>';
      }).join('');
      return '<details class="metrics"><summary>Token usage · ' + turns.length + ' turns</summary>' +
        '<div class="metrics-body"><table><thead><tr>' +
        '<th>#</th><th>Model</th><th>In</th><th>Out</th><th>Cache read</th><th>Cache write</th><th>Gap</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div></details>';
    }

    function renderSummary(run) {
      const summary = run.summary;
      const usage = (summary && summary.usage) || run.usage;
      const costUsd = summary && typeof summary.costUsd === 'number'
        ? summary.costUsd
        : run.usageCostUsd;
      const stats = [];
      if (usage) {
        stats.push(fmtTokens(usage.inputTokens) + ' in');
        stats.push(fmtTokens(usage.outputTokens) + ' out');
        if (usage.cacheReadTokens) stats.push(fmtTokens(usage.cacheReadTokens) + ' cache read');
        if (usage.cacheCreationTokens) stats.push(fmtTokens(usage.cacheCreationTokens) + ' cache write');
      }
      if (typeof costUsd === 'number') stats.push(fmtCost(costUsd));
      if (summary && summary.turns) stats.push(summary.turns + ' turns');
      if (summary && summary.durationMs) stats.push(fmtDuration(summary.durationMs));
      if (run.permissionDenials) stats.push('denied ' + run.permissionDenials);
      if (summary && summary.stopReason && summary.stopReason !== 'end_turn') {
        stats.push('stop: ' + summary.stopReason);
      }

      const text = summary && summary.text ? summary.text : '';
      if (!text && stats.length === 0) return '';

      if (run.status === 'preview') {
        return '<div class="usage-bar"><span class="usage-label">Session usage</span>' +
          stats.map(function (stat) {
            return '<span class="stat">' + esc(stat) + '</span>';
          }).join('') + '</div>';
      }

      const failed = (summary && summary.isError) || run.status === 'error';
      const label = run.status === 'cancelled'
        ? 'Run cancelled'
        : (failed ? 'Run failed' : 'Run finished');
      let html = '<div class="summary' + (failed ? ' is-error' : '') + '">';
      html += '<div class="summary-label">' + label + '</div>';
      if (text) html += '<div class="summary-text">' + esc(text) + '</div>';
      if (stats.length) {
        html += '<div class="stats">' + stats.map(function (stat) {
          return '<span class="stat">' + esc(stat) + '</span>';
        }).join('') + '</div>';
      }
      html += '<div class="summary-actions">' +
        textButton('trace', run.id, 'Save trace') + '</div>';
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
      html += '<div class="log">' +
        renderHistory(run) + renderItems(buildItems(run.segments)) + '</div>';
      if (run.status === 'preview') html += renderResumeBar(run);
      if (run.pending) html += renderPending(run, run.pending);
      if (!running) {
        html += renderTurnMetrics(run);
        html += renderSummary(run);
      }
      html += renderActions(run);
      if (!running && run.status !== 'preview' && run.sessionId) {
        html += renderContinueBar(run);
      }
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
        '<summary>Session history · ' + segments.length + ' entries</summary>' + body + '</details>';
    }

    let latestRuns = {};
    let latestRunList = [];
    const selections = {};
    function render(runs) {
      latestRuns = {};
      latestRunList = runs;
      runs.forEach(function (run) { latestRuns[run.id] = run; });
      const app = document.getElementById('app');
      const scroll = document.querySelector('.runs');
      const scrollTop = scroll ? scroll.scrollTop : 0;

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

      const header = '';

      if (!runs.length) {
        app.innerHTML = header + '<div class="runs"><div class="empty-state">' +
          '<p class="empty-title">No runs yet</p>' +
          '<p class="empty-body">Start a phase from the cc-sdd tree. The log appears here while the agent works.</p>' +
          '</div></div>';
        return;
      }

      app.innerHTML = header + '<div class="runs">' + runs.map(renderRun).join('') + '</div>';

      const nextScroll = app.querySelector('.runs');
      if (nextScroll && scrollTop) {
        nextScroll.scrollTop = scrollTop;
      }

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
      const button = document.querySelector(
        '[data-act="resumeConsole"][data-run="' + runId + '"], [data-act="continue"][data-run="' + runId + '"]',
      );
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

      if (act === 'continue') {
        const runId = target.getAttribute('data-run');
        const input = document.querySelector('.continue-input[data-run="' + runId + '"]');
        const select = document.querySelector('.resume-mode[data-run="' + runId + '"]');
        vscode.postMessage({
          type: 'continue',
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
