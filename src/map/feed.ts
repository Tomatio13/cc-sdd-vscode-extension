// Ported from lot-map (https://github.com/alexeyw/lot-map), MIT License.
// Copyright (c) 2026 Aleksei Volodin. See THIRD_PARTY_NOTICES.md.
// The rows under the map: what is folded into one, what a background task says of itself, and the line of what runs now.
// Nothing here touches the engine.
import type { Board, Entry, Status } from './types'
import { shortModel } from './classify'
import type { Strings } from './text'

/** A row of the feed: one entry, or several finished ones in a row at one station, shown as the newest of them. */
export type Row = { entry: Entry; times: number; tookMs: number }

const isPlain = (e: Entry): boolean => e.status === 'ok' && e.mark === undefined

/**
 * The newest rows first. Finished calls that follow one another at one station fold into a single row.
 * With `apart`, the calls of two subagents never share a row: each row may name its subagent, and a folded one names only the newest.
 *
 * A call still running is never pushed out by what came after it: past the last row it stays, as the last rows of the
 * list, in place of the oldest finished ones. The map shows it at work for as long as it runs, and the list says the same.
 *
 * Such rows take half the list at most, so the newest calls always have the other half. With more of them still
 * running than that, the last row stands for the rest as a folded row does: `+22`.
 */
export function foldRows(entries: readonly Entry[], max = 16, apart = false): Row[] {
  const rows: Row[] = []
  const running: Row[] = []
  // Set once a row was left out: from there on nothing is a neighbour of the last row.
  let isCut = false
  const held = Math.max(1, Math.floor(max / 2))
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e === undefined) continue
    const took = e.endedAt === undefined ? 0 : Math.max(0, e.endedAt - e.startedAt)
    const last = rows[rows.length - 1]
    if (!isCut && last !== undefined && isPlain(e) && isPlain(last.entry) && last.entry.station === e.station && last.entry.from === e.from && (!apart || last.entry.agentId === e.agentId)) {
      last.times++
      last.tookMs += took
      continue
    }
    if (rows.length >= max) {
      // Past the list's end only what still runs counts.
      isCut = true
      if (e.status !== 'run') continue
      const oldest = running[running.length - 1]
      if (running.length < held || oldest === undefined) running.push({ entry: e, times: 1, tookMs: took })
      else oldest.times++
      continue
    }
    rows.push({ entry: e, times: 1, tookMs: took })
  }
  return running.length === 0 ? rows : [...rows.slice(0, max - running.length), ...running]
}

/**
 * The id of the background task a tool's answer started, if it started one: a shell command sent to the
 * background, a subagent or workflow launched to run on, a monitor.
 */
export function taskOf(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const r = result as Record<string, unknown>
  const id = (v: unknown): string | undefined => (typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : undefined)
  if (r.status === 'async_launched' || r.status === 'remote_launched') return id(r.agentId) ?? id(r.taskId)
  return id(r.backgroundTaskId) ?? (typeof r.timeoutMs === 'number' ? id(r.taskId) : undefined)
}

/**
 * A background task's notification, read for the task's id and how it ended and for nothing else:
 * its summary and output never reach the map. No status: the task spoke and goes on (a monitor's event).
 */
export function taskNotice(text: string): { id: string; status?: Status } | undefined {
  if (!text.trimStart().startsWith('<task-notification>')) return undefined
  const id = /<task-id>([\w-]{1,64})<\/task-id>/.exec(text)?.[1]
  if (id === undefined) return undefined
  const word = /<status>(\w+)<\/status>/.exec(text)?.[1]
  if (word === undefined) return { id }
  return { id, status: word === 'failed' ? 'err' : 'ok' }
}

/**
 * The same in two parts, for a line that keeps its figures at the right: what runs now, and how full the context is with
 * the model's name. The model is left out while the line itself names a model step, so it is not said twice.
 */
export function nowParts(board: Board, t: Strings): { what: string; meter: string } {
  const running = board.entries.filter(e => e.status === 'run')
  const top = running[running.length - 1]
  const what = top === undefined ? t.idle : `${t.stations[top.station]}: ${top.label}${running.length > 1 ? t.andMore(running.length - 1) : ''}`
  const figures = [board.context === undefined ? '' : `${Math.round(board.context)}%`, board.model === undefined || top?.station === 'model' ? '' : shortModel(board.model)]
  return { what, meter: figures.filter(Boolean).join(' · ') }
}

export function describeNow(board: Board, t: Strings): string {
  const running = board.entries.filter(e => e.status === 'run')
  const context = board.context === undefined ? '' : ` · ${t.context} ${Math.round(board.context)}%`
  const top = running[running.length - 1]
  const model = board.model !== undefined ? ` · ${shortModel(board.model)}` : ''
  if (top === undefined) return `${t.idle}${context}${model}`
  return `${t.stations[top.station]}: ${top.label}${running.length > 1 ? t.andMore(running.length - 1) : ''}${context}`
}
