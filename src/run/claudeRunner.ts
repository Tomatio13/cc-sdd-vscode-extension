// Headless Claude Code runner backed by the Claude Agent SDK. The SDK drives
// the local `claude` CLI and exposes permission / question callbacks that the
// Runs console renders as interactive cards.
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import {
  query,
  type CanUseTool,
  type PermissionMode,
  type Query,
} from '@anthropic-ai/claude-agent-sdk';

export type RunStatus = 'running' | 'done' | 'error' | 'cancelled' | 'preview';

export type RunSegmentKind = 'system' | 'text' | 'user' | 'tool' | 'toolresult' | 'error';

export interface RunSegment {
  kind: RunSegmentKind;
  text: string;
  isError?: boolean;
}

export interface RunSummary {
  isError: boolean;
  text: string;
  costUsd?: number;
  turns?: number;
  durationMs?: number;
}

export interface PhaseActionTarget {
  phase: string;
  label: string;
}

export interface PhaseActions {
  artifactPath?: string;
  approve?: PhaseActionTarget;
  runNextPhase?: PhaseActionTarget;
  runImpl?: boolean;
}

export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

export interface AskUserQuestionSpec {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskUserQuestionOption[];
}

export interface PendingInteraction {
  id: string;
  kind: 'permission' | 'question';
  toolName?: string;
  summary?: string;
  questions?: AskUserQuestionSpec[];
}

export interface RunState {
  id: string;
  skill: string;
  feature: string;
  prompt: string;
  permissionMode: string;
  status: RunStatus;
  segments: RunSegment[];
  history?: RunSegment[];
  summary?: RunSummary;
  sessionId?: string;
  model?: string;
  phaseActions?: PhaseActions;
  pending?: PendingInteraction;
  preview?: { sessionId: string; filePath: string; defaultPermissionMode?: string };
  startedAt: number;
  endedAt?: number;
}

export type RunEvent =
  | { kind: 'system'; sessionId?: string; model?: string }
  | { kind: 'assistant'; text?: string; tool?: { name: string; summary: string } }
  | { kind: 'toolresult'; text: string; isError: boolean }
  | { kind: 'pending'; pending: PendingInteraction }
  | { kind: 'result'; isError: boolean; text: string; costUsd?: number; turns?: number; durationMs?: number };

const shorten = (value: string, max = 200): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

// Tool results are folded into collapsible cards, so keep enough text to be
// useful while binding the webview payload size.
const TOOL_RESULT_LIMIT = 1200;
const FINAL_RESULT_LIMIT = 4000;

const TOOL_SUMMARY_KEYS = [
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

export const summarizeToolInput = (input: unknown): string => {
  const summary = (value: unknown): string => {
    if (typeof value === 'object' && value !== null) {
      const record = value as Record<string, unknown>;
      for (const key of TOOL_SUMMARY_KEYS) {
        const candidate = record[key];
        if (typeof candidate === 'string' && candidate.trim()) {
          return shorten(candidate.trim());
        }
      }
    }
    return '';
  };
  return summary(input);
};

export const extractQuestions = (input: unknown): AskUserQuestionSpec[] => {
  const raw = (input as { questions?: unknown } | null | undefined)?.questions;
  if (!Array.isArray(raw)) {
    return [];
  }

  const questions: AskUserQuestionSpec[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const question = item as {
      question?: unknown;
      header?: unknown;
      multiSelect?: unknown;
      options?: unknown;
    };
    if (typeof question.question !== 'string' || !question.question.trim()) {
      continue;
    }
    const options: AskUserQuestionOption[] = [];
    if (Array.isArray(question.options)) {
      for (const option of question.options) {
        if (typeof option !== 'object' || option === null) {
          continue;
        }
        const typed = option as { label?: unknown; description?: unknown };
        if (typeof typed.label === 'string' && typed.label.trim()) {
          options.push({
            label: typed.label.trim(),
            description: typeof typed.description === 'string' ? typed.description : undefined,
          });
        }
      }
    }
    // A question with no options cannot be answered in the console.
    if (options.length === 0) {
      continue;
    }
    questions.push({
      question: question.question.trim(),
      header: typeof question.header === 'string' ? question.header : undefined,
      multiSelect: question.multiSelect === true,
      options,
    });
  }
  return questions;
};

export interface ClaudeMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  message?: { content?: unknown };
  result?: unknown;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  is_error?: boolean;
  error?: unknown;
}

const asClaudeMessage = (value: unknown): ClaudeMessage | undefined =>
  typeof value === 'object' && value !== null ? (value as ClaudeMessage) : undefined;

const textFromContent = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Converts one SDK / stream-json message into zero or more run events.
 * Unknown or malformed messages are ignored.
 */
