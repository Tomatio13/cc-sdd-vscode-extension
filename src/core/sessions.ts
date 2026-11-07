// Reads Claude Code session transcripts for the current project from
// ~/.claude/projects/<encoded-cwd>/*.jsonl. Pure enough to unit test.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunSegment } from '../run/claudeRunner';

export interface SessionRecord {
  id: string;
  title: string;
  skill?: string;
  feature?: string;
  cwd?: string;
  startedAt?: number;
  updatedAt: number;
  sizeBytes: number;
  filePath: string;
  lastMessage?: string;
}

export interface SessionHead {
  cwd?: string;
  startedAt?: number;
  title?: string;
  skill?: string;
  feature?: string;
}

const DEFAULT_PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

/** Claude Code stores projects as the cwd with every non-alphanumeric char as "-". */
export const encodeProjectDir = (workspaceRoot: string): string =>
  workspaceRoot.replace(/[^A-Za-z0-9]/g, '-');

export const claudeProjectDir = (
  workspaceRoot: string,
  projectsRoot = DEFAULT_PROJECTS_ROOT,
): string => path.join(projectsRoot, encodeProjectDir(workspaceRoot));

const extractUserText = (content: unknown): string | undefined => {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) {
      continue;
    }
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type === 'text' && typeof typed.text === 'string') {
      parts.push(typed.text);
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
};

/** Turns the first user message into a display title. */
export const parseSessionText = (
  text: string,
): { title: string; skill?: string; feature?: string } => {
  const commandName = /<command-name>([^<]+)<\/command-name>/.exec(text);
  const commandArgs = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
  if (commandName) {
    const skill = commandName[1].trim().replace(/^\//, '');
    const feature = (commandArgs?.[1] ?? '').trim();
    return {
      title: `/${skill}${feature ? ` ${feature}` : ''}`,
      skill,
      feature: feature || undefined,
    };
  }

  const cleaned = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { title: cleaned.length > 100 ? `${cleaned.slice(0, 99)}…` : cleaned };
};

const applyEntry = (head: SessionHead, entry: unknown): void => {
  if (typeof entry !== 'object' || entry === null) {
    return;
  }
  const typed = entry as {
    type?: unknown;
    cwd?: unknown;
    timestamp?: unknown;
    message?: { content?: unknown };
  };

  if (typeof typed.cwd === 'string' && head.cwd === undefined) {
    head.cwd = typed.cwd;
  }
  if (typeof typed.timestamp === 'string' && head.startedAt === undefined) {
    const parsed = Date.parse(typed.timestamp);
    if (Number.isFinite(parsed)) {
      head.startedAt = parsed;
    }
  }
  if (typed.type !== 'user' || head.title !== undefined) {
    return;
  }

  const text = extractUserText(typed.message?.content);
  if (!text) {
    return;
  }
  const meta = parseSessionText(text);
  if (!meta.title) {
    return;
  }
  head.title = meta.title;
  head.skill = meta.skill;
  head.feature = meta.feature;
};

/** Reads just enough of a transcript to describe the session. */
export const readSessionHead = (filePath: string): SessionHead => {
  const maxBytes = 256 * 1024;
  const chunk = Buffer.alloc(64 * 1024);
  const head: SessionHead = {};
  let fd: number | undefined;

  try {
    fd = fs.openSync(filePath, 'r');
    let buffer = '';
    let offset = 0;
    while (offset < maxBytes) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, offset);
      if (read <= 0) {
        break;
      }
      offset += read;
      buffer += chunk.subarray(0, read).toString('utf8');

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            parsed = undefined;
          }
          if (parsed !== undefined) {
            applyEntry(head, parsed);
            if (head.title !== undefined) {
              return head;
            }
          }
        }
        newline = buffer.indexOf('\n');
      }
    }
  } catch {
    return head;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }

  return head;
};

/** Reads the last assistant text from the tail of a transcript. */
export const readSessionTail = (filePath: string, maxBytes = 128 * 1024): string | undefined => {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      let text = buffer.toString('utf8');
      if (start > 0) {
        const firstNewline = text.indexOf('\n');
        text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
      }
      const lines = text.split('\n');
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line.trim()) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof parsed !== 'object' || parsed === null) {
          continue;
        }
        const entry = parsed as { type?: unknown; message?: { content?: unknown } };
        if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) {
          continue;
        }
        const parts: string[] = [];
        for (const block of entry.message.content) {
          if (typeof block !== 'object' || block === null) {
            continue;
          }
          const typed = block as { type?: unknown; text?: unknown };
          if (typed.type === 'text' && typeof typed.text === 'string' && typed.text.trim()) {
            parts.push(typed.text.trim());
          }
        }
        if (parts.length > 0) {
          return parts.join(' ').replace(/\s+/g, ' ').slice(0, 300);
        }
      }
      return undefined;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
};

const normalizePath = (value: string): string => value.replace(/[\\/]+$/, '');

/**
 * Lists stored sessions for the workspace, newest first.
 * Sessions from other projects are filtered out even if the directory collides.
 */
