// The work map's data model, ported from lot-map (https://github.com/alexeyw/lot-map), MIT License.
// Copyright (c) 2026 Aleksei Volodin. See THIRD_PARTY_NOTICES.md.
// The engine-facing parts of lot-map's types (its plugin state) are left out.

export type StationId =
  | 'you'
  | 'model'
  | 'memory'
  | 'files'
  | 'shell'
  | 'web'
  | 'browser'
  | 'agents'
  | 'skills'
  | 'hooks';

export type Status = 'run' | 'ok' | 'err' | 'block';

/** One action on the map. Labels carry names and record numbers, never the text of a memory. */
export type Entry = {
  id: string;
  station: StationId;
  label: string;
  /** Where the pulse starts: the core, the agents station, or the station itself (a signal coming in). */
  from: 'core' | 'agents' | 'inbound';
  startedAt: number;
  endedAt?: number;
  status: Status;
  /** The subagent whose loop made the call; absent for the main loop. */
  agentId?: string;
  /** The background task the call started; the row stays open until that task reports back. */
  task?: string;
  /** A moment the map marks: the model changed, or the answer is ready. */
  mark?: 'switch' | 'done';
};

export type Board = {
  entries: Entry[];
  counts: Partial<Record<StationId, number>>;
  model?: string;
  step?: number;
  /** How many of the memory station's count a hook brought unasked. */
  pushed?: number;
  /** Errors and refusals per station since the person's last message. */
  faults?: Partial<Record<StationId, number>>;
  /** Subagents whose loops are still going. */
  agents?: string[];
  /** How full the context window is, 0 to 100. */
  context?: number;
  /** When the model last changed. */
  switchedAt?: number;
  /** The row of the feed the person opened to read whole: its entry's id. */
  open?: string;
  /** The editor's pane folded to its line of now; kept between sessions as well. */
  minimized?: boolean;
  /** How wide the editor draws the map, in CSS pixels; absent, as wide as the pane. Kept between sessions as well. */
  zoom?: number;
};
