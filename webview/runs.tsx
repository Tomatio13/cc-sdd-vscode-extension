import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Play,
  Square,
  Terminal,
  Check,
  CheckCheck,
  X,
  ArrowRight,
  Rocket,
  Lightbulb,
  Hand,
  ShieldCheck,
  ShieldAlert,
  ChevronDown,
} from 'lucide-react';
import { createRoot } from 'react-dom/client';
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  MessagePrimitive,
  ComposerPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  RunState,
  RunSegment,
  PendingInteraction,
} from '../src/run/claudeRunner';
import './runs.css';
import { messagesFor } from './messages';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();
const send = (run: RunState, type: string, extra = {}) =>
  vscode.postMessage({ type, runId: run.id, ...extra });

function Message({ role = 'assistant' }: { role?: 'user' | 'assistant' }) {
  return (
    <MessagePrimitive.Root className="message" data-role={role}>
      <MessagePrimitive.Parts
        components={{
          Text: ({ text }) => (
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ children }) => <span>{children}</span>,
                img: () => null,
              }}
            >
              {text}
            </Markdown>
          ),
        }}
      />
    </MessagePrimitive.Root>
  );
}

function Pending({
  run,
  pending,
}: {
  run: RunState;
  pending: PendingInteraction;
}) {
  const [answers, setAnswers] = useState<Record<number, string[]>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});
  const [submitted, setSubmitted] = useState(false);
  if (pending.kind === 'permission')
    return (
      <section className="interaction" aria-label="Permission required">
        <h2>Allow {pending.toolName || 'tool'}?</h2>
        <pre>{pending.summary}</pre>
        {(['allow', 'always', 'deny'] as const).map((decision, i) => (
          <button
            key={decision}
            className="icon-button"
            aria-label={['Allow once', 'Always allow this tool', 'Deny'][i]}
            title={['Allow once', 'Always allow this tool', 'Deny'][i]}
            disabled={submitted}
            onClick={() => {
              setSubmitted(true);
              send(run, 'permission', { pendingId: pending.id, decision });
            }}
          >
            {i === 0 ? (
              <Check aria-hidden="true" />
            ) : i === 1 ? (
              <CheckCheck aria-hidden="true" />
            ) : (
              <X aria-hidden="true" />
            )}
          </button>
        ))}
      </section>
    );
  const questions = pending.questions || [];
  const labels = questions.map(
    (_, index) => custom[index]?.trim() || answers[index]?.join(', ') || '',
  );
  return (
    <form
      className="interaction"
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        send(run, 'answer', { pendingId: pending.id, labels });
      }}
    >
      {questions.map((question, index) => (
        <fieldset key={index} disabled={submitted}>
          <legend>{question.question}</legend>
          {question.options.map((option) => (
            <label className="option" key={option.label}>
              <input
                type={question.multiSelect ? 'checkbox' : 'radio'}
                name={`question-${index}`}
                checked={answers[index]?.includes(option.label) || false}
                onChange={(event) =>
                  setAnswers((previous) => ({
                    ...previous,
                    [index]: question.multiSelect
                      ? event.target.checked
                        ? [...(previous[index] || []), option.label]
                        : (previous[index] || []).filter(
                            (value) => value !== option.label,
                          )
                      : [option.label],
                  }))
                }
              />
              <span>
                {option.label}
                {option.description && <small>{option.description}</small>}
              </span>
            </label>
          ))}
          <input
            aria-label={`Custom answer: ${question.question}`}
            placeholder="Or type an answer"
            value={custom[index] || ''}
            onChange={(event) =>
              setCustom((previous) => ({
                ...previous,
                [index]: event.target.value,
              }))
            }
          />
        </fieldset>
      ))}
      <button
        className="icon-button"
        aria-label="Send answers"
        title="Send answers"
        disabled={
          submitted || !questions.length || labels.some((label) => !label)
        }
      >
        <ArrowUp aria-hidden="true" />
      </button>
    </form>
  );
}

const permissionModes = [
  {
    value: 'plan',
    label: 'プランモード',
    description: '編集前に計画を立てます',
    Icon: Lightbulb,
  },
  {
    value: 'default',
    label: '変更前に確認',
    description: 'ツールの実行前に確認します',
    Icon: Hand,
  },
  {
    value: 'acceptEdits',
    label: '編集を自動承認',
    description: 'ファイル編集を自動で許可します',
    Icon: ShieldCheck,
  },
  {
    value: 'bypassPermissions',
    label: 'フルアクセス',
    description: '権限確認を省略して実行します',
    Icon: ShieldAlert,
  },
];

