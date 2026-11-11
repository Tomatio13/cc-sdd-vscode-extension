import * as vscode from 'vscode';
import * as path from 'node:path';
import {
  listSpecs,
  readArtifact,
  readRoadmap,
  readSteering,
  readValidation,
  resolveKiroDir,
  toggleTaskCheckbox,
  updateApproval,
  type SpecRecord,
} from './core/repository';
import {
  PHASES,
  nextStepState,
  phaseStatus,
  type PhaseKey,
} from './core/spec';
import {
  DISCOVERY_SKILL,
  IMPLEMENTATION_SKILL,
  NEW_SPEC_SKILL,
  PHASE_META,
  STEERING_SKILL,
  VALIDATE_DESIGN_SKILL,
  VALIDATE_GAP_SKILL,
  VALIDATE_IMPL_SKILL,
} from './core/phases';
import { parseTasks, type ParsedTask } from './core/tasks';
import { validateArtifact } from './core/validation';
import { buildSpecProgress } from './core/progress';
import { claudeProjectDir, formatWhen, listSessions, readTranscriptSegments, type SessionRecord } from './core/sessions';
import {
  runInstall,
  runSkill,
  type AgentConfig,
  type AgentKind,
} from './launch/agentLauncher';
import { SpecTreeProvider, type SpecSort } from './ui/specTree';
import { StatusBar } from './ui/statusBar';
import { RunsStatusBar } from './ui/runsStatusBar';
import { TaskTreeProvider } from './ui/taskTree';
import { SessionsTreeProvider } from './ui/sessionsTree';
import { RunsConsole, type PhaseActions } from './ui/runsConsole';
import { OverviewPanel } from './ui/overviewPanel';
import { buildOverview, emptyOverview } from './core/overview';
import { resolveClaudeExecutable, type RunState } from './run/claudeRunner';

interface PhaseTarget {
  record: SpecRecord;
  phase: PhaseKey;
}

interface TaskTarget {
  record: SpecRecord;
  task: ParsedTask;
}

interface InstallOption extends vscode.QuickPickItem {
  args: string;
}

const isSpecRecord = (value: unknown): value is SpecRecord => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Partial<SpecRecord>;
  return typeof record.id === 'string' && typeof record.dir === 'string';
};

const isPhaseKey = (value: unknown): value is PhaseKey =>
  typeof value === 'string' && (PHASES as readonly string[]).includes(value);

/**
 * Tree context-menu commands receive the tree element, not the TreeItem.
 * Spec elements wrap the record as { kind: 'spec', record }, while item
 * commands pass the record directly. Accept both shapes.
 */
const recordFromArg = (value: unknown): SpecRecord | undefined => {
  if (isSpecRecord(value)) {
    return value;
  }

  if (typeof value === 'object' && value !== null) {
    const candidate = value as { record?: unknown };
    if (isSpecRecord(candidate.record)) {
      return candidate.record;
    }
  }

  return undefined;
};

const phaseTarget = (value: unknown): PhaseTarget | undefined => {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const candidate = value as { record?: unknown; phase?: unknown };
  if (!isSpecRecord(candidate.record) || !isPhaseKey(candidate.phase)) {
    return undefined;
  }

  return { record: candidate.record, phase: candidate.phase };
};

