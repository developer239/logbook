import { DEFAULT_LABEL_MODEL, type SessionOutcome } from '@log-book/engine'
import type { ProjectName } from '../corpus/projects.js'
import type { ShapeName } from '../corpus/shapes.js'
import { createStream, type IRandomStream } from '../random.js'
import { dayStart, HOUR_MS } from './calendar.js'
import { minutes, SessionPlanner, spanOf, turnsFrom } from './session-planner.js'
import { planShowcase } from './showcase.js'
import type { ISessionSpec } from './small.js'
import type { IPlan, IPlannedTurn } from './types.js'

export const RICH_DAYS = 84
// The last day an older session may fall on: day 79 of 84 ends three whole days before the anchor's day starts.
const RICH_LAST_OLDER_DAY = 79
// The top-level sessions that end in the 48 hours before the anchor and stay unlabelled.
export const RICH_RECENT = 17
const RICH_MAX_TURNS = 12
// Of the older days, how many may hold sessions; the rest stay empty.
const RICH_ACTIVE_DAYS = 66
const MOST_PER_DAY = 6
// The share of sessions with an idle stretch, and of untitled ones, in percent.
const IDLE_PERCENT = 30
const UNTITLED_PERCENT = 10
// The latest a recent session other than the newest may end before the anchor, and the earliest.
const RECENT_HOURS: readonly [number, number] = [2, 43]

// A work item and the shape a session on it takes.
interface IPairing {
  work: string
  shape: ShapeName
}

// The sessions of one writer in one project: how many, how many start a session (and of those how many start one
// that starts another), and how many run a scripted session through a shell call.
interface IGroup {
  writer: number
  project: ProjectName
  count: number
  hosts: number
  nested: number
  scriptedHosts: number
}

// With the showcase conversation, 150 top-level sessions in the first writer (130 interactive and 20 scripted, 6 of
// those run from another session's shell call) and 90 in the second; 67 of the first writer's start a subagent, 3 of
// which start another, and 30 of the second's start a child session. `shop` mostly in the first writer, `billing`
// mostly in the second.
const GROUPS: readonly IGroup[] = [
  { writer: 0, project: 'shop', count: 85, hosts: 54, nested: 3, scriptedHosts: 6 },
  { writer: 0, project: 'billing', count: 16, hosts: 12, nested: 0, scriptedHosts: 0 },
  { writer: 0, project: 'field-guide', count: 28, hosts: 0, nested: 0, scriptedHosts: 0 },
  { writer: 1, project: 'billing', count: 60, hosts: 26, nested: 0, scriptedHosts: 0 },
  { writer: 1, project: 'field-guide', count: 20, hosts: 0, nested: 0, scriptedHosts: 0 },
  { writer: 1, project: 'shop', count: 10, hosts: 4, nested: 0, scriptedHosts: 0 },
]
const STANDALONE_SCRIPTED = 14

// The shapes a session that starts another takes, by project; a host that starts one which starts another takes the
// first.
const HOST_PAIRINGS: Readonly<Record<ProjectName, readonly IPairing[]>> = {
  'shop': [
    { work: 'add a discount code field to checkout', shape: 'feature through a subagent' },
    { work: 'review the checkout form changes', shape: 'review through a subagent' },
  ],
  'billing': [
    { work: 'fix rounding in invoice totals', shape: 'fix through a subagent' },
    { work: 'fix the late fee applied twice', shape: 'fix through a subagent' },
  ],
  'field-guide': [],
}
// Its trace holds the search phrase, which only one tool output of a set may hold: one billing host of the second
// writer takes it.
const PHRASE_PAIRING: IPairing = { work: 'find why the tax total drifts by a cent', shape: 'debug through a subagent' }
const SCRIPTED_HOST: IPairing = { work: 'keep the saved cart after sign-in', shape: 'feature that runs a question' }

// Every other session's shapes, by project: each pairing comes round in turn, so every shape is used.
const PAIRINGS: Readonly<Record<ProjectName, readonly IPairing[]>> = {
  'shop': [
    { work: 'add a discount code field to checkout', shape: 'feature with tests' },
    { work: 'keep the saved cart after sign-in', shape: 'feature that runs a question' },
    { work: 'split the cart total into smaller functions', shape: 'refactor in steps' },
    { work: 'plan the gift card flow', shape: 'plan a flow' },
    { work: 'ask what the cart badge counts', shape: 'quick question' },
  ],
  'billing': [
    { work: 'fix rounding in invoice totals', shape: 'bug fix with tests' },
    { work: 'find why the tax total drifts by a cent', shape: 'debug with a helper' },
    { work: 'fix the late fee applied twice', shape: 'tracked bug fix' },
    { work: 'check that refunds keep the original currency', shape: 'verify with tests' },
    { work: 'release billing 2.3.0', shape: 'release with a command' },
  ],
  'field-guide': [
    { work: 'write the trail safety chapter', shape: 'write a chapter' },
    { work: 'rewrite the fern chapter for beginners', shape: 'write a chapter' },
    { work: 'find out which ferns grow above the tree line', shape: 'research a question' },
    { work: 'find where the link check lists the chapters', shape: 'explore the code' },
    { work: 'ask what the glossary counts as scree', shape: 'quick question' },
  ],
}
type TScriptedProject = 'shop' | 'field-guide'
const SCRIPTED_PROJECTS: readonly TScriptedProject[] = ['shop', 'field-guide']
// What a scripted session asks, by its project; a scripted session another runs asks about `shop`.
const SCRIPTED_PAIRINGS: Readonly<Record<TScriptedProject, IPairing>> = {
  'shop': { work: 'ask what the cart badge counts', shape: 'quick question' },
  'field-guide': { work: 'ask what the glossary counts as scree', shape: 'quick question' },
}

