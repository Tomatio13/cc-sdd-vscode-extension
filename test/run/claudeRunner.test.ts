import { describe, expect, it } from 'vitest';
import {
  applyRunEvent,
  eventsFromClaudeLine,
  extractQuestions,
  resolveClaudeExecutable,
  type RunState,
} from '../../src/run/claudeRunner';

const newRun = (): RunState => ({
  id: 'run-1',
  skill: 'kiro-spec-requirements',
  feature: 'demo',
  prompt: '/kiro-spec-requirements demo',
  permissionMode: 'acceptEdits',
  status: 'running',
  segments: [],
  startedAt: 0,
});

describe('eventsFromClaudeLine', () => {
  it('ignores malformed lines', () => {
    expect(eventsFromClaudeLine('not json')).toEqual([]);
    expect(eventsFromClaudeLine('{"type":}')).toEqual([]);
  });

  it('reads the init event', () => {
    const events = eventsFromClaudeLine(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'abc',
        model: 'claude-sonnet-4',
      }),
    );
    expect(events).toEqual([
      { kind: 'system', sessionId: 'abc', model: 'claude-sonnet-4' },
    ]);
  });

  it('splits assistant text and tool use blocks', () => {
    const events = eventsFromClaudeLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'Reading the spec.' },
            {
              type: 'tool_use',
              name: 'Read',
              input: { file_path: '/repo/.kiro/specs/demo/requirements.md' },
            },
          ],
        },
      }),
    );
    expect(events).toEqual([
      { kind: 'assistant', text: 'Reading the spec.' },
      {
        kind: 'assistant',
        tool: { name: 'Read', summary: '/repo/.kiro/specs/demo/requirements.md' },
      },
    ]);
  });

  it('ignores hook and progress system noise', () => {
    expect(
      eventsFromClaudeLine(
        JSON.stringify({
          type: 'system',
          subtype: 'hook_started',
          hook_name: 'SessionStart',
          hook_event: 'SessionStart',
          session_id: 'abc',
        }),
      ),
    ).toEqual([]);
    expect(
      eventsFromClaudeLine(
        JSON.stringify({
          type: 'system',
          subtype: 'hook_response',
          hook_name: 'SessionStart',
          outcome: 'success',
          session_id: 'abc',
        }),
      ),
    ).toEqual([]);
  });

  it('reports tool results with the error flag', () => {
    const events = eventsFromClaudeLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', content: 'ok', is_error: false }],
        },
      }),
    );
    expect(events).toEqual([{ kind: 'toolresult', text: 'ok', isError: false }]);
  });

  it('caps long tool results but keeps more than a preview', () => {
    const longText = 'x'.repeat(5000);
    const events = eventsFromClaudeLine(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: longText }] },
      }),
    );
    const text = (events[0] as { text: string }).text;
    expect(text).toHaveLength(1200);
    expect(text.endsWith('…')).toBe(true);
  });

  it('maps the final result payload', () => {
    const events = eventsFromClaudeLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'requirements written.',
        total_cost_usd: 0.12,
        num_turns: 4,
        duration_ms: 9500,
      }),
    );
    expect(events).toEqual([
      {
        kind: 'result',
        isError: false,
        text: 'requirements written.',
        costUsd: 0.12,
        turns: 4,
        durationMs: 9500,
      },
    ]);
  });

  it('marks non-success subtypes as errors', () => {
    const events = eventsFromClaudeLine(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: '',
      }),
    );
    expect(events).toEqual([
      { kind: 'result', isError: true, text: '', costUsd: undefined, turns: undefined, durationMs: undefined },
    ]);
  });
});

