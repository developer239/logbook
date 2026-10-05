import { LogBookError } from '@log-book/core'
import { DEFAULT_LABEL_MODEL, isLabelModelId } from '@log-book/engine'
import { DEMO_ERROR_CODES } from '../errors.js'
import { createStream, type IRandomStream } from '../random.js'
import { dayStart, HOUR_MS, MINUTE_MS } from './calendar.js'
import {
  SMALL_ACTIVE_DAYS,
  SMALL_DAYS,
  SMALL_DOUBLE_DAYS,
  SMALL_LAST_OLDER_DAY,
  SMALL_RECENT_DAYS,
  SMALL_SESSIONS,
  type ISessionSpec,
} from './small.js'
import type { IPlan, IPlanInputs, IPlannedSession, IPlannedTurn, IWriterDeclaration } from './types.js'

const SECOND_MS = 1000
// The turn of a session that starts another session, long enough to hold it.
const SPAWNING_TURN = 1
const TOP_LEVEL_AGENT = 'build'

interface ISlot {
  day: number
  // 1 for the day's first session, 2 for its second.
  index: number
}

const minutes = (stream: IRandomStream, min: number, max: number): number =>
  stream.integer(min, max) * MINUTE_MS + stream.integer(0, 59) * SECOND_MS

const has = (writer: IWriterDeclaration | undefined, capability: string): boolean =>
  writer?.capabilities.includes(capability) === true

// The older days that hold sessions, and which of them hold two, from the seed: activity varies by day and some days
// are empty. Chronological.
const olderSlots = (seed: number): ISlot[] => {
  const stream = createStream(seed, 'small/calendar')
  const active = stream
    .shuffle(Array.from({ length: SMALL_LAST_OLDER_DAY + 1 }, (_day, day) => day))
    .slice(0, SMALL_ACTIVE_DAYS)
  const doubles = new Set(stream.shuffle(active).slice(0, SMALL_DOUBLE_DAYS))
  return active
    .toSorted((left, right) => left - right)
    .flatMap((day) =>
      doubles.has(day)
        ? [
            { day, index: 1 },
            { day, index: 2 },
          ]
        : [{ day, index: 1 }]
    )
}

// A session's turns from `start`: each takes minutes, the spawning turn long enough to hold the session it starts, and
// a short gap between turns except the idle stretch.
const turnsFrom = (stream: IRandomStream, start: number, spec: ISessionSpec): IPlannedTurn[] => {
  const count = stream.integer(spec.spawn === undefined ? 2 : SPAWNING_TURN + 2, 5)
  const turns: IPlannedTurn[] = []
  let at = start
  for (let index = 0; index < count; index += 1) {
    const isSpawning = spec.spawn !== undefined && index === SPAWNING_TURN
    const end = at + (isSpawning ? minutes(stream, 9, 12) : minutes(stream, 2, 7))
    turns.push({ start: at, end })
    at = end + (spec.hasIdleGap === true && index === 0 ? minutes(stream, 12, 18) : minutes(stream, 1, 4))
  }
  return turns
}

// The one turn of a started session inside its parent's turn, long enough to hold the one it starts in turn when it
// holds one.
const childTurns = (stream: IRandomStream, start: number, holdsNested: boolean): IPlannedTurn[] => [
  { start, end: start + (holdsNested ? minutes(stream, 6, 6) : minutes(stream, 1, 2)) },
]

const spanOf = (turns: readonly IPlannedTurn[]): { start: number; end: number } => ({
  start: turns[0]?.start ?? 0,
  end: turns.at(-1)?.end ?? 0,
})

class SmallPlanner {
  private readonly inputs: IPlanInputs
  private readonly sessions: IPlannedSession[] = []
  // The scripted session a host session's shell call runs, where its writer declares `scripted`.
  private scripted: ISessionSpec | undefined

  constructor(inputs: IPlanInputs) {
    this.inputs = inputs
  }

  public readonly plan = (): IPlan => {
    const { seed, anchor, labels, model } = this.inputs
    const present = SMALL_SESSIONS.filter((spec) => spec.writer < this.inputs.writers.length)
    this.scripted = present.find(
      (spec) =>
        spec.isScripted === true &&
        has(this.inputs.writers[spec.writer], 'scripted') &&
        present.some((host) => host.runsScripted === true && host.writer === spec.writer)
    )
    const older = createStream(seed, 'small/order').shuffle(
      present.filter((spec) => spec.recentEnd === undefined && spec !== this.scripted)
    )
    const slots = olderSlots(seed)
    let previousEnd = 0
    for (const [index, spec] of older.entries()) {
      const slot = slots[index] ?? { day: SMALL_LAST_OLDER_DAY, index: index + 1 }
      const key = `${spec.project}/d${String(slot.day)}/s${String(slot.index)}`
      const stream = createStream(seed, key)
      const start =
        slot.index === 1
          ? dayStart(anchor, slot.day, SMALL_DAYS) + stream.integer(9, 12) * HOUR_MS + minutes(stream, 0, 59)
          : previousEnd + minutes(stream, 45, 120)
      const turns = turnsFrom(stream, start, spec)
      previousEnd = spanOf(turns).end
      this.addSession(key, spec, turns, stream)
    }
    for (const spec of present
      .filter((candidate) => candidate.recentEnd !== undefined)
      .toSorted(
        (left, right) =>
          SMALL_RECENT_DAYS[left.recentEnd ?? 'last-day'] - SMALL_RECENT_DAYS[right.recentEnd ?? 'last-day']
      )) {
      this.addRecent(spec)
    }
    return {
      size: 'small',
      seed,
      anchor,
      labels,
      labelModel: labels === 'all' ? (model ?? DEFAULT_LABEL_MODEL) : null,
      days: SMALL_DAYS,
      sessions: this.sessions,
    }
  }

