import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunsConsole } from '../../src/ui/runsConsole';

const mocks = vi.hoisted(() => ({ panels: [] as any[], runners: [] as any[], pick: vi.fn() }));
vi.mock('vscode', () => ({
  EventEmitter: class {
    event = vi.fn();
    fire = vi.fn();
    dispose = vi.fn();
  },
  ViewColumn: { Active: 1 },
  window: {
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showQuickPick: mocks.pick,
    createWebviewPanel: (type: string, title: string) => {
      let onDispose = () => {};
      const panel = {
        type,
        title,
        visible: true,
        receive: (_message: unknown) => {},
        reveal: vi.fn(),
        webview: {
          html: '',
          cspSource: 'test:',
          postMessage: vi.fn(),
          onDidReceiveMessage: (callback: any) => {
            panel.receive = callback;
          },
        },
        onDidChangeViewState: vi.fn(),
        onDidDispose: (callback: any) => {
          onDispose = callback;
        },
        dispose: vi.fn(() => {
          panel.visible = false;
          onDispose();
        }),
      };
      mocks.panels.push(panel);
      return panel;
    },
  },
}));
vi.mock('../../src/run/claudeRunner', () => ({
  startClaudeRun: (input: any) => {
    const handle = { cancel: vi.fn(), respondPermission: vi.fn(), respondQuestions: vi.fn() };
    mocks.runners.push({ input, handle });
    return handle;
  },
  applyRunEvent: (run: any, event: any) => {
    if (event.kind === 'pending') run.pending = event.pending;
  },
}));

let consoleView: RunsConsole;
const start = (feature = 'demo', history = 'private history') =>
  consoleView.startRun({
    feature,
    skill: 'kiro-validate-impl',
    prompt: '/kiro-validate-impl ' + feature,
    permissionMode: 'default',
    history: [{ kind: 'text', text: history }],
  });
beforeEach(() => {
  vi.useFakeTimers();
  mocks.panels.length = 0;
  mocks.runners.length = 0;
  mocks.pick.mockReset();
  consoleView = new RunsConsole({
    getWorkspaceRoot: () => '/tmp/project',
    getBinary: () => 'claude',
    getPhaseActions: vi.fn(),
    approvePhase: vi.fn(),
    runPhase: vi.fn(),
    runImplementation: vi.fn(),
    openPath: vi.fn(),
    rerun: vi.fn(),
    resumeTerminal: vi.fn(),
    getRunsDir: () => undefined,
  });
});
afterEach(() => {
  consoleView.dispose();
  vi.useRealTimers();
});

describe('one run per tab', () => {
  it('opens individual tabs and isolates state and transcript history', async () => {
    start('alpha', 'alpha history');
    start('beta', 'beta history');
    await vi.advanceTimersByTimeAsync(80);
    expect(mocks.panels.map((p) => p.type)).toEqual(['ccSdd.run', 'ccSdd.run']);
    expect(mocks.panels.map((p) => p.title)).toEqual([
      'alpha · Verification',
      'beta · Verification',
    ]);
    for (const [index, panel] of mocks.panels.entries()) {
      const messages = panel.webview.postMessage.mock.calls.map((call: any[]) => call[0]);
      expect(
        messages
          .filter((m: any) => m.type === 'state')
          .every((m: any) => m.runs.length === 1 && m.runs[0].id === `run-${index + 1}`),
      ).toBe(true);
      expect(messages.filter((m: any) => m.type === 'history').map((m: any) => m.runId)).toEqual([
        `run-${index + 1}`,
      ]);
    }
  });
  it('delivers history again when a newly loaded webview is ready', () => {
    start('alpha', 'history that must not disappear');
    const panel = mocks.panels[0];
    panel.webview.postMessage.mockClear();
    panel.receive({ type: 'ready' });
    const messages = panel.webview.postMessage.mock.calls.map((call: any[]) => call[0]);
    expect(messages.find((message: any) => message.type === 'history')).toMatchObject({
      runId: 'run-1',
      segments: [{ kind: 'text', text: 'history that must not disappear' }],
    });
  });

  it('keeps the runner alive after tab closure and reopens the same run', () => {
    start();
    mocks.panels[0].dispose();
    expect(mocks.runners[0].handle.cancel).not.toHaveBeenCalled();
    expect(consoleView.getRuns()[0].status).toBe('running');
    consoleView.openRun('run-1');
    expect(mocks.panels).toHaveLength(2);
    consoleView.openRun('run-1');
    expect(mocks.panels).toHaveLength(2);
    expect(mocks.panels[1].reveal).toHaveBeenCalled();
  });
  it('cannot cancel another tab’s run', () => {
    start('alpha');
    start('beta');
    mocks.panels[1].receive({ type: 'cancel', runId: 'run-1' });
    expect(mocks.runners[0].handle.cancel).not.toHaveBeenCalled();
    mocks.panels[0].receive({ type: 'cancel', runId: 'run-1' });
    expect(mocks.runners[0].handle.cancel).toHaveBeenCalledOnce();
  });
  it('reuses the same session preview instead of creating duplicate records', () => {
    const preview = {
      title: 'Demo',
      skill: 'kiro-impl',
      feature: 'demo',
      sessionId: 'session-1',
      filePath: '/tmp/session.jsonl',
      history: [],
    };
    consoleView.previewSession(preview);
    consoleView.previewSession(preview);
    expect(mocks.panels).toHaveLength(1);
    expect(consoleView.getRuns()).toHaveLength(1);
    expect(mocks.panels[0].title).toBe('demo · Implementation');
  });
  it('preserves active runs beyond the history limit', () => {
    for (let i = 0; i < 32; i++) start('spec-' + i);
    expect(consoleView.getRuns()).toHaveLength(32);
    expect(consoleView.getRuns().every((run) => run.status === 'running')).toBe(true);
  });
  it('prioritizes waiting runs in the picker', async () => {
    start('waiting');
    start('running');
    mocks.runners[0].input.onEvent({ kind: 'pending', pending: { id: 'p', kind: 'permission' } });
    mocks.pick.mockImplementation((items: any[]) => Promise.resolve(items[0]));
    consoleView.show();
    await Promise.resolve();
    expect(mocks.pick.mock.calls[0][0][0]).toMatchObject({
      label: 'waiting',
      description: 'Verification · Input waiting',
    });
    expect(mocks.panels).toHaveLength(2);
    expect(mocks.panels[0].reveal).toHaveBeenCalled();
  });
});