// A session to place, with whether it ends in the 48 hours before the anchor.
interface IPlaced {
  spec: ISessionSpec
  isRecent: boolean
}

const cycled = <TItem>(items: readonly TItem[], index: number): TItem => {
  const item = items[index % items.length]
  if (item === undefined) {
    throw new Error('Nothing to cycle through')
  }
  return item
}

// A session's pairing by its role: the phrase's host, another host, a host of a scripted session, or any other.
const pairingOf = (
  role: { isPhrase: boolean; isHost: boolean; isScriptedHost: boolean },
  hosts: readonly IPairing[],
  others: readonly IPairing[],
  // The session's place among the hosts, or among the others.
  place: number
): IPairing => {
  if (role.isPhrase) {
    return PHRASE_PAIRING
  }
  if (role.isHost) {
    return cycled(hosts, place)
  }
  return role.isScriptedHost ? SCRIPTED_HOST : cycled(others, place)
}

interface IRole {
  isPhrase: boolean
  isHost: boolean
  isScriptedHost: boolean
  // A host whose started session starts another.
  isNested: boolean
}

// A session's role by its place in its group: the hosts first, the nested ones among them first, then the hosts of a
// scripted session, then the others; the first billing host of the second writer holds the phrase.
const roleOf = (group: IGroup, index: number, isPhraseGiven: boolean): IRole => {
  const isHost = index < group.hosts
  return {
    isPhrase: isHost && !isPhraseGiven && group.writer === 1 && group.project === 'billing',
    isHost,
    isScriptedHost: !isHost && index < group.hosts + group.scriptedHosts,
    isNested: isHost && index < group.nested,
  }
}

// The sessions a session's role has it start: a started one, or a scripted one through a shell call.
const startsOf = (role: IRole): Pick<ISessionSpec, 'spawn' | 'runsScripted'> => ({
  ...(role.isHost ? { spawn: { isNested: role.isNested } } : {}),
  ...(role.isScriptedHost ? { runsScripted: true } : {}),
})

export class RichPlanner extends SessionPlanner {
  // Each work item's outcomes come round in turn, so every outcome of an item is used.
  private readonly outcomeTurns = new Map<string, number>()

  public readonly plan = (): IPlan => {
    const { seed, anchor, labels, model } = this.inputs
    // Planned before everything else, so its writer writes it first.
    this.sessions.push(...planShowcase(this.inputs))
    const placed = this.recentOnes(createStream(seed, 'rich/order').shuffle(this.specs()))
    const older = placed.filter((entry) => !entry.isRecent)
    let previousEnd = 0
    for (const [index, slot] of this.olderSlots(older.length).entries()) {
      const spec = older[index]?.spec
      if (spec === undefined) {
        break
      }
      const key = `${spec.project}/d${String(slot.day)}/s${String(slot.index)}`
      const stream = createStream(seed, key)
      const start =
        slot.index === 1
          ? dayStart(anchor, slot.day, RICH_DAYS) + stream.integer(8, 11) * HOUR_MS + minutes(stream, 0, 59)
          : previousEnd + minutes(stream, 20, 90)
      const turns = this.turnsOf(stream, start, spec)
      previousEnd = spanOf(turns).end
      this.addSession(key, spec, turns, stream)
    }
    placed
      .filter((entry) => entry.isRecent)
      .forEach((entry, index) => {
        this.addRecent(entry.spec, index)
      })
    return {
      size: 'rich',
      seed,
      anchor,
      labels,
      labelModel: labels === 'all' ? (model ?? DEFAULT_LABEL_MODEL) : null,
      days: RICH_DAYS,
      sessions: this.sessions,
    }
  }

  protected readonly scriptedFor = (spec: ISessionSpec): ISessionSpec | undefined => {
    const pairing = SCRIPTED_PAIRINGS.shop
    return spec.runsScripted === true
      ? { ...this.specOf(spec.writer, 'shop', pairing, this.outcomeOf(pairing.work, false)), isScripted: true }
      : undefined
  }