export const listSessions = (
  workspaceRoot: string,
  projectsRoot = DEFAULT_PROJECTS_ROOT,
): SessionRecord[] => {
  const dir = claudeProjectDir(workspaceRoot, projectsRoot);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const expectedCwd = normalizePath(workspaceRoot);
  const sessions: SessionRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
      continue;
    }
    const filePath = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    const head = readSessionHead(filePath);
    if (head.cwd !== undefined && normalizePath(head.cwd) !== expectedCwd) {
      continue;
    }
    const id = entry.name.slice(0, -'.jsonl'.length);
    sessions.push({
      id,
      title: head.title?.trim() || `Session ${id.slice(0, 8)}`,
      skill: head.skill,
      feature: head.feature,
      cwd: head.cwd,
      startedAt: head.startedAt,
      updatedAt: stat.mtimeMs,
      sizeBytes: stat.size,
      filePath,
      lastMessage: readSessionTail(filePath),
    });
  }

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
};

const HISTORY_LIMIT = 1500;
const HISTORY_TEXT_LIMIT = 4000;
const HISTORY_TOOL_RESULT_LIMIT = 1200;

const historyLimit = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

const SUMMARY_KEYS = [
  'command',
  'file_path',
  'path',
  'pattern',
  'url',
  'query',
  'skill',
  'description',
  'prompt',
] as const;

const summarizeInput = (input: unknown): string => {
  if (typeof input !== 'object' || input === null) {
    return '';
  }
  const record = input as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return historyLimit(value.trim(), 200);
    }
  }
  return '';
};

const userDisplayText = (text: string): string | undefined => {
  const commandName = /<command-name>([^<]+)<\/command-name>/.exec(text);
  if (commandName) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
    const feature = (args?.[1] ?? '').trim();
    return `${commandName[1].trim()}${feature ? ` ${feature}` : ''}`;
  }
  const cleaned = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || undefined;
};

const contentText = (content: unknown): string => {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'object' && block !== null) {
      const typed = block as { type?: unknown; text?: unknown };
      if (typed.type === 'text' && typeof typed.text === 'string') {
        parts.push(typed.text);
      }
    }
  }
  return parts.join('\n');
};

/** Converts transcript JSONL lines into console segments (oldest first). */
export const transcriptSegmentsFromLines = (lines: string[]): RunSegment[] => {
  const segments: RunSegment[] = [];

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      continue;
    }
    const entry = parsed as { type?: unknown; message?: { content?: unknown } };
    const content = entry.message?.content;

    if (entry.type === 'user') {
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== 'object' || block === null) {
            continue;
          }
          const typed = block as {
            type?: unknown;
            text?: unknown;
            content?: unknown;
            is_error?: unknown;
          };
          if (typed.type === 'text' && typeof typed.text === 'string') {
            const text = userDisplayText(typed.text);
            if (text) {
              segments.push({ kind: 'user', text: historyLimit(text, HISTORY_TEXT_LIMIT) });
            }
          } else if (typed.type === 'tool_result') {
            segments.push({
              kind: 'toolresult',
              text: historyLimit(contentText(typed.content), HISTORY_TOOL_RESULT_LIMIT),
              isError: typed.is_error === true,
            });
          }
        }
      } else if (typeof content === 'string') {
        const text = userDisplayText(content);
        if (text) {
          segments.push({ kind: 'user', text: historyLimit(text, HISTORY_TEXT_LIMIT) });
        }
      }
      continue;
    }

    if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (typeof block !== 'object' || block === null) {
          continue;
        }
        const typed = block as { type?: unknown; text?: unknown; name?: unknown; input?: unknown };
        if (typed.type === 'text' && typeof typed.text === 'string' && typed.text.trim()) {
          segments.push({ kind: 'text', text: historyLimit(typed.text, HISTORY_TEXT_LIMIT) });
        } else if (typed.type === 'tool_use' && typeof typed.name === 'string') {
          const summary = summarizeInput(typed.input);
          segments.push({
            kind: 'tool',
            text: summary ? `${typed.name}: ${summary}` : typed.name,
          });
        }
      }
    }
  }

  if (segments.length > HISTORY_LIMIT) {
    const omitted = segments.length - HISTORY_LIMIT;
    return [
      { kind: 'system', text: `… ${omitted} earlier entries omitted` },
      ...segments.slice(-HISTORY_LIMIT),
    ];
  }
  return segments;
};

/** Reads a transcript file (up to the last 32MB) into console segments. */
export const readTranscriptSegments = (filePath: string): RunSegment[] => {
  const maxBytes = 32 * 1024 * 1024;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) {
      const fd = fs.openSync(filePath, 'r');
      try {
        const buffer = Buffer.alloc(maxBytes);
        fs.readSync(fd, buffer, 0, maxBytes, stat.size - maxBytes);
        const text = buffer.toString('utf8');
        const firstNewline = text.indexOf('\n');
        return transcriptSegmentsFromLines(
          (firstNewline === -1 ? text : text.slice(firstNewline + 1)).split('\n'),
        );
      } finally {
        fs.closeSync(fd);
      }
    }
    return transcriptSegmentsFromLines(fs.readFileSync(filePath, 'utf8').split('\n'));
  } catch {
    return [];
  }
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const formatWhen = (timestamp: number, now = Date.now()): string => {
  const diff = now - timestamp;
  if (!Number.isFinite(diff) || diff < 0) {
    return 'just now';
  }
  if (diff < MINUTE) {
    return 'just now';
  }
  if (diff < HOUR) {
    return `${Math.floor(diff / MINUTE)}m ago`;
  }
  if (diff < DAY) {
    return `${Math.floor(diff / HOUR)}h ago`;
  }
  if (diff < 7 * DAY) {
    return `${Math.floor(diff / DAY)}d ago`;
  }
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};
