// Ported from lot-map (https://github.com/alexeyw/lot-map), MIT License.
// Copyright (c) 2026 Aleksei Volodin. See THIRD_PARTY_NOTICES.md.
// Which station an action belongs to and what to call it: a name, never content.
// Nothing here touches the engine.
import type { StationId } from './types'
import type { Setup } from './setup'
import type { Strings } from './text'

export type Classified = { station: StationId; label: string }

/** A path with Windows separators written as `/`, so that one rule reads paths from every system. */
const slashes = (path: string): string => path.replace(/\\/g, '/')

const lastTwo = (path: string): string => slashes(path).split('/').filter(Boolean).slice(-2).join('/')

const HOST = /^(?:[\p{L}\p{N}.-]+|\[[0-9a-f:.]+\])(?::\d+)?$/iu

/**
 * Only the host: a login, a password, a path or a query never reach a label.
 * A password may hold `/`, `?` or `#` unencoded, so the first of them is not always where the host ends:
 * `user:pa/ss@host` reads as the host `host`, and an address that can be read both ways gives its scheme alone.
 */
function hostOf(url: string): string {
  const [, scheme = '', rest = ''] = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(.*)$/is.exec(url) ?? []
  const end = rest.search(/[/?#]/)
  const first = end < 0 ? rest : rest.slice(0, end)
  const beyond = end < 0 ? '' : rest.slice(end)
  let host = first.split('@').pop() ?? ''
  if (!first.startsWith('[') && !first.includes('@') && first.includes(':') && beyond.includes('@')) {
    // `name:word` before an `@` further on: a port if the word is a number, or else a login and a password.
    host = /:\d+$/.test(first) ? '' : (rest.slice(rest.lastIndexOf('@') + 1).split(/[/?#]/)[0] ?? '')
  }
  return HOST.test(host) ? host.slice(0, 40) : scheme
}

/** A label as it may be shown: no control characters, which a terminal would act on, and no direction marks. */
export function clean(label: string, max = 120): string {
  const text = label.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/ {2,}/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Claude Code's own memory folder counts for everyone; anything else is the person's to name. */
const isMemoryPath = (path: string, setup: Setup): boolean => {
  const p = slashes(path)
  return /\/\.claude\/projects\/[^/]+\/memory\//.test(p) || setup.memoryPaths.some(part => p.includes(slashes(part)))
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Commands that work on files and nothing else: they read, search, move or edit them in place. echo, cd and the like say nothing either way. */
const FILE_WORDS = new Set(['cat', 'head', 'tail', 'sed', 'grep', 'rg', 'find', 'ls', 'wc', 'cp', 'mv', 'mkdir', 'touch', 'diff', 'cmp', 'sort', 'uniq', 'cut', 'tr', 'awk', 'tee', 'stat', 'file', 'du', 'tree', 'ln', 'basename', 'dirname', 'realpath', 'jq', 'rm', 'rmdir'])
const NEUTRAL_WORDS = new Set(['echo', 'printf', 'cd', 'export', 'true', 'false', ':', 'set', 'pwd', 'sleep', 'which', 'test', '[', '[[', 'read'])
const NET_WORDS = new Set(['curl', 'wget', 'gh', 'ssh', 'scp', 'sftp', 'ftp', 'rsync', 'nc', 'ncat', 'telnet', 'ping', 'dig', 'nslookup', 'nmap', 'http', 'https', 'kubectl', 'aws', 'gcloud', 'az'])
/** Commands that reach the network only with some of their subcommands. */
const NET_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  git: new Set(['push', 'pull', 'fetch', 'clone', 'ls-remote', 'submodule update', 'remote update']),
  svn: new Set(['checkout', 'co', 'update', 'up', 'commit', 'ci', 'export']),
  hg: new Set(['clone', 'pull', 'push', 'incoming', 'outgoing']),
  npm: new Set(['install', 'i', 'ci', 'add', 'update', 'publish', 'view', 'audit']),
  pnpm: new Set(['install', 'i', 'add', 'update', 'publish', 'dlx']),
  yarn: new Set(['install', 'add', 'upgrade', 'publish', 'dlx']),
  bun: new Set(['install', 'i', 'add', 'update', 'publish']),
  pip: new Set(['install', 'download']),
  pipx: new Set(['install', 'upgrade', 'upgrade-all', 'run']),
  uv: new Set(['add', 'sync', 'lock', 'publish', 'tool install']),
  poetry: new Set(['install', 'add', 'update', 'lock', 'publish']),
  docker: new Set(['pull', 'push', 'login']),
  'docker compose': new Set(['pull', 'push']),
  brew: new Set(['install', 'update', 'upgrade', 'fetch']),
  cargo: new Set(['install', 'fetch', 'publish', 'update']),
  go: new Set(['get', 'install', 'mod download']),
  apt: new Set(['install', 'update', 'upgrade', 'full-upgrade', 'dist-upgrade']),
  'apt-get': new Set(['install', 'update', 'upgrade', 'dist-upgrade']),
  deno: new Set(['install', 'add', 'cache']),
  terraform: new Set(['init', 'plan', 'apply', 'destroy', 'import', 'refresh']),
  helm: new Set(['install', 'upgrade', 'pull', 'push', 'repo', 'search', 'dependency']),
  openssl: new Set(['s_client']),
}
/** Programs that Python runs as a module: `python -m pip install` is `pip install`. */
const PY_MODULES = new Set(['pip', 'uv', 'pipx', 'poetry'])

/**
 * Commands that run another command: the one that counts is the one they run. Each lists its flags that take a word
 * after them; `skip` is how many words of its own follow the flags, and with a flag in `asks` it runs nothing.
 */
const WRAPPERS: Record<string, { takes?: readonly string[]; skip?: number; asks?: readonly string[] }> = {
  sudo: { takes: ['-u', '-g', '-p', '-h', '-C', '-D', '-R', '-T', '-U', '-r', '-t'] },
  doas: { takes: ['-u', '-C'] },
  env: { takes: ['-u', '-C'] },
  time: {},
  timeout: { takes: ['-s', '-k'], skip: 1 },
  nohup: {},
  nice: { takes: ['-n'] },
  ionice: { takes: ['-c', '-n'] },
  stdbuf: { takes: ['-i', '-o', '-e'] },
  caffeinate: { takes: ['-t', '-w'] },
  command: { asks: ['-v', '-V'] },
  exec: { takes: ['-a'] },
  xargs: { takes: ['-n', '-I', '-P', '-L', '-d', '-E', '-s', '-a', '-J', '-R'] },
  watch: { takes: ['-n', '--interval'] },
}
const ASSIGNMENT = /^[A-Za-z_]\w*=/
/** Flags of git and of docker that take a word after them and come before the subcommand. */
const GIT_TAKES = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])
const DOCKER_TAKES = new Set(['-c', '--context', '-H', '--host', '--config', '-l', '--log-level', '-f', '--file', '-p', '--project-name', '--profile', '--env-file', '--project-directory'])

/** The words after the flags: a flag in `takes` has a word of its own after it. */
const pastFlags = (words: string[], takes: { has(flag: string): boolean }): string[] => {
  let i = 0
  while (i < words.length && (words[i] ?? '').startsWith('-')) i += takes.has(words[i] ?? '') ? 2 : 1
  return words.slice(i)
}
const RUNNERS = new Set(['python', 'python3', 'bash', 'sh', 'zsh', 'node'])
/** Shells that run a line handed to them with `-c`: the commands of that line are the ones that count. */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
/** Words of a shell construct that stand before a command: `do curl x` is curl. */
const BEFORE_A_COMMAND = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{'])
/** Words that open or close a construct and run nothing themselves: `for u in a b`, `done`, `fi`. */
const NO_COMMAND = new Set(['for', 'select', 'case', 'function', 'done', 'fi', 'esac', '}'])
/** How much of a command line is read. A longer one is a script written inline, and what counts stands at its start. */
const READ = 8000

/** A word without the one pair of quotes around it. */
const unquoted = (word: string): string => {
  const q = word[0]
  if (q !== '"' && q !== "'") return word
  return word.length > 1 && word.endsWith(q) ? word.slice(1, -1) : word.slice(1)
}

/**
 * A shell line without the text of its here-documents: what stands between `<<WORD` and the line that is `WORD` is
 * written somewhere, not run. One that never ends is text to the end. `<<<` is a here-string and `((a << b))` is
 * arithmetic: neither opens one.
 */
function withoutHereDocuments(command: string): string {
  if (!command.includes('<<')) return command
  const kept: string[] = []
  const waiting: { word: string; tabs: boolean }[] = []
  for (const line of command.split('\n')) {
    const open = waiting[0]
    if (open !== undefined) {
      const text = (open.tabs ? line.replace(/^\t+/, '') : line).replace(/\r$/, '')
      if (text === open.word) waiting.shift()
      continue
    }
    kept.push(line)
    for (const m of line.matchAll(/(?<!<)<<(?!<)(-?)\s*(["']?)([A-Za-z_][\w.]*)\2/g)) {
      const before = line.slice(0, m.index)
      if (before.lastIndexOf('((') > before.lastIndexOf('))')) continue
      waiting.push({ word: m[3] ?? '', tabs: m[1] === '-' })
    }
  }
  return kept.join('\n')
}

// PowerShell's own names for the same three kinds of command, in lower case: PowerShell does not tell cases apart.
const PS_FILE_WORDS = new Set(['get-content', 'gc', 'type', 'set-content', 'add-content', 'out-file', 'get-childitem', 'gci', 'dir', 'get-item', 'gi', 'select-string', 'sls', 'copy-item', 'cpi', 'copy', 'move-item', 'mi', 'move', 'rename-item', 'rni', 'ren', 'new-item', 'ni', 'md', 'test-path', 'resolve-path', 'get-filehash'])
const PS_NEUTRAL_WORDS = new Set(['write-host', 'write-output', 'set-location', 'sl', 'get-location', 'gl', 'start-sleep', 'select-object', 'select', 'where-object', 'where', '?', 'foreach-object', 'foreach', '%', 'sort-object', 'measure-object', 'measure', 'format-table', 'ft', 'format-list', 'fl', 'out-string', 'out-null'])
const PS_NET_WORDS = new Set(['invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'test-connection', 'test-netconnection', 'resolve-dnsname', 'start-bitstransfer'])

/**
 * The words of each command in a shell line, leading assignments taken off. Quotes stay: a quoted word is an argument.
 * `deep` also cuts at `$(…)`, backticks and brackets, to find a command run inside another; the pieces around it are then no commands.
 */
function segments(command: string, deep = false, constructs = false): string[][] {
  return command
    .split(deep ? /&&|\|\||;|\||\n|\$\(|`|\(|\)/ : /&&|\|\||;|\||\n/)
    // Cut at spaces outside quotes, so that "C:\Program Files\Git\cmd\git.exe" stays one word.
    .map(part => part.match(/(?:[^\s"']|"[^"]*"?|'[^']*'?)+/g) ?? [])
    .map(words => {
      let i = 0
      while (i < words.length && ASSIGNMENT.test(words[i] ?? '')) i++
      if (!constructs) return words.slice(i)
      // `do curl x`, `if curl x`, `! curl x`, `(curl x`: the command is what follows. `for u in a b` and `done` run nothing.
      let rest = words.slice(i)
      for (;;) {
        const head = rest[0] ?? ''
        if (BEFORE_A_COMMAND.has(head)) rest = rest.slice(1)
        else if (head.startsWith('(') && !head.startsWith('((')) rest = head.length > 1 ? [head.slice(1), ...rest.slice(1)] : rest.slice(1)
        else break
      }
      return NO_COMMAND.has(rest[0] ?? '') ? [] : rest
    })
    .filter(words => words.length > 0)
}

/**
 * A command's own name: no quotes and no folder before it. A Windows program loses `.exe`, `.cmd` or `.bat` and its
 * capitals with it, since Windows does not tell `CURL.EXE` from `curl`; any other name keeps its case.
 */
const base = (word = ''): string => {
  const name = slashes(word.replace(/["']/g, '')).split('/').pop() ?? word
  return /\.(?:exe|cmd|bat)$/i.test(name) ? name.replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase() : name
}

/** A script's name without its ending: `recall-sync.py` is `recall-sync`. */
const stem = (name: string): string => name.replace(/\.[a-z0-9]+$/i, '')

/** A name is the command itself or begins with it and a separator: `recall` names `recall-sync.py`, never `recallable`. */
const named = (name: string, command: string): boolean => {
  const s = stem(name)
  return s === command || (s.startsWith(command) && /^[-_.]/.test(s.slice(command.length)))
}

/** The name a memory command goes by: its own, or the word after it when the person listed that word as a subcommand. */
function memoryLabel(words: string[], setup: Setup): string {
  const head = base(words[0])
  if (!setup.memoryCommands.includes(head)) return stem(base(RUNNERS.has(head) && words[1] ? words[1] : words[0]))
  const sub = words[1] ?? ''
  return setup.memorySubcommands.has(sub) ? sub : head
}

/** The line of a shell tool. `powershell` adds PowerShell's own command names and reads every name in lower case. */
function classifyShell(command: string, description: string, setup: Setup, powershell = false): Classified {
  const name = (word?: string): string => (powershell ? base(word).toLowerCase() : base(word))
  // PowerShell runs a quoted path with `&` and keeps results in `$name = ...`: neither is the command.
  const own = (words: string[]): string[] => {
    if (!powershell) return words
    let i = 0
    if (/^\$[\w:]+$/.test(words[0] ?? '') && words[1] === '=') i = 2
    if (words[i] === '&' || words[i] === '.') i++
    return words.slice(i)
  }
  // `sudo curl` is curl, and so is the curl behind `env A=1`, `timeout 5` or `xargs`: the command run is the one that counts.
  const unwrapped = (words: string[]): string[] => {
    let rest = words
    for (let depth = 0; depth < 6; depth++) {
      const wrapper = WRAPPERS[name(rest[0])]
      if (wrapper === undefined) break
      if (wrapper.asks?.some(flag => rest[1] === flag) === true) break
      rest = pastFlags(rest.slice(1), new Set(wrapper.takes ?? []))
      let i = 0
      while (i < rest.length && ASSIGNMENT.test(rest[i] ?? '')) i++
      rest = rest.slice(i + (wrapper.skip ?? 0))
    }
    return rest
  }
  /**
   * The commands of one piece of a line: its own, each one that `find` is told to run with `-exec`, and in place of
   * `bash -c "…"` or `eval "…"` the commands of the line handed over. A script's name is not a line: `bash deploy.sh`
   * is read no further. Shells inside shells are followed three deep.
   */
  const commands = (words: string[], depth = 0): string[][] => {
    const outer = unwrapped(words)
    const head = name(outer[0])
    if (!powershell && depth < 3) {
      let line: string | undefined
      if (head === 'eval') line = outer.slice(1).map(unquoted).join(' ')
      else if (SHELLS.has(head)) {
        const at = outer.findIndex((w, i) => i > 0 && !w.startsWith('-'))
        const flag = outer.findIndex((w, i) => i > 0 && /^-[a-z]*c$/.test(w))
        if (flag > 0 && (at < 0 || at > flag) && outer[flag + 1] !== undefined) line = unquoted(outer[flag + 1] ?? '')
      }
      if (line !== undefined) return segments(line, false, true).flatMap(inner => commands(inner, depth + 1))
    }
    const all = [outer]
    if (head === 'find') {
      outer.forEach((word, i) => {
        if (!/^-(?:exec|execdir|ok|okdir)$/.test(word)) return
        const tail = outer.slice(i + 1)
        const end = tail.findIndex(w => w === ';' || w === '\\;' || w === '\\' || w === '+')
        all.push(...commands(end < 0 ? tail : tail.slice(0, end), depth + 1))
      })
    }
    return all.filter(c => c.length > 0)
  }
  /** Whether a command reaches the network: by its name, or by its name and subcommand. */
  const isNet = (words: string[]): boolean => {
    let head = name(words[0])
    let rest = words.slice(1)
    if (NET_WORDS.has(head) || (powershell && PS_NET_WORDS.has(head))) return true
    if (/^(?:python[\d.]*|py)$/.test(head) && rest[0] === '-m' && PY_MODULES.has(rest[1] ?? '')) [head, rest] = [rest[1] ?? '', rest.slice(2)]
    if (head === 'uv' && rest[0] === 'pip') [head, rest] = ['pip', rest.slice(1)]
    // pip3 and pip3.12 are pip.
    if (/^pip[\d.]+$/.test(head)) head = 'pip'
    // yarn with no subcommand installs.
    if (head === 'yarn' && rest.every(w => w.startsWith('-'))) return true
    if (head === 'git') rest = pastFlags(rest, GIT_TAKES)
    if (head === 'docker') {
      rest = pastFlags(rest, DOCKER_TAKES)
      if (rest[0] === 'compose') [head, rest] = ['docker compose', pastFlags(rest.slice(1), DOCKER_TAKES)]
    }
    // npx runs what is installed already as readily as it downloads; only its own "yes, install" says which.
    if (head === 'npx') return rest.some(w => w === '-y' || w === '--yes')
    const subs = NET_SUBCOMMANDS[head]
    return subs !== undefined && (subs.has(rest[0] ?? '') || subs.has(`${rest[0] ?? ''} ${rest[1] ?? ''}`))
  }
  // What is read: the line without the text of its here-documents, and no more than its first part.
  const read = (powershell ? command : withoutHereDocuments(command)).slice(0, READ)
  const lines = segments(read, false, !powershell).map(own).filter(words => words.length > 0)
  const label = description.trim() || base(lines[0]?.[0] ?? 'shell')
  const run = lines.flatMap(words => commands(words))
  for (const words of run) {
    const head = name(words[0])
    const script = RUNNERS.has(head) && words[1] ? base(words[1]) : ''
    if (setup.memoryCommands.some(c => named(head, c) || named(script, c))) {
      return { station: 'memory', label: memoryLabel(words, setup) }
    }
  }
  if (run.some(isNet) || segments(read, true, !powershell).map(own).flatMap(words => commands(words)).some(isNet)) return { station: 'web', label }
  const isNeutral = (head: string): boolean => NEUTRAL_WORDS.has(head) || (powershell && PS_NEUTRAL_WORDS.has(head))
  const isFile = (head: string): boolean => FILE_WORDS.has(head) || (powershell && PS_FILE_WORDS.has(head))
  const real = run.filter(words => !isNeutral(name(words[0])))
  if (real.length > 0 && real.every(words => isFile(name(words[0])))) {
    return { station: isMemoryPath(read, setup) ? 'memory' : 'files', label }
  }
  return { station: 'shell', label }
}

export function classify(tool: string, input: Record<string, unknown>, setup: Setup): Classified {
  const { t } = setup
  switch (tool) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit': {
      const path = str(input.file_path) || str(input.notebook_path)
      return { station: isMemoryPath(path, setup) ? 'memory' : 'files', label: lastTwo(path) || tool }
    }
    case 'Grep':
    case 'Glob':
    // Code intelligence from a language server.
    case 'LSP':
      return { station: 'files', label: tool }
    case 'Bash':
      return classifyShell(str(input.command), str(input.description), setup)
    case 'PowerShell':
      return classifyShell(str(input.command), str(input.description), setup, true)
    case 'WebFetch':
      return { station: 'web', label: hostOf(str(input.url)) }
    case 'WebSearch':
      return { station: 'web', label: t.webSearch }
    case 'Artifact':
      return { station: 'web', label: t.artifact }
    // Work kept on claude.ai: an artifact's comments and data, a Claude Project, a design, a shared guide, a published plugin.
    case 'ArtifactComments':
    case 'ArtifactData':
    case 'SendToProject':
    case 'SendToProjectContext':
    case 'Projects':
    case 'ClaudeDesign':
    case 'DesignSync':
    case 'ShareOnboardingGuide':
    case 'PublishPlugin':
      return { station: 'web', label: tool }
    // An MCP server's resources: Memory when the server is one of the person's memory servers, else as any MCP call.
    // The server's name decides the station; the label is the tool's name, never the resource's address.
    case 'ListMcpResourcesTool':
    case 'ReadMcpResourceTool':
    case 'ReadMcpResourceDirTool':
      return { station: setup.memoryServers.has(str(input.server)) ? 'memory' : 'web', label: tool }
    case 'Agent':
      return { station: 'agents', label: str(input.description) || t.subagent }
    case 'Monitor':
      return { station: 'shell', label: str(input.description) || tool }
    case 'Workflow':
      return { station: 'agents', label: t.workflow }
    case 'SendMessage':
    case 'TaskStop':
    case 'ListAgents':
    // Work that runs later, apart from the turn: schedules and routines.
    case 'CronCreate':
    case 'CronDelete':
    case 'CronList':
    case 'ScheduleWakeup':
    case 'RemoteTrigger':
    // A subagent handing its work back, files sent to another session, waiting on background work and what it reported.
    case 'SubagentHandback':
    case 'SendFile':
    case 'Poll':
    case 'Yield':
    case 'ReadNotifications':
      return { station: 'agents', label: tool }
    case 'Skill':
      return { station: 'skills', label: str(input.skill) || t.skill }
    case 'ToolSearch':
      return { station: 'skills', label: t.loadingTools }
    // The skill and plugin catalogue.
    case 'ListSkills':
    case 'SearchSkills':
    case 'SuggestSkills':
    case 'ListPlugins':
    case 'SearchPlugins':
    case 'SuggestPluginInstall':
    // The connector catalogue, and waiting for MCP tools to load, as a tool search loads them.
    case 'ListConnectors':
    case 'SearchMcpRegistry':
    case 'SuggestConnectors':
    case 'WaitForMcpServers':
      return { station: 'skills', label: tool }
    case 'AskUserQuestion':
      return { station: 'you', label: t.questionForYou }
    case 'SendUserFile':
      return { station: 'you', label: t.fileForYou }
    // What is shown to or asked of the person: the task list, the plan, a notification, review findings.
    // The name alone: a task's subject and description are content.
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
    case 'TaskGet':
    case 'TodoWrite':
    case 'EnterPlanMode':
    case 'ExitPlanMode':
    case 'PushNotification':
    case 'ReportFindings':
    // A message to the person or one from them, a goal or skills for them to approve, a next step offered, a card
    // they are shown, the end of the conversation.
    case 'SendUserMessage':
    case 'FetchInboxMessage':
    case 'SendFeedback':
    case 'ProposeGoal':
    case 'propose_skills':
    case 'WrapUp':
    case 'ShowOnboardingRolePicker':
    case 'OfferChromeSetup':
    case 'ReadWidgetContext':
    case 'EndConversation':
      return { station: 'you', label: tool }
  }
  const mcp = /^mcp__([^_].*?)__(.+)$/.exec(tool)
  if (mcp === null) return { station: 'shell', label: tool }
  const [, server = '', name = ''] = mcp
  if (setup.memoryServers.has(server)) {
    // A number, or a short identifier: a longer string under `id` could be anything.
    const id = typeof input.id === 'number' || (typeof input.id === 'string' && /^[\w-]{1,24}$/.test(input.id)) ? ` #${input.id}` : ''
    return { station: 'memory', label: (setup.memoryLabels.get(name) ?? name.replace(/_+/g, ' ')) + id }
  }
  // A cloud session linked to the person's computer reaches the same browser under `remote-devices`.
  const remote = server === 'remote-devices' ? /^Claude_Browser__(.+)$/.exec(name) : null
  if (server === 'Claude_Browser' || server === 'claude-in-chrome' || remote !== null) {
    const url = str(input.url)
    const action = remote?.[1] ?? name
    return { station: 'browser', label: url && /^[a-z]+:/i.test(url) ? hostOf(url) : action.replace(/_+/g, ' ') }
  }
  if (server === 'terminal') return { station: 'shell', label: name.replace(/_+/g, ' ') }
  if (server === 'visualize' || server.startsWith('ccd_')) return { station: 'you', label: name.replace(/_+/g, ' ') }
  if (server === 'plugin-authoring') return { station: 'skills', label: name.replace(/_+/g, ' ') }
  return { station: 'web', label: `${server}: ${name.replace(/_+/g, ' ')}` }
}

/** `claude-opus-5-5` reads as `opus 5.5`. */
export function shortModel(model: string): string {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model)
  return m === null ? model : `${m[1]} ${m[2]}${m[3] !== undefined ? `.${m[3]}` : ''}`
}

export function formatMs(ms: number, t: Strings): string {
  return ms < 1000 ? t.ms(Math.max(1, Math.round(ms))) : ms < 60000 ? t.seconds((ms / 1000).toFixed(1)) : t.minutes(Math.floor(ms / 60000), Math.round((ms % 60000) / 1000))
}

/** The first line of a hook's refusal, cut short: the lines after it may repeat the whole command. */
export function firstLine(text: string, max = 72): string {
  const line = (text.split('\n').find(l => l.trim() !== '') ?? '').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** The record numbers a memory hook put in front of the model: `[#123`, `[now #123`, `[todo #123`. */
export function memoryIds(text: string): string[] {
  return [...new Set([...text.matchAll(/\[(?:[a-z]+ )?#(\d+)/g)].map(m => m[1] ?? ''))]
}