  private readonly turnsOf = (stream: IRandomStream, start: number, spec: ISessionSpec): IPlannedTurn[] => {
    if (spec.isScripted === true) {
      return [{ start, end: start + minutes(stream, 1, 3) }]
    }
    return turnsFrom(stream, start, spec, RICH_MAX_TURNS)
  }

  private readonly outcomeOf = (work: string, isRecent: boolean): SessionOutcome | null => {
    const item = Object.values(this.inputs.corpus.work)
      .flat()
      .find((candidate) => candidate.title === work)
    if (item === undefined) {
      throw new Error(`No work item ${work}`)
    }
    if (isRecent) {
      return null
    }
    const turn = this.outcomeTurns.get(work) ?? 0
    this.outcomeTurns.set(work, turn + 1)
    return cycled(item.outcomes, turn)
  }

  private readonly specOf = (
    writer: number,
    project: ProjectName,
    pairing: IPairing,
    outcome: SessionOutcome | null
  ): ISessionSpec => ({ writer, project, work: pairing.work, shape: pairing.shape, outcome })

  // Every top-level session but those a shell call runs, in group order; the outcome is drawn when it is placed.
  private readonly specs = (): ISessionSpec[] => {
    const stream = createStream(this.inputs.seed, 'rich/specs')
    const groups = GROUPS.filter((group) => group.writer < this.inputs.writers.length)
    let isPhraseGiven = false
    const grouped = groups.flatMap((group) => {
      const others = stream.shuffle(PAIRINGS[group.project])
      const hosts = HOST_PAIRINGS[group.project]
      return Array.from({ length: group.count }, (_entry, index): ISessionSpec => {
        const role = roleOf(group, index, isPhraseGiven)
        isPhraseGiven ||= role.isPhrase
        const pairing = pairingOf(role, hosts, others, role.isHost ? index : index - group.hosts - group.scriptedHosts)
        // A host that starts one which starts another takes the first host pairing, whose subagent starts one.
        return {
          ...this.specOf(group.writer, group.project, role.isNested ? (hosts[0] ?? pairing) : pairing, null),
          ...startsOf(role),
          ...(stream.integer(1, 100) <= IDLE_PERCENT ? { hasIdleGap: true } : {}),
          ...(stream.integer(1, 100) <= UNTITLED_PERCENT ? { isUntitled: true } : {}),
        }
      })
    })
    const scripted = Array.from({ length: STANDALONE_SCRIPTED }, (_entry, index): ISessionSpec => {
      const project = cycled(SCRIPTED_PROJECTS, index)
      return { ...this.specOf(0, project, SCRIPTED_PAIRINGS[project], null), isScripted: true }
    })
    return [...grouped, ...(this.inputs.writers.length > 0 ? scripted : [])]
  }

  // The recent ones are interactive sessions that start none and run none, so what they start stays within the
  // 48 hours too; every other session is older.
  private readonly recentOnes = (specs: readonly ISessionSpec[]): IPlaced[] => {
    let left = RICH_RECENT
    return specs.map((spec) => {
      const isRecent = left > 0 && spec.spawn === undefined && spec.runsScripted !== true && spec.isScripted !== true
      left -= isRecent ? 1 : 0
      return { spec: { ...spec, outcome: this.outcomeOf(spec.work, isRecent) }, isRecent }
    })
  }

  // The older days that hold sessions and how many each holds, from the seed: activity varies by day and some days
  // are empty. Chronological.
  private readonly olderSlots = (count: number): { day: number; index: number }[] => {
    const stream = createStream(this.inputs.seed, 'rich/calendar')
    const active = stream
      .shuffle(Array.from({ length: RICH_LAST_OLDER_DAY + 1 }, (_day, day) => day))
      .slice(0, RICH_ACTIVE_DAYS)
    const days = active.flatMap((day) => Array.from({ length: stream.integer(1, MOST_PER_DAY) }, () => day))
    while (days.length < count) {
      days.push(stream.pick(active))
    }
    const kept = stream
      .shuffle(days)
      .slice(0, count)
      .toSorted((left, right) => left - right)
    return kept.map((day, index) => ({ day, index: kept.slice(0, index).filter((other) => other === day).length + 1 }))
  }

  // A session that ends in the 48 hours before the anchor, timed back from its end so it never runs between 48 and 47
  // hours before it; the first ends within the hour before it.
  private readonly addRecent = (spec: ISessionSpec, index: number): void => {
    const key = `${spec.project}/d${String(RICH_DAYS - 1)}/r${String(index + 1)}`
    const stream = createStream(this.inputs.seed, key)
    const drafted = this.turnsOf(stream, 0, spec)
    const [latest, earliest] = RECENT_HOURS
    const end =
      this.inputs.anchor -
      (index === 0 ? minutes(stream, 10, 40) : stream.integer(latest, earliest) * HOUR_MS + minutes(stream, 0, 59))
    const shift = end - spanOf(drafted).end
    this.addSession(
      key,
      spec,
      drafted.map((turn) => ({ start: turn.start + shift, end: turn.end + shift })),
      stream
    )
  }
}
