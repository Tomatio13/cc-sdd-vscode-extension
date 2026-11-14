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
  extensionUri?: vscode.Uri;
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
  const alphabet =
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  for (let index = 0; index < 24; index += 1) {
    text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return text;
};

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
      segments: [{ kind: 'user', text: input.prompt }],
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
  private resumePreview(
    run: RunState,
    instruction: string,
    permissionMode: string,
  ): void {
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
      {
        kind: 'user',
        text: instruction.trim() || 'Continue from where you left off.',
      },
    ];
    this.attachRunner(run, {
      prompt: instruction.trim() || 'Continue from where you left off.',
      permissionMode,
      resume: sessionId,
    });
    this.updateAll();
  }

  show(): void {
    const rank = (run: RunState): number =>
      run.pending ? 0 : run.status === 'running' ? 1 : 2;
    const runs = [...this.runs].sort(
      (a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt,
    );
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
        {
          placeHolder: 'Open a run tab — waiting runs first',
          matchOnDescription: true,
        },
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
  private continueRun(
    run: RunState,
    instruction: string,
    permissionMode: string,
  ): void {
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
    run.segments.push({ kind: 'user', text: prompt });
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
      (run) =>
        run.preview?.sessionId === input.sessionId ||
        run.sessionId === input.sessionId,
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
    const existing = [...this.panels.entries()].find(
      ([, filter]) => filter === runId,
    );
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
    panel.webview.onDidReceiveMessage((message: unknown) =>
      this.handleMessage(panel, message),
    );
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
      void panel.webview.postMessage({
        type: 'history',
        runId: run.id,
        segments: run.history,
      });
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
        if (
          !run ||
          run.pending?.kind !== 'permission' ||
          typed.pendingId !== run.pending.id
        ) {
          return;
        }
        const decision = typed.decision;
        if (
          decision === 'allow' ||
          decision === 'always' ||
          decision === 'deny'
        ) {
          this.handles
            .get(run.id)
            ?.respondPermission(typed.pendingId, decision);
          run.pending = undefined;
          this.updateAll();
        }
        return;
      }
      case 'answer': {
        if (
          !run ||
          typeof typed.pendingId !== 'string' ||
          typed.pendingId !== run.pending?.id ||
          !run.pending?.questions
        ) {
          return;
        }
        const labels = Array.isArray(typed.labels)
          ? typed.labels.filter(
              (label): label is string => typeof label === 'string',
            )
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
          const instruction =
            typeof typed.instruction === 'string' ? typed.instruction : '';
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
          const instruction =
            typeof typed.instruction === 'string' ? typed.instruction : '';
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
      run.phaseActions = await this.options.getPhaseActions(
        run.skill,
        run.feature,
      );
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
      const label = `${run.skill}-${run.feature || 'run'}`.replace(
        /[^A-Za-z0-9._-]+/g,
        '-',
      );
      const filePath = path.join(dir, `${stamp}-${label}.json`);
      const payload = {
        savedAt: new Date().toISOString(),
        snapshot: run.status === 'running',
        run,
      };
      await fsPromises.writeFile(
        filePath,
        `${JSON.stringify(payload, null, 2)}\n`,
        'utf8',
      );
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
      const filePath = path.join(
        dir,
        `session-${stamp}-${run.preview.sessionId.slice(0, 8)}.json`,
      );
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
      await fsPromises.writeFile(
        filePath,
        `${JSON.stringify(payload, null, 2)}\n`,
        'utf8',
      );
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
    const root =
      this.options.extensionUri ?? vscode.Uri.file(path.join(__dirname, '..'));
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(root, 'out', 'runs.js'),
    );
    const style = webview.asWebviewUri(
      vscode.Uri.joinPath(root, 'out', 'runs.css'),
    );
    return `<!DOCTYPE html><html lang="en"><head>
      <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:;">
      <title>cc-sdd Runs</title><style>${webviewThemeCss}</style>
      <link rel="stylesheet" href="${style}"></head><body>
      <div id="root"></div><script nonce="${nonce}" src="${script}"></script>
      </body></html>`;
  }
}
