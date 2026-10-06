import type { IRandomStream } from '../random.js'
import { MINUTE_MS } from './calendar.js'
import type { ISessionSpec } from './small.js'
import type { IPlanInputs, IPlannedSession, IPlannedTurn, IWriterDeclaration } from './types.js'

const SECOND_MS = 1000
// The turn of a session that starts another session, long enough to hold it.
const SPAWNING_TURN = 1
const TOP_LEVEL_AGENT = 'build'

export const minutes = (stream: IRandomStream, min: number, max: number): number =>
  stream.integer(min, max) * MINUTE_MS + stream.integer(0, 59) * SECOND_MS

export const has = (writer: IWriterDeclaration | undefined, capability: string): boolean =>
  writer?.capabilities.includes(capability) === true

// A session's turns from `start`: each takes minutes, the spawning turn long enough to hold the session it starts, and
// a short gap between turns except the idle stretch. At least two turns, three for one that starts a session.
export const turnsFrom = (
  stream: IRandomStream,
  start: number,
  spec: ISessionSpec,
  maxTurns: number
): IPlannedTurn[] => {
  const count = stream.integer(spec.spawn === undefined ? 2 : SPAWNING_TURN + 2, maxTurns)
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

export const spanOf = (turns: readonly IPlannedTurn[]): { start: number; end: number } => ({
  start: turns[0]?.start ?? 0,
  end: turns.at(-1)?.end ?? 0,
})

// What both sizes' planners share: a top-level session from its spec, the session it starts inside its spawning turn,
// and the scripted session its first turn's shell call runs.
export abstract class SessionPlanner {
  protected readonly inputs: IPlanInputs
  protected readonly sessions: IPlannedSession[] = []

  constructor(inputs: IPlanInputs) {
    this.inputs = inputs
  }

  // The scripted session a host's first turn runs, or undefined for one that runs none.
  protected abstract scriptedFor(spec: ISessionSpec): ISessionSpec | undefined

  protected readonly addSession = (
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
    const scripted = spec.runsScripted === true ? this.scriptedFor(spec) : undefined
    if (scripted !== undefined && first !== undefined) {
      this.addScripted(session, scripted, first, stream)
    }
  }

  // A field that needs a capability only where the writer declares it, and labels only where they are planned.
  protected readonly topLevelSession = (
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
