// The dedicated work-map webview: the lot-map board, drawn from the runs
// console's events. Ported drawing code is MIT, see THIRD_PARTY_NOTICES.md.
import './map.css';
import type { Board, Entry } from '../src/map/types';
import { drawMap, TRAIL_FADE_MS, TRAIL_HOLD_MS } from '../src/map/draw';
import { foldRows, nowParts } from '../src/map/feed';
import { setupFrom } from '../src/map/setup';
import { formatMs } from '../src/map/classify';
import { accentColors } from '../src/map/accent';
import type { Strings } from '../src/map/text';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

interface StateMessage {
  type: 'state';
  board: Board;
  theme: 'dark' | 'light';
  language: string;
  accent?: string;
}

const ZOOMS = [160, 200, 240, 280, 340, 400, 0]; // 0 = as wide as the panel, the largest
const MAP_STATE_VERSION = 2;

let board: Board = { entries: [], counts: {} };
let setup = setupFrom({});
let t: Strings = setup.t;
let zoomIndex = ZOOMS.length - 2;
let minimized = false;
let latestAt = 0;

const root = document.getElementById('root')!;
root.innerHTML = `
  <header>
    <h1></h1>
    <div class="controls">
      <button data-act="zoom-out" title="Zoom out" aria-label="Zoom out">−</button>
      <button data-act="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
      <button data-act="toggle" class="secondary" title="Fold the map to its line"></button>
    </div>
  </header>
  <div class="map-wrap"><div id="map"></div></div>
  <div class="now"><span id="now-what"></span><span id="now-meter"></span></div>
  <ol id="rows" class="rows"></ol>`;

const title = root.querySelector('h1') as HTMLElement;
const mapElement = document.getElementById('map') as HTMLElement;
const mapWrap = root.querySelector('.map-wrap') as HTMLElement;
const nowWhat = document.getElementById('now-what') as HTMLElement;
const nowMeter = document.getElementById('now-meter') as HTMLElement;
const rows = document.getElementById('rows') as HTMLOListElement;
const toggle = root.querySelector('[data-act="toggle"]') as HTMLButtonElement;
const zoomIn = root.querySelector('[data-act="zoom-in"]') as HTMLButtonElement;
const zoomOut = root.querySelector('[data-act="zoom-out"]') as HTMLButtonElement;

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

const cssVar = (name: string, fallback: string): string => {
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || fallback;
};

/** `mono` follows the editor's own greys; the other choices are fixed palettes. */
const colorsFor = (
  name: string | undefined,
  theme: 'dark' | 'light',
): { accent: string; active: string } => {
  const fallback = accentColors(name, theme);
  if (name === undefined || name === 'mono') {
    return {
      accent: cssVar('--vscode-descriptionForeground', fallback.accent),
      active: cssVar('--vscode-foreground', fallback.active),
    };
  }
  return fallback;
};

const restore = (): void => {
  const saved = vscode.getState() as
    | { version?: unknown; zoomIndex?: unknown; minimized?: unknown }
    | undefined;
  if (saved?.version !== MAP_STATE_VERSION) {
    return;
  }
  if (
    typeof saved.zoomIndex === 'number' &&
    saved.zoomIndex >= 0 &&
    saved.zoomIndex < ZOOMS.length
  ) {
    zoomIndex = saved.zoomIndex;
  }
  minimized = saved.minimized === true;
};

const persist = (): void => {
  vscode.setState({ version: MAP_STATE_VERSION, zoomIndex, minimized });
};

const isBusy = (current: Board): boolean =>
  current.entries.some((entry) => entry.status === 'run') || (current.agents ?? []).length > 0;

const hasRecent = (current: Board, now: number): boolean =>
  current.entries.some(
    (entry) => now - (entry.endedAt ?? entry.startedAt) < TRAIL_HOLD_MS + TRAIL_FADE_MS,
  );

