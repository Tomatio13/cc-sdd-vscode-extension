import type { RunSegment } from './claudeRunner';

/**
 * The last few tool calls of this turn, oldest first. A call stays in the
 * list after it finishes: most calls last only a few milliseconds, and an
 * update that kept only the running one would all but never show anything.
 * A new user message starts a new turn, so the previous turn is left behind.
 */
export const recentTools = (
  segments: readonly RunSegment[],
  limit = 3,
): string[] => {
  const tools: string[] = [];
  for (let index = segments.length - 1; index >= 0 && tools.length < limit; index -= 1) {
    const segment = segments[index];
    if (segment.kind === 'user') {
      break;
    }
    if (segment.kind === 'tool') {
      const text = segment.text.replace(/\s+/g, ' ').trim().slice(0, 200);
      if (text) {
        tools.push(text);
      }
    }
  }
  return tools.reverse();
};