export const eventsFromClaudeMessage = (parsed: unknown): RunEvent[] => {
  const message = asClaudeMessage(parsed);
  if (!message) {
    return [];
  }

  const events: RunEvent[] = [];

  switch (message.type) {
    case 'system': {
      // stream-json carries many system subtypes (hook_started, hook_response,
      // progress, ...). Only the init event carries model/session metadata.
      if (message.subtype !== 'init') {
        break;
      }
      events.push({ kind: 'system', sessionId: message.session_id, model: message.model });
      break;
    }
    case 'assistant': {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== 'object' || block === null) {
            continue;
          }
          const typed = block as { type?: unknown; text?: unknown; name?: unknown; input?: unknown };
          if (typed.type === 'text' && typeof typed.text === 'string' && typed.text.trim()) {
            events.push({ kind: 'assistant', text: typed.text });
          } else if (typed.type === 'tool_use' && typeof typed.name === 'string') {
            events.push({
              kind: 'assistant',
              tool: { name: typed.name, summary: summarizeToolInput(typed.input) },
            });
          }
        }
      } else if (typeof content === 'string' && content.trim()) {
        events.push({ kind: 'assistant', text: content });
      }
      break;
    }
    case 'user': {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block !== 'object' || block === null) {
            continue;
          }
          const typed = block as { type?: unknown; content?: unknown; is_error?: unknown };
          if (typed.type === 'tool_result') {
            events.push({
              kind: 'toolresult',
              text: shorten(textFromContent(typed.content), TOOL_RESULT_LIMIT),
              isError: typed.is_error === true,
            });
          }
        }
      }
      break;
    }
    case 'result': {
      events.push({
        kind: 'result',
        isError: message.is_error === true || message.subtype !== 'success',
        text: shorten(textFromContent(message.result), FINAL_RESULT_LIMIT),
        costUsd: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : undefined,
        turns: typeof message.num_turns === 'number' ? message.num_turns : undefined,
        durationMs: typeof message.duration_ms === 'number' ? message.duration_ms : undefined,
      });
      break;
    }
    default:
      break;
  }

  return events;
};

/** Converts one NDJSON line (stream-json stdin/stdout format) into run events. */
export const eventsFromClaudeLine = (line: string): RunEvent[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  return eventsFromClaudeMessage(parsed);
};

const SEGMENT_LIMIT = 600;

export const describeRunEvent = (event: RunEvent): RunSegment[] => {
  switch (event.kind) {
    case 'system':
      return [
        {
          kind: 'system',
          text:
            [
              event.model ? `model ${event.model}` : undefined,
              event.sessionId ? `session ${event.sessionId}` : undefined,
            ]
              .filter(Boolean)
              .join(' · ') || 'started',
        },
      ];
    case 'assistant': {
      const list: RunSegment[] = [];
      if (event.text) {
        list.push({ kind: 'text', text: event.text });
      }
      if (event.tool) {
        list.push({
          kind: 'tool',
          text: event.tool.summary ? `${event.tool.name}: ${event.tool.summary}` : event.tool.name,
        });
      }
      return list;
    }
    case 'toolresult':
      return [{ kind: 'toolresult', text: event.text, isError: event.isError }];
    case 'pending':
      return [];
    case 'result':
      // The summary block renders separately in the console.
      return [];
  }
};

/** Pure reduction: folds a run event into a run state. */
export const applyRunEvent = (state: RunState, event: RunEvent): void => {
  if (event.kind === 'system') {
    state.sessionId = event.sessionId ?? state.sessionId;
    state.model = event.model ?? state.model;
    state.segments.push(...describeRunEvent(event));
    return;
  }
  if (event.kind === 'pending') {
    state.pending = event.pending;
    return;
  }
  if (event.kind === 'result') {
    state.summary = {
      isError: event.isError,
      text: event.text,
      costUsd: event.costUsd,
      turns: event.turns,
      durationMs: event.durationMs,
    };
    state.pending = undefined;
    return;
  }
  for (const segment of describeRunEvent(event)) {
    state.segments.push(segment);
  }
  if (state.segments.length > SEGMENT_LIMIT) {
    state.segments.splice(0, state.segments.length - SEGMENT_LIMIT);
  }
};

/** Resolves the configured claude binary to an absolute path when possible. */
export const resolveClaudeExecutable = (binary: string): string => {
  const candidates = process.platform === 'win32' ? [`${binary}.cmd`, `${binary}.exe`, binary] : [binary];
  const directories = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((directory) => directory.length > 0);

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) || candidate.includes(path.sep)) {
      if (existsSync(candidate)) {
        return candidate;
      }
      continue;
    }
    for (const directory of directories) {
      const fullPath = path.join(directory, candidate);
      try {
        if (statSync(fullPath).isFile()) {
          return fullPath;
        }
      } catch {
        // Keep looking.
      }
    }
  }

  return binary;
};

