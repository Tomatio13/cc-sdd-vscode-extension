import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpecTreeProvider } from '../src/ui/specTree';
import type { RunState } from '../src/run/claudeRunner';
import type * as vscode from 'vscode';

const execute = vi.hoisted(() => vi.fn());
vi.mock('vscode', () => ({
  Uri: { joinPath: (_base: unknown, ...parts: string[]) => parts.join('/') },
  commands: { executeCommand: execute },
  window: { showErrorMessage: vi.fn() },
}));
import { SessionsTimeline, sessionWhen } from '../src/ui/sessionsTimeline';
import type { SessionsTreeProvider } from '../src/ui/sessionsTree';
import { SpecTimeline } from '../src/ui/specTimeline';

function setup(roots: unknown[] = [], sessions = false) {
  vi.useFakeTimers();
  let receive: (message: unknown) => void = () => {};
  const messages: { type: string; html?: string }[] = [];
  const provider = {
    onDidChangeTreeData: () => ({ dispose() {} }),
    getChildren: vi.fn(async () => roots),
    getTreeItem: (node: { label: string; command?: vscode.Command }) => node,
  };
  const view = {
    visible: true,
    webview: {
      options: {},
      html: '',
      cspSource: 'test:',
      asWebviewUri: (uri: string) => uri,
      postMessage: vi.fn(async (message) => {
        messages.push(message);
        return true;
      }),
      onDidReceiveMessage: (callback: typeof receive) => {
        receive = callback;
        return { dispose() {} };
      },
    },
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
  };
  const timeline = sessions
    ? new SessionsTimeline({} as vscode.Uri, provider as unknown as SessionsTreeProvider)
    : new SpecTimeline(
        {} as vscode.Uri,
        provider as unknown as SpecTreeProvider,
        () => [] as RunState[],
        vi.fn(),
      );
  timeline.resolveWebviewView(view as unknown as vscode.WebviewView);
  return {
    timeline,
    provider,
    view,
    messages,
    receive: (message: unknown) => receive(message),
  };
}

afterEach(() => {
  vi.useRealTimers();
  execute.mockReset();
});

