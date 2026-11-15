import { describe, expect, it } from 'vitest';
import { MapTracker } from '../src/map/tracker';
import { drawMap } from '../src/map/draw';
import { setupFrom } from '../src/map/setup';

const at = 1_700_000_000_000;

const tracker = (language = 'en'): MapTracker =>
  new MapTracker({ language, now: () => at });

const startRead = (map: MapTracker, runId = 'run-1'): void =>
  map.observe(runId, {
    kind: 'assistant',
    tool: {
      name: 'Read',
      summary: '/repo/.kiro/specs/demo/requirements.md',
      input: { file_path: '/repo/.kiro/specs/demo/requirements.md' },
      id: 'tool-1',
    },
  });

describe('MapTracker', () => {
  it('lights a station from the tool input and closes it on the result', () => {
    const map = tracker();
    startRead(map);
    const running = map.snapshot().entries.at(-1)!;
    expect(running).toMatchObject({
      station: 'files',
      label: 'demo/requirements.md',
      status: 'run',
      from: 'core',
    });
    expect(map.snapshot().counts.files).toBe(1);

    map.observe('run-1', { kind: 'toolresult', text: 'ok', isError: false, toolUseId: 'tool-1' });
    expect(map.snapshot().entries.at(-1)).toMatchObject({ status: 'ok' });
  });

  it('keeps faults per station until the next message', () => {
    const map = tracker();
    startRead(map);
    map.observe('run-1', { kind: 'toolresult', text: 'boom', isError: true, toolUseId: 'tool-1' });
    expect(map.snapshot().entries.at(-1)!.status).toBe('err');
    expect(map.snapshot().faults?.files).toBe(1);

    map.notePrompt('run-2', at + 1);
    expect(map.snapshot().faults).toEqual({});
  });

  it('marks a refused permission as a block on the person’s station', () => {
    const map = tracker();
    map.observe('run-1', {
      kind: 'pending',
      pending: { id: 'perm-1', kind: 'permission', toolName: 'Bash' },
    });
    map.noteDecision('run-1', 'perm-1', 'deny', at + 2);
    expect(map.snapshot().entries.at(-1)).toMatchObject({
      station: 'you',
      status: 'block',
    });
    expect(map.snapshot().faults?.you).toBe(1);
  });

  it('records a model switch and the context window', () => {
    const map = tracker();
    map.observe('run-1', { kind: 'system', model: 'claude-opus-4-1' });
    map.observe('run-1', { kind: 'system', model: 'claude-sonnet-4-5' });
    expect(map.snapshot().model).toBe('claude-sonnet-4-5');
    expect(map.snapshot().entries.at(-1)).toMatchObject({ mark: 'switch', station: 'model' });

    map.observe('run-1', { kind: 'context', percent: 73.4 });
    expect(map.snapshot().context).toBe(73.4);
  });

  it('starts subagent calls from the agents station', () => {
    const map = tracker();
    startRead(map);
    map.observe('run-1', {
      kind: 'assistant',
      tool: {
        name: 'Grep',
        summary: 'TODO',
        input: { pattern: 'TODO' },
        id: 'tool-2',
        agentId: 'tool-1',
      },
    });
    expect(map.snapshot().entries.at(-1)).toMatchObject({ from: 'agents', agentId: 'tool-1' });
  });

  it('draws the board in English', () => {
    const map = tracker();
    startRead(map);
    const svg = drawMap(map.snapshot(), at + 10, setupFrom({ theme: 'dark' }));
    expect(svg).toContain('<svg');
    expect(svg).toContain('You');
    expect(svg).toContain('Files');
  });
});
