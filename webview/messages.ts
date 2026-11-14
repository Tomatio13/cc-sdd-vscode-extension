import type { ThreadMessageLike } from '@assistant-ui/react';
import type { RunState, RunSegment } from '../src/run/claudeRunner';

export function messagesFor(
  run: RunState,
  history: RunSegment[],
): ThreadMessageLike[] {
  const segments: RunSegment[] = [...history];
  segments.push(...run.segments);
  const messages: ThreadMessageLike[] = [];
  for (const [index, segment] of segments.entries()) {
    if (
      !['text', 'user', 'error'].includes(segment.kind) ||
      !segment.text.trim()
    )
      continue;
    messages.push({
      id: `${run.id}-${index}`,
      role: segment.kind === 'user' ? 'user' : 'assistant',
      content: [{ type: 'text', text: segment.text }],
    });
  }
  const final = run.summary?.text;
  if (final && !segments.some((s) => s.kind === 'text' && s.text === final)) {
    messages.push({
      id: `${run.id}-summary`,
      role: 'assistant',
      content: [{ type: 'text', text: final }],
    });
  }
  return messages;
}
