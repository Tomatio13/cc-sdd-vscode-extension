import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  encodeProjectDir,
  formatTokenCount,
  formatWhen,
  listSessions,
  parseSessionText,
  readSessionHead,
  readSessionTail,
  readSessionTailInfo,
  readSessionUsage,
  transcriptSegmentsFromLines,
} from '../src/core/sessions';

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sdd-sessions-'));
  tempDirs.push(dir);
  return dir;
};

const writeSession = (
  projectsRoot: string,
  workspaceRoot: string,
  id: string,
  cwd: string,
  firstText: string,
  mtime: Date,
): string => {
  const dir = path.join(projectsRoot, encodeProjectDir(workspaceRoot));
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${id}.jsonl`);
  const lines = [
    JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId: id }),
    JSON.stringify({
      type: 'user',
      cwd,
      timestamp: '2026-11-01T10:00:00.000Z',
      sessionId: id,
      message: { role: 'user', content: [{ type: 'text', text: firstText }] },
    }),
    JSON.stringify({
      type: 'assistant',
      cwd,
      sessionId: id,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it.' }] },
    }),
  ];
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  fs.utimesSync(filePath, mtime, mtime);
  return filePath;
};

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('encodeProjectDir', () => {
  it('matches the Claude Code project directory encoding', () => {
    expect(encodeProjectDir('/home/masato/Workspace/cc-sdd/example-test')).toBe(
      '-home-masato-Workspace-cc-sdd-example-test',
    );
    expect(encodeProjectDir('/home/masato/.claude')).toBe('-home-masato--claude');
  });
});

describe('parseSessionText', () => {
  it('extracts slash-command titles', () => {
    const text =
      '<command-message>kiro-impl</command-message>\n<command-name>/kiro-impl</command-name>\n<command-args>ubuntu-resource-summary</command-args>';
    expect(parseSessionText(text)).toEqual({
      title: '/kiro-impl ubuntu-resource-summary',
      skill: 'kiro-impl',
      feature: 'ubuntu-resource-summary',
    });
  });

  it('cleans system reminders from plain text', () => {
    const text =
      '<system-reminder>ignore me</system-reminder>\nFix the failing test in render.py';
    expect(parseSessionText(text).title).toBe('Fix the failing test in render.py');
  });

  it('returns an empty title for reminder-only messages', () => {
    expect(parseSessionText('<system-reminder>nothing here</system-reminder>').title).toBe('');
  });
});

describe('readSessionHead', () => {
  it('reads cwd, timestamp, and the first user title', () => {
    const projectsRoot = makeTempDir();
    const filePath = writeSession(
      projectsRoot,
      '/repo/a',
      'sess-1',
      '/repo/a',
      '<command-name>/kiro-spec-design</command-name>\n<command-args>demo</command-args>',
      new Date('2026-11-01T00:00:00Z'),
    );
    const head = readSessionHead(filePath);
    expect(head.cwd).toBe('/repo/a');
    expect(head.startedAt).toBe(Date.parse('2026-11-01T10:00:00.000Z'));
    expect(head.skill).toBe('kiro-spec-design');
    expect(head.feature).toBe('demo');
    expect(head.title).toBe('/kiro-spec-design demo');
  });
});

describe('listSessions', () => {
  it('lists only sessions for the workspace, newest first', () => {
    const projectsRoot = makeTempDir();
    writeSession(
      projectsRoot,
      '/repo/a',
      'older',
      '/repo/a',
      'First session',
      new Date('2026-11-01T00:00:00Z'),
    );
    writeSession(
      projectsRoot,
      '/repo/a',
      'newer',
      '/repo/a',
      '<command-name>/kiro-impl</command-name>\n<command-args>demo</command-args>',
      new Date('2026-11-02T00:00:00Z'),
    );
    // Same encoded directory, but the transcript belongs to another cwd.
    writeSession(
      projectsRoot,
      '/repo/a',
      'foreign',
      '/repo/b',
      'Should be filtered out',
      new Date('2026-11-03T00:00:00Z'),
    );

    const sessions = listSessions('/repo/a', projectsRoot);
    expect(sessions.map((session) => session.id)).toEqual(['newer', 'older']);
    expect(sessions[0].title).toBe('/kiro-impl demo');
    expect(sessions[0].skill).toBe('kiro-impl');
    expect(sessions[0].lastMessage).toBe('Working on it.');
  });

  it('returns an empty list when the project directory does not exist', () => {
    expect(listSessions('/does/not/exist', makeTempDir())).toEqual([]);
  });
});

describe('readSessionTail', () => {
  it('returns the last assistant text', () => {
    const projectsRoot = makeTempDir();
    const filePath = writeSession(
      projectsRoot,
      '/repo/a',
      'tail',
      '/repo/a',
      'First message',
      new Date('2026-11-01T00:00:00Z'),
    );
    expect(readSessionTail(filePath)).toBe('Working on it.');
  });

  it('returns undefined for a missing file', () => {
    expect(readSessionTail('/no/such/file.jsonl')).toBeUndefined();
  });
});

describe('readSessionTailInfo', () => {
  const writeTranscript = (name: string, entries: unknown[], mtime: Date): string => {
    const dir = makeTempDir();
    const filePath = path.join(dir, `${name}.jsonl`);
    fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    fs.utimesSync(filePath, mtime, mtime);
    return filePath;
  };

  const assistant = (content: unknown[]): unknown => ({
    type: 'assistant',
    message: { role: 'assistant', content },
  });

  it('marks a transcript with a stop marker as stopped', () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    const filePath = writeTranscript(
      'stopped',
      [
        { type: 'user', message: { content: [{ type: 'text', text: 'Run the tests' }] } },
        assistant([{ type: 'text', text: '184 passed.' }]),
        { type: 'system', subtype: 'stop_hook_summary' },
        { type: 'last-prompt' },
        { type: 'cost-state' },
      ],
      new Date(now - 1000),
    );

    const info = readSessionTailInfo(filePath, undefined, undefined, now);
    expect(info.activity.state).toBe('stopped');
    expect(info.lastMessage).toBe('184 passed.');
  });

  it('marks an unanswered AskUserQuestion as waiting', () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    const filePath = writeTranscript(
      'waiting',
      [
        assistant([{ type: 'text', text: 'I need one detail.' }]),
        assistant([{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [] } }]),
        { type: 'last-prompt' },
        { type: 'atis-latch' },
      ],
      new Date(now - 1000),
    );

    const info = readSessionTailInfo(filePath, undefined, undefined, now);
    expect(info.activity).toEqual({ state: 'waiting', pending: 'question' });
  });

  it('keeps a recent transcript with an open tool call running', () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    const filePath = writeTranscript(
      'running',
      [
        assistant([{ type: 'text', text: 'Checking the workspace.' }]),
        assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'pytest' } }]),
        { type: 'last-prompt' },
      ],
      new Date(now - 1000),
    );

    const info = readSessionTailInfo(filePath, undefined, undefined, now);
    expect(info.activity.state).toBe('running');
  });

  it('treats stale assistant text without a stop marker as stopped', () => {
    const now = Date.parse('2026-11-08T12:00:00Z');
    const filePath = writeTranscript(
      'stale',
      [assistant([{ type: 'text', text: 'Old output.' }])],
      new Date(now - 5 * 60 * 1000),
    );

    const info = readSessionTailInfo(filePath, undefined, undefined, now);
    expect(info.activity.state).toBe('stopped');
  });
});

describe('transcriptSegmentsFromLines', () => {
  it('converts user, assistant, and tool entries into console segments', () => {
    const lines = [
      JSON.stringify({ type: 'mode', mode: 'default' }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: '<command-name>/kiro-impl</command-name>\n<command-args>demo</command-args>',
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'hidden' },
            { type: 'text', text: 'Working on it.' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/repo/a/spec.md' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'file body', is_error: false }] },
      }),
    ];

    expect(transcriptSegmentsFromLines(lines)).toEqual([
      { kind: 'user', text: '/kiro-impl demo' },
      { kind: 'text', text: 'Working on it.' },
      { kind: 'tool', text: 'Read: /repo/a/spec.md' },
      { kind: 'toolresult', text: 'file body', isError: false },
    ]);
  });

  it('skips system-reminder-only messages and malformed lines', () => {
    const lines = [
      'not json',
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: '<system-reminder>meta</system-reminder>' }] },
      }),
    ];
    expect(transcriptSegmentsFromLines(lines)).toEqual([]);
  });
});

describe('readSessionUsage', () => {
  it('dedupes usage by message id and sums result costs', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'usage.jsonl');
    const lines = [
      {
        type: 'assistant',
        message: {
          id: 'm1',
          usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50 },
        },
      },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          usage: { input_tokens: 120, output_tokens: 12, cache_read_input_tokens: 50 },
        },
      },
      {
        type: 'assistant',
        message: { id: 'm2', usage: { input_tokens: 30, output_tokens: 5 } },
      },
      { type: 'result', total_cost_usd: 0.02 },
      { type: 'result', total_cost_usd: 0.03 },
      // Duplicate final message id should not be counted again.
      {
        type: 'assistant',
        message: { id: 'm2', usage: { input_tokens: 30, output_tokens: 5 } },
      },
    ];
    fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n'));

    const usage = readSessionUsage(filePath);
    expect(usage.usage).toEqual({
      inputTokens: 150,
      outputTokens: 17,
      cacheReadTokens: 50,
      cacheCreationTokens: 0,
    });
    expect(usage.costUsd).toBeCloseTo(0.05);
  });

  it('returns empty data for a missing file', () => {
    expect(readSessionUsage('/no/such/session.jsonl')).toEqual({});
  });

  it('prefers the latest cost-state entry', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'cost.jsonl');
    const lines = [
      {
        type: 'assistant',
        message: { id: 'm1', usage: { input_tokens: 1, output_tokens: 1 } },
      },
      {
        type: 'cost-state',
        totalCostUSD: 0.5,
        totalAPIDuration: 12000,
        totalToolDuration: 3000,
        totalLinesAdded: 10,
        totalLinesRemoved: 2,
        modelUsage: {
          'model-a': {
            inputTokens: 1000,
            outputTokens: 100,
            cacheReadInputTokens: 500,
            cacheCreationInputTokens: 50,
            costUSD: 0.5,
          },
        },
      },
      {
        type: 'cost-state',
        totalCostUSD: 0.8,
        totalAPIDuration: 20000,
        totalToolDuration: 5000,
        totalLinesAdded: 20,
        totalLinesRemoved: 4,
        modelUsage: {
          'model-a': {
            inputTokens: 2000,
            outputTokens: 200,
            cacheReadInputTokens: 800,
            cacheCreationInputTokens: 60,
            costUSD: 0.8,
          },
        },
      },
    ];
    fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n'));

    const info = readSessionUsage(filePath);
    expect(info.usage).toEqual({
      inputTokens: 2000,
      outputTokens: 200,
      cacheReadTokens: 800,
      cacheCreationTokens: 60,
    });
    expect(info.costUsd).toBeCloseTo(0.8);
    expect(info.apiMs).toBe(20000);
    expect(info.toolMs).toBe(5000);
    expect(info.linesAdded).toBe(20);
    expect(info.linesRemoved).toBe(4);
  });
});

describe('formatTokenCount', () => {
  it('formats compact token counts', () => {
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1234)).toBe('1.2k');
    expect(formatTokenCount(1_234_567)).toBe('1.2M');
  });
});

describe('formatWhen', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  it('formats recent timestamps relatively', () => {
    expect(formatWhen(now - 30_000, now)).toBe('just now');
    expect(formatWhen(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatWhen(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatWhen(now - 2 * 86_400_000, now)).toBe('2d ago');
    expect(formatWhen(Date.parse('2026-10-01T00:00:00Z'), now)).toBe('2026-10-01');
  });
});