export type PermissionDecision = 'allow' | 'always' | 'deny';

export interface ClaudeRunHandle {
  cancel: () => void;
  respondPermission: (requestId: string, decision: PermissionDecision) => void;
  respondQuestion: (requestId: string, answers: Record<string, string>) => void;
}

export interface StartClaudeRunOptions {
  executable: string;
  cwd: string;
  prompt: string;
  permissionMode: string;
  resume?: string;
  onEvent: (event: RunEvent) => void;
  onExit: (exitCode: number | null, interrupted: boolean) => void;
}

const describeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('ENOENT') || message.includes('not found')) {
    return `${message} (set ccSdd.claudePath if the claude CLI is not on PATH)`;
  }
  return message;
};

export const startClaudeRun = (options: StartClaudeRunOptions): ClaudeRunHandle => {
  const resolvers = new Map<string, (value: unknown) => void>();
  const alwaysAllowed = new Set<string>();
  let sequence = 0;
  let cancelled = false;
  let sawResult = false;

  const canUseTool: CanUseTool = async (toolName, input) => {
    if (toolName === 'AskUserQuestion') {
      const questions = extractQuestions(input);
      if (questions.length === 0) {
        return { behavior: 'allow', updatedInput: input };
      }
      const requestId = `ask-${(sequence += 1)}`;
      const answers = await new Promise<Record<string, string>>((resolve) => {
        resolvers.set(requestId, (value) => resolve(value as Record<string, string>));
        options.onEvent({
          kind: 'pending',
          pending: { id: requestId, kind: 'question', toolName, questions },
        });
      });
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    }

    if (alwaysAllowed.has(toolName)) {
      return { behavior: 'allow', updatedInput: input };
    }

    const requestId = `perm-${(sequence += 1)}`;
    const decision = await new Promise<PermissionDecision>((resolve) => {
      resolvers.set(requestId, (value) => resolve(value as PermissionDecision));
      options.onEvent({
        kind: 'pending',
        pending: {
          id: requestId,
          kind: 'permission',
          toolName,
          summary: summarizeToolInput(input),
        },
      });
    });

    if (decision === 'deny') {
      return {
        behavior: 'deny',
        message: 'The user denied this tool call in the cc-sdd Runs console.',
      };
    }
    if (decision === 'always') {
      alwaysAllowed.add(toolName);
    }
    return { behavior: 'allow', updatedInput: input };
  };

  let active: Query | undefined;
  try {
    active = query({
      prompt: options.prompt,
      options: {
        cwd: options.cwd,
        permissionMode: options.permissionMode as PermissionMode,
        canUseTool,
        pathToClaudeCodeExecutable: options.executable,
        resume: options.resume,
      },
    });
  } catch (error) {
    options.onEvent({ kind: 'result', isError: true, text: describeError(error) });
    options.onExit(-1, false);
    return {
      cancel: () => undefined,
      respondPermission: () => undefined,
      respondQuestion: () => undefined,
    };
  }

  const session = active;
  void (async () => {
    try {
      for await (const message of session) {
        for (const event of eventsFromClaudeMessage(message)) {
          if (event.kind === 'result') {
            sawResult = true;
          }
          options.onEvent(event);
        }
        if (cancelled) {
          break;
        }
      }
      if (!sawResult && cancelled) {
        options.onEvent({ kind: 'result', isError: false, text: 'Run cancelled.' });
      }
      options.onExit(cancelled ? -1 : 0, cancelled);
    } catch (error) {
      options.onEvent({
        kind: 'result',
        isError: !cancelled,
        text: cancelled ? 'Run cancelled.' : describeError(error),
      });
      options.onExit(-1, cancelled);
    } finally {
      resolvers.clear();
    }
  })();

  return {
    cancel: () => {
      if (cancelled) {
        return;
      }
      cancelled = true;
      for (const resolve of resolvers.values()) {
        resolve('deny');
      }
      resolvers.clear();
      void session.interrupt?.().catch(() => undefined);
      void session.return?.(undefined).catch?.(() => undefined);
    },
    respondPermission: (requestId, decision) => {
      const resolve = resolvers.get(requestId);
      if (resolve) {
        resolvers.delete(requestId);
        resolve(decision);
      }
    },
    respondQuestion: (requestId, answers) => {
      const resolve = resolvers.get(requestId);
      if (resolve) {
        resolvers.delete(requestId);
        resolve(answers);
      }
    },
  };
};
