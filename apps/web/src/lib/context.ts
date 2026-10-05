// The warehouse measures each request's whole context, not its parts. The
// parts are worked out from what arrived between two requests: the growth is
// shared among what the transcript shows arrived, each at most its estimate
// from its text. Growth the transcript does not explain (reminders and
// attachments it leaves out, thinking kept within a turn) is unaccounted.

import { sumBy } from './lists'

export const CHARS_PER_TOKEN = 4

export const tokensOf = (chars: number): number => Math.round(chars / CHARS_PER_TOKEN)

export const CONTEXT_KINDS = [
  'start',
  'prompts',
  'replies',
  'builtIn',
  'plugins',
  'skills',
  'definitions',
  'carried',
  'unaccounted',
] as const

export type ContextKind = (typeof CONTEXT_KINDS)[number]

export type ContextEvent =
  | { type: 'request'; id: string; tokens: number }
  | { type: 'item'; kind: Exclude<ContextKind, 'start' | 'unaccounted'>; label: string; tokens: number }

interface IContextItem {
  kind: ContextKind
  label: string
  tokens: number
}

export interface IContextSnapshot {
  total: number
  byKind: Record<ContextKind, number>
  largest: IContextItem[]
}

const LARGEST = 6
const START_LABEL = 'System prompt, tools and instructions'

const emptyKinds = (): Record<ContextKind, number> =>
  Object.fromEntries(CONTEXT_KINDS.map((kind) => [kind, 0])) as Record<ContextKind, number>

// Events are in time order, so a request has read every item before it.
export const contextSnapshots = (
  events: readonly ContextEvent[],
  wanted: ReadonlySet<string>
): Map<string, IContextSnapshot> => {
  const snapshots = new Map<string, IContextSnapshot>()
  let items: IContextItem[] = []
  let pending: IContextItem[] = []
  let previous: number | null = null
  let start = 0

  for (const event of events) {
    if (event.type === 'item') {
      pending.push({ kind: event.kind, label: event.label, tokens: event.tokens })
      continue
    }

    const arrived = sumBy(pending, (item) => item.tokens)
    let base = previous ?? 0

    if (previous === null) {
      start = Math.max(event.tokens - arrived, 0)
      items = [{ kind: 'start', label: START_LABEL, tokens: start }]
      base = start
    } else if (event.tokens < previous) {
      const kept = Math.min(start, event.tokens)
      const carried = Math.max(event.tokens - kept - arrived, 0)
      items = [{ kind: 'start', label: START_LABEL, tokens: kept }]

      if (carried > 0) {
        items.push({ kind: 'carried', label: 'Carried over a compaction', tokens: carried })
      }

      base = kept + carried
    }

    const growth = event.tokens - base
    const share = arrived > growth && arrived > 0 ? growth / arrived : 1

    items.push(
      ...pending.map((item) => ({ ...item, tokens: Math.round(item.tokens * share) })).filter((item) => item.tokens > 0)
    )

    if (growth > arrived) {
      items.push({ kind: 'unaccounted', label: 'Unaccounted', tokens: growth - arrived })
    }

    pending = []
    previous = event.tokens

    if (wanted.has(event.id)) {
      const byKind = emptyKinds()

      for (const item of items) {
        byKind[item.kind] += item.tokens
      }

      snapshots.set(event.id, {
        total: event.tokens,
        byKind,
        largest: items
          .filter((item) => item.kind !== 'unaccounted' && item.kind !== 'start')
          .toSorted((left, right) => right.tokens - left.tokens)
          .slice(0, LARGEST),
      })
    }
  }

  return snapshots
}