const glyph = (entry: Entry): string => {
  if (entry.mark === 'switch') return '◆';
  if (entry.status === 'run') return '●';
  if (entry.status === 'err' || entry.status === 'block') return '✕';
  return '·';
};

const label = (entry: Entry): string => {
  const station = t.stations[entry.station] ?? entry.station;
  return `${station}: ${entry.label}`;
};

const renderMap = (): void => {
  mapWrap.hidden = minimized;
  rows.hidden = minimized;
  toggle.textContent = minimized ? t.showMap : t.hideMap;
  toggle.title = toggle.textContent;
  zoomIn.disabled = zoomIndex >= ZOOMS.length - 1;
  zoomOut.disabled = zoomIndex <= 0;
  if (minimized) return;
  const now = Date.now();
  mapElement.innerHTML = drawMap(board, now, setup);
  mapElement.style.maxWidth = ZOOMS[zoomIndex] === 0 ? '100%' : `${ZOOMS[zoomIndex]}px`;
};

const renderFeed = (): void => {
  title.textContent = t.title;
  const now = Date.now();
  const parts = nowParts(board, t);
  nowWhat.textContent = parts.what;
  nowMeter.textContent = parts.meter;

  const folded = foldRows(board.entries, 16);
  if (folded.length === 0) {
    rows.innerHTML = `<li class="empty">${escapeHtml(t.nothingYet)}</li>`;
    return;
  }
  rows.innerHTML = folded
    .map(({ entry, times, tookMs }) => {
      const took =
        entry.status === 'run'
          ? formatMs(Math.max(0, now - entry.startedAt), t)
          : formatMs(tookMs, t);
      const more = times > 1 ? `+${times - 1}` : '';
      return `<li class="row row-${entry.status}" title="${escapeHtml(label(entry))}">
        <span class="glyph">${glyph(entry)}</span>
        <span class="station">${escapeHtml(t.stations[entry.station] ?? entry.station)}</span>
        <span class="label">${escapeHtml(entry.label)}</span>
        <span class="times">${more}</span>
        <span class="time">${escapeHtml(took)}</span>
      </li>`;
    })
    .join('');
};

let frame: number | undefined;

const stopFrames = (): void => {
  if (frame !== undefined) {
    window.clearTimeout(frame);
    frame = undefined;
  }
};

const scheduleFrame = (): void => {
  if (frame !== undefined) return;
  frame = window.setTimeout(() => {
    frame = undefined;
    renderMap();
    const now = Date.now();
    if (
      !minimized &&
      (isBusy(board) || now - latestAt < TRAIL_HOLD_MS + TRAIL_FADE_MS || hasRecent(board, now))
    ) {
      scheduleFrame();
    }
  }, 100);
};

const applyState = (message: StateMessage): void => {
  board = message.board;
  latestAt = Date.now();
  setup = setupFrom({
    language: message.language,
    theme: message.theme,
    background: 'transparent',
    layout: 'you-top',
    motion: 'full',
    coreName: 'CLAUDE',
  });
  const colors = colorsFor(message.accent, message.theme);
  setup.colors = { accent: colors.accent, hot: colors.active };
  t = setup.t;
  renderMap();
  renderFeed();
  stopFrames();
  scheduleFrame();
};

window.addEventListener('message', (event: MessageEvent<StateMessage>) => {
  if (event.data?.type === 'state') {
    applyState(event.data);
  }
});

root.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null;
  const action = target?.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (!action) return;
  if (action === 'toggle') {
    minimized = !minimized;
  } else if (action === 'zoom-in') {
    zoomIndex = Math.min(ZOOMS.length - 1, zoomIndex + 1);
  } else if (action === 'zoom-out') {
    zoomIndex = Math.max(0, zoomIndex - 1);
  }
  persist();
  renderMap();
  if (!minimized) scheduleFrame();
});

restore();
renderMap();
renderFeed();
vscode.postMessage({ type: 'ready' });