describe('SpecTimeline', () => {
  it('renders empty state and only executes registered action tokens', async () => {
    const ui = setup();
    ui.receive({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(100);
    expect(ui.messages[0].html).toContain('No cc-sdd specs found.');
    ui.receive({ type: 'action', id: 'workbench.action.closeWindow' });
    expect(execute).not.toHaveBeenCalled();
    const token = ui.messages[0].html!.match(/data-action="([^"]+)"/)![1];
    ui.receive({ type: 'action', id: token });
    expect(execute).toHaveBeenCalledWith('ccSdd.newSpec');
    ui.timeline.dispose();
  });

  it('escapes workspace text and enforces a restricted content policy', async () => {
    const ui = setup([
      {
        kind: 'roadmap',
        label: '<img src=x onerror=alert(1)>',
        description: '<script>',
      },
    ]);
    ui.receive({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(100);
    expect(ui.messages[0].html).toContain('&lt;img');
    expect(ui.messages[0].html).not.toContain('<img');
    expect(ui.view.webview.html).toContain("default-src 'none'");
    expect(ui.view.webview.html).not.toContain('unsafe-inline');
    ui.timeline.dispose();
  });

  it('discards stale reads when a newer refresh has been requested', async () => {
    const ui = setup();
    let resolve!: (value: unknown[]) => void;
    ui.provider.getChildren.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    ui.receive({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(100);
    ui.timeline.refresh();
    resolve([]);
    await Promise.resolve();
    expect(ui.messages).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(ui.messages).toHaveLength(1);
    ui.timeline.dispose();
  });

  it('shows stage progress without a duplicate card and keeps idle controls collapsed', async () => {
    const record = { id: 'demo' };
    const progress = {
      tasksDone: 1,
      tasksTotal: 4,
      approvals: { requirements: 'approved', tasks: 'approved' },
      verification: { status: 'none' },
    };
    const root = {
      kind: 'spec',
      record,
      label: 'Demo',
      progress: { completed: false, tasksDone: 1, tasksTotal: 4 },
    };
    const stages = [
      {
        kind: 'stage',
        progress,
        record,
        stage: 'requirements',
        current: false,
        label: 'Requirements',
        contextValue: 'phase-approved',
        description: 'approved',
      },
      {
        kind: 'stage',
        progress,
        record,
        stage: 'implementation',
        current: true,
        label: 'Implementation',
        contextValue: 'impl-in-progress',
        description: '1/4 done',
      },
    ];
    stages.push({
      kind: 'stage',
      progress,
      record,
      stage: 'tasks',
      current: false,
      label: 'Tasks',
      contextValue: 'phase-approved',
      description: '1/4 done',
    });
    const ui = setup([root]);
    ui.provider.getChildren.mockResolvedValueOnce([root]).mockResolvedValueOnce(stages);
    ui.receive({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(100);
    const html = ui.messages[0].html!;
    expect(html).toContain('25%');
    expect(html).not.toContain('progress-overview');
    expect(html).toContain('data-key="row:demo:requirements" >');
    expect(html).toContain('data-key="row:demo:implementation" >');
    expect(html).toContain('data-key="options:demo"');
    const tasks = html
      .split('<li class="stage ')
      .find((row) => row.includes('data-key="row:demo:tasks"'))!;
    expect(tasks).toBeDefined();
    expect(tasks).toMatch(/^done/);
    expect(tasks.split('<details')[0]).toContain('✓');
    expect(tasks).toContain('Task planning');
    expect(tasks).toContain('approved');
    expect(tasks).not.toContain('stage-progress');
    expect(tasks).not.toContain('1/4');
    expect(html).toContain('aria-label="Implementation progress" value="25"');
    const selectToken = html.match(/data-select="([^"]+)"/)![1];
    ui.receive({ type: 'action', id: selectToken });
    expect(execute).toHaveBeenCalledWith('ccSdd.selectSpec', record);
    ui.timeline.dispose();
  });

  it('orders session history newest first and keeps token counts in details', async () => {
    const root = { kind: 'group', group: 'history' };
    const session = (id: string, updatedAt: number, lastMessage: string) => ({
      kind: 'session',
      session: {
        id,
        updatedAt,
        title: 'Review',
        lastMessage,
        usage: { inputTokens: 1000, outputTokens: 100 },
      },
      stage: 'Verification',
      viewState: 'stopped',
      active: false,
      hasRun: false,
      showSpec: false,
    });
    const ui = setup([root], true);
    ui.provider.getChildren
      .mockResolvedValueOnce([root])
      .mockResolvedValueOnce([
        session('old', 1000, '<img src=x>'),
        session('new', 2000, 'Report saved'),
      ]);
    ui.receive({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(100);
    const html = ui.messages[0].html!;
    expect(html.indexOf('session:new')).toBeLessThan(html.indexOf('session:old'));
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).not.toContain('<img');
    expect(html).toContain('Resume');
    expect(html.split('</summary>')[0]).not.toContain('tokens');
    const token = html.match(/data-action="([^"]+)"/)![1];
    ui.receive({ type: 'action', id: token });
    expect(execute).toHaveBeenCalledWith(
      'ccSdd.previewSession',
      expect.objectContaining({ id: 'new' }),
    );
    ui.timeline.dispose();
  });

  it('offers opening an active session run without resuming a second copy', async () => {
    const root = { kind: 'group', group: 'active' };
    const ui = setup([root], true);
    ui.provider.getChildren.mockResolvedValueOnce([root]).mockResolvedValueOnce([
      {
        kind: 'session',
        session: { id: 'live', updatedAt: 2000, title: 'Working' },
        stage: 'Implementation',
        active: true,
        viewState: 'waiting',
        hasRun: true,
        showSpec: false,
      },
    ]);
    ui.receive({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(100);
    const html = ui.messages[0].html!;
    expect(html).toContain('Input waiting');
    expect(html).toContain('Open run');
    expect(html).not.toContain('Resume');
    expect(html).not.toContain('Completed');
    ui.timeline.dispose();
  });

  it('invalidates old action tokens after refresh', async () => {
    const ui = setup();
    ui.receive({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(100);
    const token = ui.messages[0].html!.match(/data-action="([^"]+)"/)![1];
    ui.timeline.refresh();
    await vi.advanceTimersByTimeAsync(100);
    ui.receive({ type: 'action', id: token });
    expect(execute).not.toHaveBeenCalled();
    ui.timeline.dispose();
  });
});

describe('session timeline dates', () => {
  it('uses a compact 24-hour time for today', () => {
    const now = new Date(2026, 10, 14, 21, 30);
    expect(sessionWhen(new Date(2026, 10, 14, 14, 15).getTime(), now)).toBe('14:15');
  });
  it('includes a date for older sessions and a year across years', () => {
    const now = new Date(2026, 10, 14);
    expect(sessionWhen(new Date(2025, 10, 14, 14, 15).getTime(), now)).toContain('2025');
    expect(sessionWhen(new Date(2026, 10, 13, 14, 15).getTime(), now)).toContain('14:15');
  });
});