  // A session that ends in the 48 hours before the anchor, timed back from its end so it never runs between 48 and 47
  // hours before it.
  private readonly addRecent = (spec: ISessionSpec): void => {
    const recentEnd = spec.recentEnd ?? 'last-day'
    const key = `${spec.project}/d${String(SMALL_RECENT_DAYS[recentEnd])}/s1`
    const stream = createStream(this.inputs.seed, key)
    const drafted = turnsFrom(stream, 0, spec)
    const end =
      this.inputs.anchor - (recentEnd === 'last-hour' ? minutes(stream, 10, 40) : stream.integer(24, 30) * HOUR_MS)
    const shift = end - spanOf(drafted).end
    this.addSession(
      key,
      spec,
      drafted.map((turn) => ({ start: turn.start + shift, end: turn.end + shift })),
      stream
    )
  }

  private readonly addSession = (
    key: string,
    spec: ISessionSpec,
    turns: IPlannedTurn[],
    stream: IRandomStream
  ): void => {
    const writer = this.inputs.writers[spec.writer]
    const session = this.topLevelSession(key, spec, writer, turns, stream)
    this.sessions.push(session)
    const spawning = turns[SPAWNING_TURN]
    if (spec.spawn !== undefined && spawning !== undefined) {
      this.addChild(session, spawning, spec.spawn.isNested && has(writer, 'nested-subagent'), stream)
    }
    const [first] = turns
    if (spec.runsScripted === true && this.scripted?.writer === spec.writer && first !== undefined) {
      this.addScripted(session, this.scripted, first, stream)
    }
  }

  // The scripted session the host's shell call starts early in its turn: one short turn, the `claude -p` run.
  private readonly addScripted = (
    host: IPlannedSession,
    spec: ISessionSpec,
    turn: IPlannedTurn,
    stream: IRandomStream
  ): void => {
    const start = turn.start + stream.integer(20, 30) * SECOND_MS
    const turns = [{ start, end: start + stream.integer(30, 60) * SECOND_MS }]
    const session = this.topLevelSession(`${host.key}/run1`, spec, this.inputs.writers[spec.writer], turns, stream)
    this.sessions.push({ ...session, startedFrom: host.key })
  }

  // A field that needs a capability only where the writer declares it, and labels only where they are planned.
  private readonly topLevelSession = (
    key: string,
    spec: ISessionSpec,
    writer: IWriterDeclaration | undefined,
    turns: IPlannedTurn[],
    stream: IRandomStream
  ): IPlannedSession => {
    const item = this.inputs.corpus.work[spec.project].find((candidate) => candidate.title === spec.work)
    if (item === undefined) {
      throw new Error(`No work item ${spec.work} in ${spec.project}`)
    }
    const isLabelled = this.inputs.labels === 'all' && spec.outcome !== null
    return {
      key,
      writer: spec.writer,
      project: spec.project,
      origin: spec.isScripted === true && has(writer, 'scripted') ? 'scripted' : 'interactive',
      parentKey: null,
      ...spanOf(turns),
      title: spec.isUntitled === true ? null : item.title,
      gitBranch: has(writer, 'git-branch') ? stream.pick(this.inputs.corpus.projects[spec.project].branches) : null,
      agent: has(writer, 'session-agent') ? TOP_LEVEL_AGENT : null,
      work: item.title,
      shape: spec.shape,
      startedFrom: null,
      goal: isLabelled ? item.goal : null,
      outcome: isLabelled ? spec.outcome : null,
      turns,
    }
  }

  // A session started inside the parent's turn, as a subagent or a child session of the same writer.
  private readonly addChild = (
    parent: IPlannedSession,
    turn: IPlannedTurn,
    holdsNested: boolean,
    stream: IRandomStream
  ): void => {
    const key = `${parent.key}/sub1`
    const turns = childTurns(stream, turn.start + stream.integer(20, 50) * SECOND_MS, holdsNested)
    const child: IPlannedSession = {
      ...parent,
      key,
      origin: 'subagent',
      parentKey: parent.key,
      ...spanOf(turns),
      title: null,
      agent: null,
      goal: null,
      outcome: null,
      turns,
    }
    this.sessions.push(child)
    const first = turns[0]
    if (holdsNested && first !== undefined) {
      const nestedTurns = childTurns(stream, first.start + 30 * SECOND_MS, false)
      this.sessions.push({ ...child, key: `${key}/sub1`, parentKey: key, ...spanOf(nestedTurns), turns: nestedTurns })
    }
  }
}

// The small set's plan: which sessions exist, when, in which writer and project, and how they nest. Pure: it reads no
// clock, environment, file or locale, and the same inputs give an equal plan.
export const planDataset = (inputs: IPlanInputs): IPlan => {
  if (inputs.model !== null && !isLabelModelId(inputs.model)) {
    throw new LogBookError(
      `The labelling model ${JSON.stringify(inputs.model)} is not a model id.`,
      DEMO_ERROR_CODES.DEMO_PLAN_INVALID
    )
  }
  return new SmallPlanner(inputs).plan()
}
