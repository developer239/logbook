import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { LABEL_TASK_NAMES, LABEL_TASKS } from './tasks.js'
import {
  PROMPT_ACTS,
  REACTION_ABOUT,
  REACTION_REACH,
  REACTION_TARGETS,
  REACTIONS,
  REPLY_CODES,
  SECOND_GOALS,
  SESSION_GOALS,
  SESSION_OUTCOMES,
  SHELL_FAILURES,
  SHELL_PURPOSES,
  TOOL_FAILURE_CAUSES,
} from './vocabularies.js'

const readVersions = async (): Promise<unknown> =>
  JSON.parse(await readFile(new URL('./tasks/versions.json', import.meta.url), 'utf8'))

describe('tasks/versions.json', () => {
  it('holds exactly the six tasks in task order, each a positive integer', async () => {
    // Arrange
    const versions = (await readVersions()) as Record<string, unknown>

    // Act
    const shape = {
      keys: Object.keys(versions),
      isEachPositiveInteger: Object.values(versions).every((value) => Number.isSafeInteger(value) && Number(value) > 0),
    }

    // Assert
    expect(shape).toStrictEqual({ keys: [...LABEL_TASK_NAMES], isEachPositiveInteger: true })
  })

  it('is where every task takes its version', async () => {
    // Arrange
    const versions = (await readVersions()) as Record<string, number>

    // Act
    const taskVersions = Object.fromEntries(LABEL_TASKS.map((task) => [task.name, task.version]))

    // Assert
    expect(taskVersions).toStrictEqual(versions)
  })
})

describe('LABEL_TASKS', () => {
  it('follows the task table', () => {
    // Arrange
    const tasks = LABEL_TASKS.map(({ name, recordTypes, batchSize, fields }) => ({
      name,
      recordTypes,
      batchSize,
      fields: fields.map((field) => [field.name, field.recordType, field.kind]),
    }))

    // Act
    const names = tasks.map((task) => task.name)

    // Assert
    expect(names).toStrictEqual([...LABEL_TASK_NAMES])
    expect(tasks).toStrictEqual([
      {
        name: 'shell',
        recordTypes: ['tool_call'],
        batchSize: 25,
        fields: [
          ['purpose', 'tool_call', 'code'],
          ['failure', 'tool_call', 'code'],
        ],
      },
      { name: 'tool-failure', recordTypes: ['tool_call'], batchSize: 25, fields: [['cause', 'tool_call', 'code']] },
      {
        name: 'session',
        recordTypes: ['session'],
        batchSize: 20,
        fields: [
          ['goal', 'session', 'code'],
          ['secondGoal', 'session', 'code'],
          ['summary', 'session', 'text'],
        ],
      },
      {
        name: 'outcome',
        recordTypes: ['session'],
        batchSize: 20,
        fields: [
          ['outcome', 'session', 'code'],
          ['outcomeNote', 'session', 'text'],
        ],
      },
      {
        name: 'prompt',
        recordTypes: ['message', 'reaction'],
        batchSize: 8,
        fields: [
          ['act', 'message', 'code'],
          ['reaction', 'reaction', 'code'],
          ['about', 'reaction', 'code'],
          ['target', 'reaction', 'code'],
          ['reach', 'reaction', 'code'],
          ['steps', 'reaction', 'refs'],
        ],
      },
      {
        name: 'reply',
        recordTypes: ['message'],
        batchSize: 8,
        fields: [
          ['reply', 'message', 'codes'],
          ['replyQuote', 'message', 'text'],
        ],
      },
    ])
  })

  it('gives a code field its vocabulary tuple itself and a text or refs field none', () => {
    // Arrange
    const expected: Record<string, readonly string[] | null> = {
      purpose: SHELL_PURPOSES,
      failure: SHELL_FAILURES,
      cause: TOOL_FAILURE_CAUSES,
      goal: SESSION_GOALS,
      secondGoal: SECOND_GOALS,
      summary: null,
      outcome: SESSION_OUTCOMES,
      outcomeNote: null,
      act: PROMPT_ACTS,
      reaction: REACTIONS,
      about: REACTION_ABOUT,
      target: REACTION_TARGETS,
      reach: REACTION_REACH,
      steps: null,
      reply: REPLY_CODES,
      replyQuote: null,
    }

    // Act
    const mismatched = LABEL_TASKS.flatMap((task) => task.fields).filter(
      (field) => field.values !== expected[field.name]
    )

    // Assert
    expect(mismatched).toStrictEqual([])
  })
})
