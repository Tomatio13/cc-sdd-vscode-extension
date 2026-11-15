// Folds the runs console's events into the work map's board.
// Ported from lot-map (https://github.com/alexeyw/lot-map), MIT License;
// the engine-specific hooks are replaced by the Agent SDK event stream that
// this extension already receives in src/run/claudeRunner.ts.
import type { Board, Entry, StationId, Status } from './types';
import type { RunEvent } from '../run/claudeRunner';
import { classify, clean, shortModel } from './classify';
import { setupFrom } from './setup';
import type { Setup } from './setup';

const KEEP = 120;
const CREW = 12;

export interface MapTrackerOptions {
  /** The language of the labels the tracker itself writes. Defaults to English. */
  language?: string;
  /** Injectable clock, for tests. */
  now?: () => number;
}

export class MapTracker {
  private board: Board = { entries: [], counts: {} };
  private readonly listeners = new Set<() => void>();
  /** Entry ids still running, per run, so a result or an exit can close them. */
  private readonly open = new Map<string, Set<string>>();
  private readonly setup: Setup;
  private readonly now: () => number;

  constructor(options: MapTrackerOptions = {}) {
    this.setup = setupFrom({ language: options.language ?? 'en' });
    this.now = options.now ?? Date.now;
  }

  onDidChange(listener: () => void): { dispose: () => void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  snapshot(): Board {
    return { ...this.board, entries: [...this.board.entries] };
  }

  /** A run began: the person's message starts the turn. */
  notePrompt(runId: string, at = this.now()): void {
    this.push({
      id: `${runId}:prompt:${at}`,
      station: 'you',
      label: this.setup.t.newMessage,
      from: 'core',
      startedAt: at,
      endedAt: at,
      status: 'ok',
    });
    // A new message is what clears the red dots of the last turn.
    this.board = { ...this.board, faults: {} };
    this.emit();
  }

  observe(runId: string, event: RunEvent, at = this.now()): void {
    switch (event.kind) {
      case 'system':
        if (event.model) {
          this.setModel(event.model, at);
        }
        return;
      case 'usage':
        this.addModelStep(event.model, at);
        return;
      case 'context':
        if (Number.isFinite(event.percent)) {
          this.board = { ...this.board, context: Math.max(0, Math.min(100, event.percent)) };
          this.emit();
        }
        return;
      case 'assistant':
        if (event.tool) {
          this.startTool(runId, event.tool, at);
        }
        return;
      case 'toolresult':
        this.endTool(runId, event.toolUseId, event.isError, at);
        return;
      case 'pending':
        this.push({
          id: event.pending.id,
          station: 'you',
          label:
            event.pending.kind === 'permission'
              ? this.setup.t.askedPermission(event.pending.toolName ?? 'tool')
              : this.setup.t.questionForYou,
          from: 'core',
          startedAt: at,
          status: 'run',
        });
        this.openFor(runId).add(event.pending.id);
        return;
      case 'result':
        this.finishRun(runId, event.isError ? 'err' : 'ok', at);
        return;
    }
  }

  /** The console answered a permission or question card. */
  noteDecision(
    runId: string,
    requestId: string,
    decision: 'allow' | 'always' | 'deny',
    at = this.now(),
  ): void {
    this.close(runId, requestId, decision === 'deny' ? 'block' : 'ok', at);
  }

  /** The child process ended; anything still open belongs to a run that is over. */
  noteExit(runId: string, ok: boolean, at = this.now()): void {
    const ids = this.open.get(runId);
    if (!ids) {
      return;
    }
    for (const id of ids) {
      this.close(runId, id, ok ? 'ok' : 'err', at);
    }
  }

  private startTool(
    runId: string,
    tool: { name: string; input?: Record<string, unknown>; id?: string; agentId?: string },
    at: number,
  ): void {
    const classified = classify(tool.name, tool.input ?? {}, this.setup);
    const id = tool.id ?? `${runId}:${at}:${Math.random().toString(36).slice(2, 7)}`;
    this.push({
      id,
      station: classified.station,
      label: clean(classified.label),
      from: tool.agentId ? 'agents' : 'core',
      startedAt: at,
      status: 'run',
      agentId: tool.agentId,
    });
    this.openFor(runId).add(id);
  }

  private endTool(
    runId: string,
    toolUseId: string | undefined,
    isError: boolean,
    at: number,
  ): void {
    if (!toolUseId) {
      return;
    }
    this.close(runId, toolUseId, isError ? 'err' : 'ok', at);
  }

  private close(runId: string, id: string, status: Status, at: number): void {
    const ids = this.open.get(runId);
    if (!ids?.has(id)) {
      return;
    }
    ids.delete(id);
    const entry = this.board.entries.find((candidate) => candidate.id === id && candidate.status === 'run');
    this.board = {
      ...this.board,
      entries: this.board.entries.map((candidate) =>
        candidate.id === id && candidate.status === 'run'
          ? { ...candidate, status, endedAt: at }
          : candidate,
      ),
      counts: this.board.counts,
      faults:
        status === 'err' || status === 'block'
          ? this.moreFault(entry?.station)
          : this.board.faults,
      agents:
        entry?.station === 'agents'
          ? (this.board.agents ?? []).filter((agent) => agent !== id)
          : this.board.agents,
    };
    this.emit();
  }

  private finishRun(runId: string, status: Status, at: number): void {
    const ids = this.open.get(runId);
    if (ids) {
      for (const id of ids) {
        this.close(runId, id, status, at);
      }
    }
    this.push({
      id: `${runId}:answer:${at}`,
      station: 'you',
      label: this.setup.t.answerReady,
      from: 'core',
      startedAt: at,
      endedAt: at,
      status: 'ok',
      mark: 'done',
    });
  }

  private setModel(model: string, at: number): void {
    const previous = this.board.model;
    if (previous !== undefined && previous !== model) {
      this.push(
        {
          id: `switch:${at}`,
          station: 'model',
          label: `${shortModel(previous)} → ${shortModel(model)}`,
          from: 'core',
          startedAt: at,
          endedAt: at,
          status: 'ok',
          mark: 'switch',
        },
        true,
      );
    }
    this.board = { ...this.board, model, switchedAt: at };
    this.emit();
  }

  private addModelStep(model: string | undefined, at: number): void {
    const step = (this.board.step ?? 0) + 1;
    this.board = { ...this.board, step };
    this.push({
      id: `step:${at}:${step}`,
      station: 'model',
      label: model ? shortModel(model) : this.setup.t.step(step),
      from: 'core',
      startedAt: at,
      endedAt: at,
      status: 'ok',
    });
  }

  private push(entry: Entry, uncounted = false): void {
    const agents = this.board.agents ?? [];
    const isAgent = entry.station === 'agents' && entry.status === 'run';
    this.board = {
      ...this.board,
      entries: [...this.board.entries, entry].slice(-KEEP),
      counts: uncounted
        ? this.board.counts
        : { ...this.board.counts, [entry.station]: (this.board.counts[entry.station] ?? 0) + 1 },
      agents:
        isAgent && !agents.includes(entry.id)
          ? [...agents, entry.id].slice(-CREW)
          : this.board.agents,
    };
    this.emit();
  }

  private moreFault(station: StationId | undefined): Board['faults'] {
    if (station === undefined) {
      return this.board.faults;
    }
    return { ...this.board.faults, [station]: (this.board.faults?.[station] ?? 0) + 1 };
  }

  private openFor(runId: string): Set<string> {
    let ids = this.open.get(runId);
    if (!ids) {
      ids = new Set();
      this.open.set(runId, ids);
    }
    return ids;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