const taskTarget = (value: unknown): TaskTarget | undefined => {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const candidate = value as { record?: unknown; task?: unknown };
  if (!isSpecRecord(candidate.record) || typeof candidate.task !== 'object' || candidate.task === null) {
    return undefined;
  }

  return { record: candidate.record, task: candidate.task as ParsedTask };
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const statusBar = new StatusBar();
  const runsStatusBar = new RunsStatusBar();
  let activeSpecId = context.workspaceState.get<string>('ccSdd.activeSpec');
  let watcher: vscode.FileSystemWatcher | undefined;
  let sessionsWatcher: vscode.FileSystemWatcher | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;
  let overviewPanel: OverviewPanel | undefined;

  const workspaceRoot = (): string | undefined =>
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const configuration = (): vscode.WorkspaceConfiguration =>
    vscode.workspace.getConfiguration('ccSdd');

  const kiroDir = (): string => configuration().get<string>('kiroDir', '.kiro');

  const agentConfig = (): AgentConfig => ({
    agent: configuration().get<AgentKind>('agent', 'claude'),
    customCommand: configuration().get<string>('customCommand', ''),
  });

  const loadSpecs = async (): Promise<SpecRecord[]> => {
    const root = workspaceRoot();
    if (!root) {
      return [];
    }
    return listSpecs(root, kiroDir());
  };

  const progressFor = async (record: SpecRecord) => {
    const [tasks, validation] = await Promise.all([
      readArtifact(record, 'tasks'),
      readValidation(record),
    ]);
    return buildSpecProgress(record, tasks, validation);
  };

  const specProvider = new SpecTreeProvider(
    loadSpecs,
    (record) => readArtifact(record, 'tasks'),
    (record) => readValidation(record),
    () => runsConsole.getRuns(),
    async () => {
      const root = workspaceRoot();
      if (!root) {
        return {
          steering: { generated: false, missing: ['product.md', 'tech.md', 'structure.md'], files: [] },
          roadmap: undefined,
        };
      }
      const [steering, roadmap] = await Promise.all([
        readSteering(root, kiroDir()),
        readRoadmap(root, kiroDir()),
      ]);
      return { steering, roadmap };
    },
    () => configuration().get<SpecSort>('specSort', 'newest'),
  );

  const getActiveSpec = async (): Promise<SpecRecord | undefined> => {
    const records = await loadSpecs();
    if (activeSpecId && !records.some((record) => record.id === activeSpecId)) {
      activeSpecId = records[0]?.id;
    }
    if (!activeSpecId) {
      activeSpecId = records[0]?.id;
    }
    return records.find((record) => record.id === activeSpecId);
  };

  const taskProvider = new TaskTreeProvider(
    (record) => readArtifact(record, 'tasks'),
    (record) => readValidation(record),
    () => runsConsole.getRuns(),
  );

  const sessionsProvider = new SessionsTreeProvider(
    async () => {
      const root = workspaceRoot();
      return root ? listSessions(root) : [];
    },
    loadSpecs,
    () => runsConsole.getRuns(),
  );

  const showError = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`cc-sdd: ${message}`);
  };

  const register = (
    command: string,
    handler: (...args: unknown[]) => Promise<void>,
  ): vscode.Disposable =>
    vscode.commands.registerCommand(command, (...args: unknown[]) => {
      void handler(...args).catch(showError);
    });

  const openFile = async (filePath: string): Promise<void> => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(document, { preview: false });
  };

  const openFileAtLine = async (filePath: string, line: number): Promise<void> => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const position = new vscode.Position(Math.max(0, line), 0);
    const selection = new vscode.Selection(position, position);
    editor.selection = selection;
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
  };

  const refresh = async (): Promise<void> => {
    const active = await getActiveSpec();
    const progress = active ? await progressFor(active) : undefined;
    specProvider.setActive(active?.id);
    specProvider.refresh();
    taskProvider.setActive(active);
    statusBar.update(active, progress);
    sessionsProvider.setActive(active);
    overviewPanel?.scheduleRefresh(150);

    if (activeSpecId) {
      await context.workspaceState.update('ccSdd.activeSpec', activeSpecId);
    }
  };

  const scheduleRefresh = (): void => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      void refresh().catch(showError);
    }, 150);
  };

  const setupWatcher = (): void => {
    watcher?.dispose();
    watcher = undefined;

    const root = workspaceRoot();
    const enabled = configuration().get<boolean>('autoRefresh', true);
    if (!root || !enabled) {
      return;
    }

    const watchRoot = vscode.Uri.file(resolveKiroDir(root, kiroDir()));
    watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(watchRoot, '**/*'),
    );
    watcher.onDidCreate(scheduleRefresh);
    watcher.onDidChange(scheduleRefresh);
    watcher.onDidDelete(scheduleRefresh);
    context.subscriptions.push(watcher);

    sessionsWatcher?.dispose();
    sessionsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(claudeProjectDir(root)), '*.jsonl'),
    );
    sessionsWatcher.onDidCreate(scheduleRefresh);
    sessionsWatcher.onDidChange(scheduleRefresh);
    sessionsWatcher.onDidDelete(scheduleRefresh);
    context.subscriptions.push(sessionsWatcher);
  };

  const selectSpec = async (arg?: unknown): Promise<void> => {
    const record = recordFromArg(arg);
    if (!record) {
      return;
    }

    activeSpecId = record.id;
    await context.workspaceState.update('ccSdd.activeSpec', activeSpecId);
    specProvider.setActive(record.id);
    taskProvider.setActive(record);
    sessionsProvider.setActive(record);
    statusBar.update(record, await progressFor(record));
  };

  const runPhase = async (record: SpecRecord, phase: PhaseKey): Promise<void> => {
    const root = workspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage('cc-sdd: open a workspace first.');
      return;
    }

    await selectSpec(record);
    await runSkill(agentConfig(), root, record.id, PHASE_META[phase].skill, runSkillOptions);
  };

  const openArtifact = async (target: PhaseTarget): Promise<void> => {
    const meta = PHASE_META[target.phase];
    if (!target.record.exists[target.phase]) {
      const action = await vscode.window.showInformationMessage(
        `${meta.file} does not exist yet.`,
        'Run phase',
      );
      if (action === 'Run phase') {
        await runPhase(target.record, target.phase);
      }
      return;
    }

    await openFile(target.record.artifacts[target.phase]);
  };

  const approvePhase = async (target: PhaseTarget): Promise<void> => {
    const root = workspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage('cc-sdd: open a workspace first.');
      return;
    }

    const meta = PHASE_META[target.phase];
    const content = await readArtifact(target.record, target.phase);
    const result = validateArtifact(
      target.phase,
      content,
      target.record.spec?.language,
    );

    if (result.errors.length > 0) {
      const action = await vscode.window.showErrorMessage(
        `${meta.label} cannot be approved:\n- ${result.errors.join('\n- ')}`,
        { modal: false },
        'Open file',
      );
      if (action === 'Open file' && content !== undefined) {
        await openFile(target.record.artifacts[target.phase]);
      }
      return;
    }

    if (result.warnings.length > 0) {
      const choice = await vscode.window.showWarningMessage(
        `${meta.label} has warnings:\n- ${result.warnings.join('\n- ')}`,
        { modal: true },
        'Approve anyway',
      );
      if (choice !== 'Approve anyway') {
        return;
      }
    }

    const updated = await updateApproval(
      root,
      kiroDir(),
      target.record.id,
      target.phase,
      true,
    );
    await refresh();

    if (updated.ready_for_implementation) {
      void vscode.window.showInformationMessage(
        `All phases approved. Ready for /${IMPLEMENTATION_SKILL} ${target.record.id}.`,
      );
    } else {
      void vscode.window.showInformationMessage(`${meta.label} approved.`);
    }
  };

  const revokePhase = async (target: PhaseTarget): Promise<void> => {
    const root = workspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage('cc-sdd: open a workspace first.');
      return;
    }

    const meta = PHASE_META[target.phase];
    const choice = await vscode.window.showWarningMessage(
      `Revoke approval for ${meta.label}?`,
      { modal: true },
      'Revoke',
    );
    if (choice !== 'Revoke') {
      return;
    }

    await updateApproval(root, kiroDir(), target.record.id, target.phase, false);
    await refresh();
  };

  const activeRunFor = (record: SpecRecord, skills?: string[]): RunState | undefined =>
    runsConsole
      .getRuns()
      .find(
        (run) =>
          run.feature === record.id &&
          (run.pending !== undefined || run.status === 'running') &&
          (skills === undefined || skills.includes(run.skill)),
      );

  const taskIdsFromPrompt = (prompt: string): string[] =>
    (prompt.match(/(?:^|\s)(\d+(?:\.\d+)*)(?=\s|$)/g) ?? []).map((match) => match.trim());

  const activeImplementationRun = (
    record: SpecRecord,
    taskIds?: string[],
  ): RunState | undefined => {
    const active = runsConsole
      .getRuns()
      .filter(
        (run) =>
          run.feature === record.id &&
          run.skill === IMPLEMENTATION_SKILL &&
          (run.pending !== undefined || run.status === 'running'),
      );
    if (active.length === 0) {
      return undefined;
    }
    if (!taskIds || taskIds.length === 0) {
      return active[0];
    }
    const requested = new Set(taskIds);
    return active.find((run) => {
      const running = taskIdsFromPrompt(run.prompt);
      return running.length === 0 || running.some((id) => requested.has(id));
    });
  };

  const runImplementation = async (
    record: SpecRecord,
    taskIds?: string[],
  ): Promise<void> => {
    const root = workspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage('cc-sdd: open a workspace first.');
      return;
    }

    const active = activeImplementationRun(record, taskIds);
    if (active) {
      runsConsole.openRun(active.id);
      void vscode.window.showInformationMessage(
        `cc-sdd: the requested implementation target is already running. Opened it instead.`,
      );
      return;
    }

    if (record.spec?.ready_for_implementation !== true) {
      const choice = await vscode.window.showWarningMessage(
        'Not all phases are approved. Run implementation anyway?',
        { modal: true },
        'Run anyway',
      );
      if (choice !== 'Run anyway') {
        return;
      }
    }

    await selectSpec(record);
    await runSkill(agentConfig(), root, record.id, IMPLEMENTATION_SKILL, {
      ...runSkillOptions,
      args: taskIds && taskIds.length > 0 ? taskIds.join(' ') : undefined,
    });
  };

  const runValidateImpl = async (record: SpecRecord): Promise<void> => {
    const root = workspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage('cc-sdd: open a workspace first.');
      return;
    }

    const active = activeRunFor(record, [VALIDATE_IMPL_SKILL]);
    if (active) {
      runsConsole.openRun(active.id);
      void vscode.window.showInformationMessage(
        'cc-sdd: verification is already running for this spec. Opened it instead.',
      );
      return;
    }

    await selectSpec(record);
    await runSkill(agentConfig(), root, record.id, VALIDATE_IMPL_SKILL, runSkillOptions);
  };

  const runTask = async (record: SpecRecord, task: ParsedTask): Promise<void> => {
    await runImplementation(record, [task.id]);
  };

  const runFromTask = async (record: SpecRecord, task: ParsedTask): Promise<void> => {
    const content = await readArtifact(record, 'tasks');
    const tasks = parseTasks(content ?? '');
    const index = tasks.findIndex(
      (candidate) => candidate.line === task.line && candidate.id === task.id,
    );
    const remaining = (index === -1 ? tasks : tasks.slice(index))
      .filter((candidate) => !candidate.checked)
      .map((candidate) => candidate.id);
    if (remaining.length === 0) {
      void vscode.window.showInformationMessage('cc-sdd: no remaining tasks from this point.');
      return;
    }
    await runImplementation(record, remaining);
  };

  const openSpecRun = (record: SpecRecord): void => {
    const active = activeRunFor(record, [IMPLEMENTATION_SKILL]) ?? activeRunFor(record);
    if (active) {
      runsConsole.openRun(active.id);
    } else {
      void vscode.window.showInformationMessage('cc-sdd: no active run for this spec.');
    }
  };

  const openValidation = async (record: SpecRecord): Promise<void> => {
    if (!record.validationExists) {
      void vscode.window.showInformationMessage(
        'cc-sdd: no implementation validation report yet. Run validation first.',
      );
      return;
    }
    await openFile(record.validationPath);
  };

  const runWithSkill = async (skill: string, feature = ''): Promise<void> => {
    const root = workspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage('cc-sdd: open a workspace first.');
      return;
    }

    await runSkill(agentConfig(), root, feature, skill, runSkillOptions);
  };

  const runDiscovery = async (): Promise<void> => {
    const root = workspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage('cc-sdd: open a workspace first.');
      return;
    }

    const description = await vscode.window.showInputBox({
      prompt: 'Run Discovery: describe the work, or leave empty to resume from existing brief/roadmap',
      placeHolder: 'Photo albums with upload, tagging, and sharing',
    });

    await runWithSkill(DISCOVERY_SKILL, description?.trim() ?? '');
  };

  const runValidateOnActive = async (
    getSkill: () => string,
    label: string,
  ): Promise<void> => {
    const records = await loadSpecs();
    const record = records.find((candidate) => candidate.id === activeSpecId) ?? records[0];
    if (!record) {
      void vscode.window.showInformationMessage(`cc-sdd: ${label} needs a spec.`);
      return;
    }

    await selectSpec(record);
    await runWithSkill(getSkill(), record.id);
  };


  const newSpec = async (): Promise<void> => {
    const root = workspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage('cc-sdd: open a workspace first.');
      return;
    }

    const description = await vscode.window.showInputBox({
      prompt: 'Describe the feature or initiative',
      placeHolder: 'Photo albums with upload, tagging, and sharing',
    });
    if (!description?.trim()) {
      return;
    }

    await runSkill(agentConfig(), root, description.trim(), NEW_SPEC_SKILL, runSkillOptions);
  };

  const PHASE_BY_SKILL = new Map<string, PhaseKey>(
    PHASES.map((phase) => [PHASE_META[phase].skill, phase]),
  );

  const askPermissionMode = async (): Promise<string | undefined> => {
    const fallback = configuration().get<string>('consolePermissionMode', 'default');
    const picked = await vscode.window.showQuickPick(
      (
        [
          'default',
          'acceptEdits',
          'bypassPermissions',
          'plan',
        ] as const
      ).map((mode) => ({
        label: mode,
        description:
          mode === 'default'
            ? 'Ask me in the Runs console before gated tools (recommended)'
            : mode === 'acceptEdits'
              ? 'Auto-accept file edits; other tools are denied in headless mode'
              : mode === 'bypassPermissions'
                ? 'Allow every tool incl. Bash; fully unattended'
                : 'Read-only planning',
        picked: mode === fallback,
      })),
      {
        placeHolder:
          'Permission mode for this headless run (default: ccSdd.consolePermissionMode)',
      },
    );
    return picked?.label;
  };

  const launchConsoleRun = async (
    prompt: string,
    meta: { skill: string; feature: string },
  ): Promise<void> => {
    const permissionMode = await askPermissionMode();
    if (!permissionMode) {
      return;
    }
    runsConsole.startRun({ skill: meta.skill, feature: meta.feature, prompt, permissionMode });
  };

  // Headless runs launch skills with the per-run permission pick.
  const runSkillOptions = { consoleLauncher: launchConsoleRun };

  const runsConsole = new RunsConsole({
    getWorkspaceRoot: () => workspaceRoot(),
    getBinary: () =>
      resolveClaudeExecutable(configuration().get<string>('claudePath', 'claude')),
    getRunsDir: () => {
      const root = workspaceRoot();
      return root ? path.join(resolveKiroDir(root, kiroDir()), 'runs') : undefined;
    },
    getPhaseActions: async (skill: string, feature: string): Promise<PhaseActions> => {
      const record = (await loadSpecs()).find((candidate) => candidate.id === feature);
      if (!record) {
        return {};
      }
      const actions: PhaseActions = {};

      if (skill === IMPLEMENTATION_SKILL) {
        actions.artifactPath = record.artifacts.tasks;
        if (record.spec?.ready_for_implementation === true) {
          actions.runImpl = true;
        }
        return actions;
      }

      const phase = PHASE_BY_SKILL.get(skill);
      if (!phase || !record.spec) {
        return actions;
      }
      actions.artifactPath = record.artifacts[phase];
      const approval = record.spec.approvals[phase];
      if (approval?.generated === true && approval?.approved !== true) {
        actions.approve = { phase, label: PHASE_META[phase].label };
      }
      if (approval?.approved === true) {
        const index = PHASES.indexOf(phase);
        const next = PHASES.slice(index + 1).find(
          (candidate) => record.spec?.approvals[candidate]?.approved !== true,
        );
        if (next) {
          actions.runNextPhase = { phase: next, label: PHASE_META[next].label };
        } else if (record.spec.ready_for_implementation === true) {
          actions.runImpl = true;
        }
      }
      return actions;
    },
    approvePhase: async (feature: string, phase: string) => {
      if (!isPhaseKey(phase)) {
        return;
      }
      const record = (await loadSpecs()).find((candidate) => candidate.id === feature);
      if (record) {
        await approvePhase({ record, phase });
      }
    },
    runPhase: async (feature: string, phase: string) => {
      if (!isPhaseKey(phase)) {
        return;
      }
      const record = (await loadSpecs()).find((candidate) => candidate.id === feature);
      if (record) {
        await runPhase(record, phase);
      }
    },
    runImplementation: async (feature: string) => {
      const record = (await loadSpecs()).find((candidate) => candidate.id === feature);
      if (record) {
        await runImplementation(record);
      }
    },
    openPath: openFile,
    rerun: async (skill: string, feature: string) => {
      const record = (await loadSpecs()).find((candidate) => candidate.id === feature);
      if (!record) {
        return;
      }
      const phase = PHASE_BY_SKILL.get(skill);
      if (phase) {
        await runPhase(record, phase);
        return;
      }
      if (skill === IMPLEMENTATION_SKILL) {
        await runImplementation(record);
        return;
      }
      await runWithSkill(skill, record.id);
    },
    resumeTerminal: async (sessionId: string) => {
      resumeInTerminal(sessionId);
    },
    openOverview: () => overviewPanel?.show(),
  });

  const sessionFromArg = (value: unknown): SessionRecord | undefined => {
    if (typeof value !== 'object' || value === null) {
      return undefined;
    }
    const wrapped = value as { session?: unknown };
    const candidate = (wrapped.session ?? value) as Partial<SessionRecord>;
    return typeof candidate.id === 'string' && typeof candidate.filePath === 'string'
      ? (candidate as SessionRecord)
      : undefined;
  };

  const quoteShell = (value: string): string => `"${value.replace(/(["\\$`])/g, '\\$1')}"`;

  const resumeInTerminal = (sessionId: string, title?: string): void => {
    const root = workspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage('cc-sdd: open a workspace first.');
      return;
    }
    const binary = configuration().get<string>('claudePath', 'claude');
    const terminal = vscode.window.createTerminal({
      name: `cc-sdd: resume ${title ?? sessionId.slice(0, 8)}`,
      cwd: root,
    });
    terminal.show();
    terminal.sendText(`${quoteShell(binary)} --resume ${quoteShell(sessionId)}`, true);
  };

  const resumeInConsole = async (
    sessionId: string,
    filePath: string,
    skill?: string,
    feature?: string,
  ): Promise<void> => {
    if (!workspaceRoot()) {
      void vscode.window.showErrorMessage('cc-sdd: open a workspace first.');
      return;
    }
    const instruction = await vscode.window.showInputBox({
      prompt: 'Message to continue this session (leave empty to just continue)',
      placeHolder: 'e.g. Continue with the remaining tasks',
    });
    if (instruction === undefined) {
      return;
    }
    const permissionMode = await askPermissionMode();
    if (!permissionMode) {
      return;
    }
    runsConsole.startRun({
      skill: skill ?? 'resume',
      feature: feature ?? sessionId.slice(0, 8),
      prompt: instruction.trim() || 'Continue from where you left off.',
      permissionMode,
      resume: sessionId,
      history: readTranscriptSegments(filePath),
    });
  };

  const previewSession = async (arg?: unknown): Promise<void> => {
    const session = sessionFromArg(arg);
    if (!session) {
      return;
    }
    if (!workspaceRoot()) {
      void vscode.window.showErrorMessage('cc-sdd: open a workspace first.');
      return;
    }
    runsConsole.previewSession({
      title: session.title,
      skill: session.skill,
      feature: session.feature,
      sessionId: session.id,
      filePath: session.filePath,
      history: readTranscriptSegments(session.filePath),
      defaultPermissionMode: configuration().get<string>('consolePermissionMode', 'default'),
      usage: session.usage,
      costUsd: session.costUsd,
    });
  };

  const resumeSession = async (arg?: unknown): Promise<void> => {
    const session = sessionFromArg(arg);
    if (!session) {
      return;
    }
    if (!workspaceRoot()) {
      void vscode.window.showErrorMessage('cc-sdd: open a workspace first.');
      return;
    }

    const action = await vscode.window.showQuickPick(
      [
        {
          label: '$(preview) Preview transcript',
          description: 'Read the session before deciding to resume',
          value: 'preview',
        },
        {
          label: '$(play) Resume in Runs console',
          description: 'Headless continuation with a new instruction',
          value: 'console',
        },
        {
          label: '$(terminal) Resume in terminal',
          description: `claude --resume ${session.id.slice(0, 8)}…`,
          value: 'terminal',
        },
        {
          label: '$(go-to-file) Open raw transcript',
          description: session.filePath,
          value: 'open',
        },
        { label: '$(copy) Copy session id', value: 'copy' },
      ],
      { placeHolder: `${session.title} · ${formatWhen(session.updatedAt)}` },
    );
    if (!action) {
      return;
    }

    if (action.value === 'preview') {
      await previewSession(session);
      return;
    }
    if (action.value === 'open') {
      await openFile(session.filePath);
      return;
    }
    if (action.value === 'copy') {
      await vscode.env.clipboard.writeText(session.id);
      void vscode.window.showInformationMessage('cc-sdd: session id copied.');
      return;
    }
    if (action.value === 'terminal') {
      resumeInTerminal(session.id, session.title);
      return;
    }
    await resumeInConsole(session.id, session.filePath, session.skill, session.feature);
  };

  const loadOverview = async () => {
    const root = workspaceRoot();
    if (!root) {
      return emptyOverview(Date.now(), vscode.workspace.name ?? 'Workspace');
    }
    const records = await loadSpecs();
    const [taskContents, validations, roadmap] = await Promise.all([
      Promise.all(records.map((record) => readArtifact(record, 'tasks'))),
      Promise.all(records.map((record) => readValidation(record))),
      readRoadmap(root, kiroDir()),
    ]);
    return buildOverview({
      projectName: vscode.workspace.name ?? path.basename(root),
      specs: records.map((record, index) => ({
        record,
        tasks: taskContents[index],
        validation: validations[index],
      })),
      runs: runsConsole.getRuns(),
      roadmap,
      now: Date.now(),
    });
  };

  overviewPanel = new OverviewPanel({
    load: loadOverview,
    openSpec: async (specId: string) => {
      const record = (await loadSpecs()).find((candidate) => candidate.id === specId);
      if (!record) {
        return;
      }
      await selectSpec(record);
      const tasksContent = await readArtifact(record, 'tasks');
      const tasks = parseTasks(tasksContent ?? '');
      const step = nextStepState(record.spec, {
        done: tasks.filter((task) => task.checked).length,
        total: tasks.length,
      });
      if (step.kind === 'review') {
        await openArtifact({ record, phase: step.phase });
        return;
      }
      if (record.exists.tasks) {
        await openFile(record.artifacts.tasks);
      } else if (record.exists.requirements) {
        await openFile(record.artifacts.requirements);
      } else {
        await openFile(record.specJsonPath);
      }
    },
    openRun: (runId: string) => runsConsole.openRun(runId),
    openRuns: () => runsConsole.show(),
  });
  context.subscriptions.push(
    runsConsole.onDidChange(() => {
      runsStatusBar.update(runsConsole.getRuns());
      overviewPanel?.scheduleRefresh();
    }),
  );

  const install = async (): Promise<void> => {
    const root = workspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage('cc-sdd: open a workspace first.');
      return;
    }

    const options: InstallOption[] = [
      { label: 'Claude Code Skills', description: '--claude-skills', args: '--claude-skills' },
      { label: 'Codex Skills', description: '--codex-skills', args: '--codex-skills' },
      { label: 'GitHub Copilot Skills', description: '--copilot-skills', args: '--copilot-skills' },
      { label: 'Cursor Skills', description: '--cursor-skills', args: '--cursor-skills' },
      { label: 'OpenCode Skills', description: '--opencode-skills', args: '--opencode-skills' },
      { label: 'Gemini CLI Skills', description: '--gemini-skills', args: '--gemini-skills' },
      { label: 'Custom arguments', description: 'Enter your own flags', args: '' },
    ];

    const picked = await vscode.window.showQuickPick(options, {
      placeHolder: 'Select the cc-sdd integration to install',
    });
    if (!picked) {
      return;
    }

    let args = picked.args;
    if (!args) {
      const input = await vscode.window.showInputBox({
        prompt: 'Arguments for npx cc-sdd@latest',
        value: '--claude-skills',
      });
      if (input === undefined) {
        return;
      }
      args = input.trim();
    }

    if (!args) {
      return;
    }

    const language = configuration().get<string>('installLanguage', '').trim();
    runInstall(root, args, language);
  };

  const pickSpec = async (): Promise<void> => {
    const records = await loadSpecs();
    if (records.length === 0) {
      void vscode.window.showInformationMessage('cc-sdd: no specs found.');
      return;
    }

    const picked = await vscode.window.showQuickPick(
      records.map((record) => ({
        label: record.spec?.feature_name?.trim() || record.id,
        description: record.spec?.phase ?? 'spec.json missing',
        detail: record.dir,
        record,
      })),
      { placeHolder: 'Select the active spec' },
    );
    if (!picked) {
      return;
    }

    await selectSpec(picked.record);
  };

  const showStatus = async (arg?: unknown): Promise<void> => {
    const records = await loadSpecs();
    const record =
      recordFromArg(arg) ??
      records.find((candidate) => candidate.id === activeSpecId) ??
      records[0];

    if (!record) {
      void vscode.window.showInformationMessage('cc-sdd: no specs found.');
      return;
    }

    const label = record.spec?.feature_name?.trim() || record.id;
    const progress = await progressFor(record);
    const action = progress.completed ? 'Completed' : progress.next.label;
    const lines = [
      `# ${label}`,
      '',
      `- Path: \`${record.dir}\``,
      `- Phase: \`${record.spec?.phase ?? 'unknown'}\``,
      `- Stage: ${progress.stageLabel}`,
      `- State: ${progress.stateLabel}`,
      `- Ready for implementation: ${record.spec?.ready_for_implementation ? 'yes' : 'no'}`,
      `- Implementation: ${progress.tasksDone}/${progress.tasksTotal} tasks`,
      `- Verification: ${progress.verification.status}`,
      `- Next: ${action}`,
      '',
      '| Phase | File | Status | Generated | Approved |',
      '| --- | --- | --- | --- | --- |',
      ...PHASES.map((phase) => {
        const status = phaseStatus(record.spec, phase, record.exists[phase]);
        const approval = record.spec?.approvals[phase];
        return `| ${PHASE_META[phase].label} | \`${PHASE_META[phase].file}\` | ${status} | ${
          approval?.generated ? 'yes' : 'no'
        } | ${approval?.approved ? 'yes' : 'no'} |`;
      }),
    ];

    if (record.specError) {
      lines.push('', `> ${record.specError}`);
    }

    const document = await vscode.workspace.openTextDocument({
      content: `${lines.join('\n')}\n`,
      language: 'markdown',
    });
    await vscode.window.showTextDocument(document, { preview: true });
  };

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('ccSdd.specs', specProvider),
    vscode.window.registerTreeDataProvider('ccSdd.tasks', taskProvider),
    vscode.window.registerTreeDataProvider('ccSdd.sessions', sessionsProvider),
    statusBar,
    runsStatusBar,
    register('ccSdd.refresh', refresh),
    register('ccSdd.pickSpec', pickSpec),
    register('ccSdd.showStatus', showStatus),
    register('ccSdd.selectSpec', selectSpec),
    register('ccSdd.openSpecJson', async (arg) => {
      const record = recordFromArg(arg);
      if (record) {
        await openFile(record.specJsonPath);
      }
    }),
    register('ccSdd.openArtifact', async (arg) => {
      const target = phaseTarget(arg);
      if (target) {
        await openArtifact(target);
      }
    }),
    register('ccSdd.runPhase', async (arg) => {
      const target = phaseTarget(arg);
      if (target) {
        await runPhase(target.record, target.phase);
      }
    }),
    register('ccSdd.approvePhase', async (arg) => {
      const target = phaseTarget(arg);
      if (target) {
        await approvePhase(target);
      }
    }),
    register('ccSdd.revokePhase', async (arg) => {
      const target = phaseTarget(arg);
      if (target) {
        await revokePhase(target);
      }
    }),
    register('ccSdd.runImpl', async (arg) => {
      const records = await loadSpecs();
      const record =
        recordFromArg(arg) ??
        records.find((candidate) => candidate.id === activeSpecId) ??
        records[0];
      if (record) {
        await runImplementation(record);
      } else {
        void vscode.window.showInformationMessage('cc-sdd: no specs found.');
      }
    }),
    register('ccSdd.runValidateImpl', async (arg) => {
      const records = await loadSpecs();
      const record =
        recordFromArg(arg) ??
        records.find((candidate) => candidate.id === activeSpecId) ??
        records[0];
      if (record) {
        await runValidateImpl(record);
      } else {
        void vscode.window.showInformationMessage('cc-sdd: no specs found.');
      }
    }),
    register('ccSdd.openValidation', async (arg) => {
      const record = recordFromArg(arg);
      if (record) {
        await openValidation(record);
      }
    }),
    register('ccSdd.openSpecRun', async (arg) => {
      const record = recordFromArg(arg);
      if (record) {
        openSpecRun(record);
      }
    }),
    register('ccSdd.runTask', async (arg) => {
      const target = taskTarget(arg);
      if (target) {
        await runTask(target.record, target.task);
      }
    }),
    register('ccSdd.runFromTask', async (arg) => {
      const target = taskTarget(arg);
      if (target) {
        await runFromTask(target.record, target.task);
      }
    }),
    register('ccSdd.openSessionRun', async (arg) => {
      const session = sessionFromArg(arg);
      if (!session) {
        return;
      }
      const run = runsConsole
        .getRuns()
        .find((candidate) => candidate.sessionId === session.id);
      if (run) {
        runsConsole.openRun(run.id);
      } else {
        void vscode.window.showInformationMessage('cc-sdd: no related run is available.');
      }
    }),
    register('ccSdd.toggleSessionScope', async () => {
      sessionsProvider.toggleScope();
    }),
    register('ccSdd.openTask', async (arg) => {
      const target = taskTarget(arg);
      if (target) {
        await openFileAtLine(target.record.artifacts.tasks, target.task.line);
      }
    }),
    register('ccSdd.toggleTask', async (arg) => {
      const target = taskTarget(arg);
      if (target) {
        await toggleTaskCheckbox(target.record, target.task.line);
        await refresh();
      }
    }),
    register('ccSdd.newSpec', newSpec),
    register('ccSdd.runDiscovery', runDiscovery),
    register('ccSdd.runSteering', async () => {
      await runWithSkill(STEERING_SKILL);
    }),
    register('ccSdd.runValidateGap', async () => {
      await runValidateOnActive(() => VALIDATE_GAP_SKILL, 'gap analysis');
    }),
    register('ccSdd.runValidateDesign', async () => {
      await runValidateOnActive(() => VALIDATE_DESIGN_SKILL, 'design validation');
    }),
    register('ccSdd.openPath', async (arg?: unknown) => {
      if (typeof arg === 'string') {
        await openFile(arg);
      }
    }),
    register('ccSdd.install', install),
    register('ccSdd.overview', async () => {
      overviewPanel?.show();
    }),
    register('ccSdd.runs', async () => {
      runsConsole.show();
    }),
    register('ccSdd.saveRunTrace', async () => {
      runsConsole.saveLastTrace();
    }),
    register('ccSdd.resumeSession', async (arg) => {
      await resumeSession(arg);
    }),
    register('ccSdd.previewSession', async (arg) => {
      await previewSession(arg);
    }),
    register('ccSdd.refreshSessions', async () => {
      sessionsProvider.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('ccSdd')) {
        setupWatcher();
        void refresh().catch(showError);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      setupWatcher();
      void refresh().catch(showError);
    }),
    vscode.window.onDidChangeWindowState((state) => {
      // External processes (agents, terminals) can change spec files while the
      // window is unfocused; some platforms deliver those events unreliably.
      if (state.focused) {
        void refresh().catch(showError);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      const root = workspaceRoot();
      if (!root) {
        return;
      }
      const specsRoot = resolveKiroDir(root, kiroDir());
      if (document.uri.fsPath.startsWith(specsRoot + path.sep)) {
        void refresh().catch(showError);
      }
    }),
    {
      dispose: () => {
        if (refreshTimer) {
          clearTimeout(refreshTimer);
        }
        watcher?.dispose();
        sessionsWatcher?.dispose();
        runsConsole.dispose();
        overviewPanel?.dispose();
      },
    },
  );

  setupWatcher();
  await refresh().catch(showError);
}

export function deactivate(): void {
  // Disposables registered in activate() are cleaned up by VS Code.
}
