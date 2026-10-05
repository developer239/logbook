import { describe, expect, it } from 'vitest'
import {
  PROMPT_ACTS,
  REACTION_ABOUT,
  REACTION_REACH,
  REACTION_TARGETS,
  REACTIONS,
  REPLY_CODES,
  SECOND_GOALS,
  SESSION_GOALS,
  SESSION_INITIATORS,
  SESSION_ORIGINS,
  SESSION_OUTCOMES,
  SHELL_FAILURES,
  SHELL_PURPOSES,
  TOOL_FAILURE_CAUSES,
  TOOL_RECOVERIES,
} from './vocabularies.js'

describe('label vocabularies', () => {
  it('have the listed lengths', () => {
    // Arrange
    const vocabularies = {
      purpose: SHELL_PURPOSES,
      failure: SHELL_FAILURES,
      initiator: SESSION_INITIATORS,
      goal: SESSION_GOALS,
      secondGoal: SECOND_GOALS,
      outcome: SESSION_OUTCOMES,
      cause: TOOL_FAILURE_CAUSES,
      recovery: TOOL_RECOVERIES,
      act: PROMPT_ACTS,
      reaction: REACTIONS,
      about: REACTION_ABOUT,
      target: REACTION_TARGETS,
      reach: REACTION_REACH,
      reply: REPLY_CODES,
      origin: SESSION_ORIGINS,
    }

    // Act
    const lengths = Object.fromEntries(Object.entries(vocabularies).map(([name, values]) => [name, values.length]))

    // Assert
    expect(lengths).toStrictEqual({
      purpose: 14,
      failure: 6,
      initiator: 2,
      goal: 17,
      secondGoal: 18,
      outcome: 8,
      cause: 12,
      recovery: 2,
      act: 6,
      reaction: 6,
      about: 2,
      target: 8,
      reach: 3,
      reply: 13,
      origin: 3,
    })
  })

  it('makes the second goal none followed by the goals', () => {
    // Arrange
    const expected = ['none', ...SESSION_GOALS]

    // Act
    const secondGoals = [...SECOND_GOALS]

    // Assert
    expect(secondGoals).toStrictEqual(expected)
  })
})
