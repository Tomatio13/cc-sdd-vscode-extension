import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  encodeProjectDir,
  formatWhen,
  listSessions,
  parseSessionText,
  readSessionHead,
  readSessionTail,
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
