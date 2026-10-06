import { isLabelModelId, LogBookError } from '@log-book/core'
import { DEFAULT_LABEL_MODEL } from '@log-book/engine'
import { DEMO_ERROR_CODES } from '../errors.js'
import { createStream } from '../random.js'
import { dayStart, HOUR_MS } from './calendar.js'
import { RichPlanner } from './rich.js'
import { has, minutes, SessionPlanner, spanOf, turnsFrom } from './session-planner.js'
import {
  SMALL_ACTIVE_DAYS,
  SMALL_DAYS,
  SMALL_DOUBLE_DAYS,
  SMALL_LAST_OLDER_DAY,
  SMALL_RECENT_DAYS,
  SMALL_SESSIONS,
  type ISessionSpec,
} from './small.js'
import type { IPlan, IPlanInputs } from './types.js'

// The most turns a small session takes.
const SMALL_MAX_TURNS = 5

interface ISlot {
  day: number
  // 1 for the day's first session, 2 for its second.
  index: number
}

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

class SmallPlanner extends SessionPlanner {
  // The scripted session a host session's shell call runs, where its writer declares `scripted`.
  private scripted: ISessionSpec | undefined

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
      const turns = turnsFrom(stream, start, spec, SMALL_MAX_TURNS)
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
    const drafted = turnsFrom(stream, 0, spec, SMALL_MAX_TURNS)
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

  protected readonly scriptedFor = (spec: ISessionSpec): ISessionSpec | undefined =>
    this.scripted?.writer === spec.writer ? this.scripted : undefined
}

// The plan of a size: which sessions exist, when, in which writer and project, and how they nest. Pure: it reads no
// clock, environment, file or locale, and the same inputs give an equal plan.
export const planDataset = (inputs: IPlanInputs): IPlan => {
  if (inputs.model !== null && !isLabelModelId(inputs.model)) {
    throw new LogBookError(
      `The labelling model ${JSON.stringify(inputs.model)} is not a model id.`,
      DEMO_ERROR_CODES.DEMO_PLAN_INVALID
    )
  }
  return inputs.size === 'rich' ? new RichPlanner(inputs).plan() : new SmallPlanner(inputs).plan()
}
