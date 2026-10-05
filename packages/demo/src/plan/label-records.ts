import type { ISessionScript, ScriptStep } from '@log-book/adapter-api/source-writer'
import { humanTurns, isHumanPrompt } from './human-turns.js'
import type { IPlan, IPlannedSession, IWriterScripts } from './types.js'

export interface ISessionFacts {
  planned: IPlannedSession
  writer: number
  script: ISessionScript
  // The time of its newest step.
  newestAt: number
  // Whether it holds a message the human typed, a prompt or a template command.
  hasPrompt: boolean
}

interface IPromptFacts {
  session: string
  // The calls between the human prompt before and this one; null for a session's first human prompt.
  previousCalls: readonly string[] | null
  // The key of the agent's last text before the next human prompt.
  reply: string | null
}

interface IReplyFacts {
  session: string
  text: string
}

// The records each of the engine's tasks would select in the scripts, by plan key, and what the rules about them read.
export interface IRecordIndex {
  sessions: ReadonlyMap<string, ISessionFacts>
  // Shell calls, and failed calls outside the shell, by key, with the session each is in.
  shellCalls: ReadonlyMap<string, string>
  failedCalls: ReadonlyMap<string, string>
  // The human prompts and their replies of interactive sessions.
  prompts: ReadonlyMap<string, IPromptFacts>
  replies: ReadonlyMap<string, IReplyFacts>
}

const timesOf = (step: ScriptStep): number[] => {
  if (step.kind === 'reply' || step.kind === 'spawn' || step.kind === 'skill') {
    return [step.endAt]
  }
  if (step.kind === 'call') {
    return [step.startAt, step.endAt ?? step.startAt]
  }
  return [step.at]
}

class RecordIndexer {
  public readonly sessions = new Map<string, ISessionFacts>()
  public readonly shellCalls = new Map<string, string>()
  public readonly failedCalls = new Map<string, string>()
  public readonly prompts = new Map<string, IPromptFacts>()
  public readonly replies = new Map<string, IReplyFacts>()
  private readonly planned: ReadonlyMap<string, IPlannedSession>

  constructor(plan: IPlan) {
    this.planned = new Map(plan.sessions.map((session) => [session.key, session]))
  }

  public readonly add = (writer: number, script: ISessionScript): void => {
    const planned = this.planned.get(script.key)
    if (planned === undefined) {
      throw new Error(`The script ${script.key} has no planned session`)
    }
    this.sessions.set(script.key, {
      planned,
      writer,
      script,
      newestAt: Math.max(...script.steps.flatMap(timesOf)),
      hasPrompt: script.steps.some(isHumanPrompt),
    })
    for (const step of script.steps) {
      this.addStep(writer, script.key, step)
    }
    if (planned.origin === 'interactive') {
      this.addTurns(script)
    }
  }

  private readonly addStep = (writer: number, session: string, step: ScriptStep): void => {
    if (step.kind === 'call' && step.family === 'shell') {
      this.shellCalls.set(step.key, session)
    } else if (step.kind === 'call' && step.status === 'error') {
      this.failedCalls.set(step.key, session)
    } else if (step.kind === 'spawn') {
      this.add(writer, step.child)
    }
  }

  private readonly addTurns = (script: ISessionScript): void => {
    for (const turn of humanTurns(script.steps)) {
      const reply = turn.reply === null ? null : { session: script.key, text: turn.reply.text ?? '' }
      this.prompts.set(turn.prompt.key, {
        session: script.key,
        previousCalls: turn.previousCalls,
        reply: turn.reply?.key ?? null,
      })
      if (turn.reply !== null && reply !== null) {
        this.replies.set(turn.reply.key, reply)
      }
    }
  }
}

export const indexRecords = (plan: IPlan, scripts: readonly IWriterScripts[]): IRecordIndex => {
  const indexer = new RecordIndexer(plan)
  scripts.forEach((written, writer) => {
    for (const script of written.scripts) {
      indexer.add(writer, script)
    }
  })
  return indexer
}
