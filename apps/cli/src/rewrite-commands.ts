import { resolve } from 'node:path'
import {
  createEngine,
  type ForgetState,
  type ForgetTarget,
  type ICompactResult,
  type IEngine,
  type IForgetSessionsResult,
} from '@log-book/engine'
import { resolveWarehousePath } from '@log-book/warehouse'
import { exitCodeOf } from './errors.js'
import { formatCount, formatDuration, formatSize, tildePath } from './format.js'
import { ADAPTERS } from './grammar.js'
import { textOf } from './option-values.js'
import type { CommandRunner, ICliIo } from './run-cli.js'

// The engine's compaction and forget over the warehouse at that path.
export type RewriteOperations = (warehousePath: string) => Pick<IEngine, 'compact' | 'forget'>

const line = (text: string): string => `${text}\n`

const counted = (count: number, one: string, many: string): string =>
  `${formatCount(count)} ${count === 1 ? one : many}`

const sizes = ({ sizeBefore, sizeAfter }: { sizeBefore: number; sizeAfter: number }): string =>
  `${formatSize(sizeBefore)} before, ${formatSize(sizeAfter)} after`

// Before the rewrite: the file, its size and the free disk it may need, twice that size; no disk check runs before.
const compactingLine = (warehousePath: string, home: string, sizeBefore: number): string =>
  `Compacting ${tildePath(warehousePath, home)} (${formatSize(sizeBefore)}). This rewrites the whole file and needs ` +
  `up to ${formatSize(sizeBefore * 2)} of free disk; syncs and labelling wait until it ends.`

// How a rewrite ended: its result for stdout, or the lines that end stderr.
interface IEnding {
  code: number
  result: string | null
  lines: string[]
}

const errorOf = (result: { outcome: string; error: string | null }): string => {
  if (result.error === null) {
    throw new Error(`A rewrite that ended ${result.outcome} came back without its error`)
  }
  return result.error
}

const compactEnd = (result: ICompactResult): IEnding => {
  if (result.outcome === 'ok') {
    return {
      code: exitCodeOf('success'),
      result: `Compacted in ${formatDuration(result.durationMs)}: ${sizes(result)}.`,
      lines: [],
    }
  }
  if (result.outcome === 'failed') {
    return { code: exitCodeOf('failure'), result: null, lines: [errorOf(result)] }
  }
  const stopped = result.isRewritten
    ? `Compacting stopped after the rewrite had finished: ${sizes(result)}. The file shrinks to that size at a later ` +
      'sync.'
    : 'Compacting stopped. SQLite rolled the rewrite back, so the warehouse file is unchanged: ' +
      `${formatSize(result.sizeBefore)}, the same rows.`
  return { code: exitCodeOf('interrupted'), result: null, lines: [stopped] }
}

const forgotten = (result: IForgetSessionsResult): string => {
  const labels = result.labelCount === null ? 'their labels' : counted(result.labelCount, 'label', 'labels')
  return `Forgot ${counted(result.sessionCount, 'session', 'sessions')} and ${labels}`
}

// The line a forget that did not finish ends with, by how far it got; a failure's own message comes before it.
const UNFINISHED_FORGET: Readonly<Record<ForgetState, (result: IForgetSessionsResult) => string | null>> = {
  'nothing-forgotten': (result) =>
    result.outcome === 'stopped'
      ? 'Forgetting stopped before anything was deleted. Nothing was forgotten, and the warehouse file is unchanged.'
      : null,
  'forgotten': (result) =>
    `${forgotten(result)}, but compacting stopped, so their text may still be in the file's free space. Run ` +
    'logbook compact to remove it.',
  'rewritten': (result) =>
    `${forgotten(result)}; compacting stopped after the rewrite had finished: ${sizes(result)}. The file shrinks ` +
    'to that size at a later sync.',
}

const forgetEnd = (result: IForgetSessionsResult): IEnding => {
  if (result.outcome === 'ok') {
    return { code: exitCodeOf('success'), result: `${forgotten(result)}. Warehouse ${sizes(result)}.`, lines: [] }
  }
  const state = UNFINISHED_FORGET[result.state](result)
  const isStopped = result.outcome === 'stopped'
  return {
    code: exitCodeOf(isStopped ? 'interrupted' : 'failure'),
    result: null,
    lines: [...(isStopped ? [] : [errorOf(result)]), ...(state === null ? [] : [state])],
  }
}

// `Forgetting 12 sessions of ~/work/acme-shop and their 4 subagent sessions.`
const forgettingLine = (named: number, subagents: number, project: string | null): string => {
  const of = project === null ? '' : ` of ${project}`
  const their = named === 1 ? 'its' : 'their'
  const children = subagents === 0 ? '' : ` and ${their} ${counted(subagents, 'subagent session', 'subagent sessions')}`
  return `Forgetting ${counted(named, 'session', 'sessions')}${of}${children}.`
}

const engineRewrites: RewriteOperations = (warehousePath) => createEngine({ adapters: ADAPTERS, warehousePath })

// The end of a rewrite: its result on stdout, or its lines last on stderr.
const report = (io: ICliIo, ending: IEnding): number => {
  if (ending.result !== null) {
    io.stdout(line(ending.result))
  }
  for (const text of ending.lines) {
    io.stderr(line(text))
  }
  return ending.code
}

// `logbook compact` and `logbook forget`: both locks for the whole run, the rewrite in a process a stop kills, and
// the line for how far a stopped run got. A held lock and an unknown session are thrown and end through the error
// line. Neither asks for confirmation.
export const createRewriteRunners = (
  rewritesOf: RewriteOperations = engineRewrites
): Readonly<Record<string, CommandRunner>> => ({
  compact: async ({ io }) => {
    const warehousePath = resolveWarehousePath()
    const result = await rewritesOf(warehousePath).compact({
      signal: io.signal,
      onProgress: (progress) => {
        if (progress.phase === 'started') {
          io.stderr(line(compactingLine(warehousePath, io.home, progress.sizeBefore)))
        }
      },
    })
    return report(io, compactEnd(result))
  },
  forget: async ({ values, positionals, io }) => {
    const warehousePath = resolveWarehousePath()
    const project = textOf(values, 'project')
    const target: ForgetTarget = project === undefined ? { sessions: positionals } : { project: resolve(project) }
    const shown = 'project' in target ? tildePath(target.project, io.home) : null
    const result = await rewritesOf(warehousePath).forget({
      ...target,
      signal: io.signal,
      onProgress: (progress) => {
        if (progress.phase === 'resolved') {
          io.stderr(line(forgettingLine(progress.named, progress.subagents, shown)))
        }
        if (progress.phase === 'started') {
          io.stderr(line(compactingLine(warehousePath, io.home, progress.sizeBefore)))
        }
      },
    })
    return report(io, forgetEnd(result))
  },
})