function PermissionPicker({
  mode,
  disabled,
  onChange,
}: {
  mode: string;
  disabled: boolean;
  onChange: (mode: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected =
    permissionModes.find((item) => item.value === mode) || permissionModes[1];
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open) {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  return (
    <div className="permission-picker" ref={root}>
      <button
        type="button"
        className="permission-trigger"
        ref={trigger}
        disabled={disabled}
        aria-label={`権限モード: ${selected.label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <selected.Icon aria-hidden="true" />
        <span>{selected.label}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      {open && (
        <div
          className="permission-menu"
          role="dialog"
          aria-label="権限モードを選択"
        >
          {permissionModes.map(({ value, label, description, Icon }) => (
            <button
              type="button"
              key={value}
              className="permission-option"
              aria-pressed={mode === value}
              onClick={() => {
                onChange(value);
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <Icon aria-hidden="true" />
              <span>
                <strong>{label}</strong>
                <small>{description}</small>
              </span>
              <span className="selection-mark">
                {mode === value && <Check aria-hidden="true" />}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Run({ run, history }: { run: RunState; history: RunSegment[] }) {
  const [mode, setMode] = useState(
    run.preview
      ? run.preview.defaultPermissionMode || 'default'
      : run.permissionMode,
  );
  const running = run.status === 'running';
  const canSend = !running && (!!run.sessionId || !!run.preview);
  const runtime = useExternalStoreRuntime({
    messages: messagesFor(run, history),
    convertMessage: (message: ThreadMessageLike) => message,
    isRunning: running,
    onNew: async (message) => {
      if (!canSend) return;
      const instruction = message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      send(run, run.preview ? 'resumeConsole' : 'continue', {
        instruction,
        permissionMode: mode,
      });
    },
    onCancel: async () => {
      send(run, 'cancel');
    },
  });
  const actions = run.phaseActions;
  const usage = run.summary?.usage || run.usage;
  const cost = run.summary?.costUsd ?? run.usageCostUsd;
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <main>
        <header>
          <div>
            <h1>{run.feature || 'Run'}</h1>
            <span>
              {run.skill} · {run.pending ? 'Waiting for input' : run.status}
            </span>
          </div>
          {run.preview && (
            <nav>
              <button
                className="icon-button"
                aria-label="Resume in terminal"
                title="Resume in terminal"
                onClick={() => send(run, 'resumeTerminal')}
              >
                <Terminal aria-hidden="true" />
              </button>
            </nav>
          )}
        </header>
        <ThreadPrimitive.Root className="thread">
          <ThreadPrimitive.Viewport className="viewport">
            <ThreadPrimitive.Messages
              components={{
                UserMessage: () => <Message role="user" />,
                AssistantMessage: Message,
              }}
            />
            {running && (
              <p className="status" role="status">
                {run.pending
                  ? 'Waiting for your response…'
                  : 'Claude is working…'}
              </p>
            )}
            {run.pending && (
              <Pending key={run.pending.id} run={run} pending={run.pending} />
            )}
          </ThreadPrimitive.Viewport>
          <footer>
            <div className="metrics">
              {run.model}
              {usage &&
                ` · ${usage.inputTokens.toLocaleString()} in · ${usage.outputTokens.toLocaleString()} out · ${usage.cacheReadTokens.toLocaleString()} cache read`}
              {typeof cost === 'number' && ` · $${cost.toFixed(3)}`}
              {run.status === 'error' && ' · Run failed'}
            </div>
            {!running && actions && (
              <div className="actions">
                {actions.approve && (
                  <button
                    className="icon-button"
                    aria-label={`Approve ${actions.approve.label}`}
                    title={`Approve ${actions.approve.label}`}
                    onClick={() =>
                      send(run, 'approve', { phase: actions.approve!.phase })
                    }
                  >
                    <Check aria-hidden="true" />
                  </button>
                )}
                {actions.runNextPhase && (
                  <button
                    className="icon-button"
                    aria-label={`Run ${actions.runNextPhase.label}`}
                    title={`Run ${actions.runNextPhase.label}`}
                    onClick={() =>
                      send(run, 'runPhase', {
                        phase: actions.runNextPhase!.phase,
                      })
                    }
                  >
                    <ArrowRight aria-hidden="true" />
                  </button>
                )}
                {actions.runImpl && (
                  <button
                    className="icon-button"
                    aria-label="Run implementation"
                    title="Run implementation"
                    onClick={() => send(run, 'runImpl')}
                  >
                    <Rocket aria-hidden="true" />
                  </button>
                )}
              </div>
            )}
            <ComposerPrimitive.Root className="composer">
              <ComposerPrimitive.Input
                disabled={!canSend}
                placeholder={
                  running
                    ? 'Run in progress'
                    : canSend
                      ? 'Send a follow-up…'
                      : 'This run has no resumable session'
                }
                aria-label="Follow-up message"
              />
              <div className="composer-toolbar">
                <PermissionPicker
                  mode={mode}
                  disabled={running}
                  onChange={setMode}
                />
                <div className="composer-submit">
                  {running ? (
                    <ComposerPrimitive.Cancel
                      className="icon-button"
                      aria-label="Stop"
                      title="Stop"
                    >
                      <Square
                        aria-hidden="true"
                        fill="currentColor"
                        strokeWidth={0}
                      />
                    </ComposerPrimitive.Cancel>
                  ) : (
                    <ComposerPrimitive.Send
                      className="icon-button"
                      aria-label={run.preview ? 'Resume' : 'Send'}
                      title={run.preview ? 'Resume' : 'Send'}
                      disabled={!canSend}
                    >
                      {run.preview ? (
                        <Play aria-hidden="true" />
                      ) : (
                        <ArrowUp aria-hidden="true" />
                      )}
                    </ComposerPrimitive.Send>
                  )}
                </div>
              </div>
            </ComposerPrimitive.Root>
          </footer>
        </ThreadPrimitive.Root>
      </main>
    </AssistantRuntimeProvider>
  );
}

function App() {
  const [run, setRun] = useState<RunState>();
  const [history, setHistory] = useState<Record<string, RunSegment[]>>({});
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type === 'state' && Array.isArray(data.runs))
        setRun(data.runs[0]);
      if (data?.type === 'history' && Array.isArray(data.segments))
        setHistory((previous) => ({
          ...previous,
          [data.runId]: data.segments,
        }));
    };
    window.addEventListener('message', receive);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', receive);
  }, []);
  return run ? (
    <Run key={run.id} run={run} history={history[run.id] || []} />
  ) : (
    <p role="status">Loading run…</p>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
