import { describe, expect, it } from 'vitest';
import { messagesFor } from '../../webview/messages';
import type { RunState } from '../../src/run/claudeRunner';
const run = {
  id: 'run-1',
  prompt: 'Follow-up',
  status: 'done',
  segments: [
    { kind: 'user', text: 'Original request' },
    { kind: 'tool', text: 'Read: file.ts' },
    { kind: 'toolresult', text: 'tool output' },
    { kind: 'text', text: 'Answer' },
    { kind: 'user', text: 'Follow-up' },
  ],
} as RunState;
describe('Runs conversation adapter', () => {
  it('keeps the original request and follow-up exactly once, omitting tool logs', () => {
    expect(messagesFor(run, []).map((message) => message.content)).toEqual([
      [{ type: 'text', text: 'Original request' }],
      [{ type: 'text', text: 'Answer' }],
      [{ type: 'text', text: 'Follow-up' }],
    ]);
  });
  it('includes session history and avoids duplicating the final response', () => {
    const result = messagesFor(
      { ...run, summary: { isError: false, text: 'Answer' } },
      [{ kind: 'user', text: 'Earlier request' }],
    );
    expect(result).toHaveLength(4);
    expect(result[0].role).toBe('user');
  });
});