describe('applyRunEvent', () => {
  it('records model and session from init', () => {
    const run = newRun();
    applyRunEvent(run, { kind: 'system', sessionId: 'abc', model: 'claude-sonnet-4' });
    expect(run.sessionId).toBe('abc');
    expect(run.model).toBe('claude-sonnet-4');
    expect(run.segments).toHaveLength(1);
  });

  it('folds result events into the summary without a log segment', () => {
    const run = newRun();
    applyRunEvent(run, {
      kind: 'result',
      isError: false,
      text: 'requirements written.',
      costUsd: 0.1,
      turns: 3,
      durationMs: 4200,
    });
    expect(run.segments).toHaveLength(0);
    expect(run.summary).toEqual({
      isError: false,
      text: 'requirements written.',
      costUsd: 0.1,
      turns: 3,
      durationMs: 4200,
    });
  });

  it('caps the number of kept segments', () => {
    const run = newRun();
    for (let index = 0; index < 700; index += 1) {
      applyRunEvent(run, {
        kind: 'assistant',
        tool: { name: 'Bash', summary: `step-${index}` },
      });
    }
    expect(run.segments).toHaveLength(600);
    expect(run.segments.at(-1)?.text).toBe('Bash: step-699');
    expect(run.segments.at(0)?.text).toBe('Bash: step-100');
  });
});

describe('usage accounting', () => {
  it('dedupes assistant usage by message id', () => {
    const run = newRun();
    const first = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-1',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 0,
        },
        content: [{ type: 'text', text: 'First block' }],
      },
    });
    const second = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg-1',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 120,
          output_tokens: 15,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 0,
        },
        content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'x' } }],
      },
    });

    for (const line of [first, second]) {
      for (const event of eventsFromClaudeLine(line)) {
        applyRunEvent(run, event);
      }
    }

    expect(run.usage).toEqual({
      inputTokens: 120,
      outputTokens: 15,
      cacheReadTokens: 50,
      cacheCreationTokens: 0,
    });
    expect(run.turnUsage).toHaveLength(1);
  });

  it('uses modelUsage as the authoritative total on result', () => {
    const run = newRun();
    const assistant = JSON.stringify({
      type: 'assistant',
      message: { id: 'msg-1', usage: { input_tokens: 100, output_tokens: 10 } },
    });
    for (const event of eventsFromClaudeLine(assistant)) {
      applyRunEvent(run, event);
    }

    const result = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'ok',
      total_cost_usd: 0.05,
      num_turns: 2,
      duration_ms: 1000,
      modelUsage: {
        'claude-sonnet-4-6': {
          inputTokens: 300,
          outputTokens: 40,
          cacheReadInputTokens: 900,
          cacheCreationInputTokens: 70,
          costUSD: 0.05,
        },
      },
      permission_denials: [{}, {}],
      stop_reason: 'end_turn',
    });
    for (const event of eventsFromClaudeLine(result)) {
      applyRunEvent(run, event);
    }

    expect(run.usage).toEqual({
      inputTokens: 300,
      outputTokens: 40,
      cacheReadTokens: 900,
      cacheCreationTokens: 70,
    });
    expect(run.usageCostUsd).toBe(0.05);
    expect(run.permissionDenials).toBe(2);
    expect(run.summary?.stopReason).toBe('end_turn');
  });
});

describe('extractQuestions', () => {
  it('maps AskUserQuestion input to renderable specs', () => {
    const questions = extractQuestions({
      questions: [
        {
          question: 'Which database?',
          header: 'Database',
          multiSelect: false,
          options: [
            { label: 'SQLite', description: 'Single file' },
            { label: 'Postgres', description: 'Server' },
          ],
        },
        { question: 'Broken entry' },
      ],
    });
    expect(questions).toEqual([
      {
        question: 'Which database?',
        header: 'Database',
        multiSelect: false,
        options: [
          { label: 'SQLite', description: 'Single file' },
          { label: 'Postgres', description: 'Server' },
        ],
      },
    ]);
  });

  it('returns an empty list for malformed input', () => {
    expect(extractQuestions(undefined)).toEqual([]);
    expect(extractQuestions({ questions: 'nope' })).toEqual([]);
  });
});

describe('resolveClaudeExecutable', () => {
  it('returns an existing absolute path unchanged', () => {
    expect(resolveClaudeExecutable('/bin/sh')).toBe('/bin/sh');
  });

  it('returns the configured value when the command is unknown', () => {
    expect(resolveClaudeExecutable('cc-sdd-missing-binary-xyz')).toBe('cc-sdd-missing-binary-xyz');
  });
});
