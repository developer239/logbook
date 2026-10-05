import { describe, expect, it } from 'vitest'
import * as engine from './index.js'

describe('@log-book/engine', () => {
  it('exports every vocabulary and labelling value from its root', () => {
    // Arrange
    const names = [
      'SHELL_PURPOSES',
      'SHELL_FAILURES',
      'SESSION_INITIATORS',
      'SESSION_GOALS',
      'SECOND_GOALS',
      'SESSION_OUTCOMES',
      'TOOL_FAILURE_CAUSES',
      'TOOL_RECOVERIES',
      'PROMPT_ACTS',
      'REACTIONS',
      'REACTION_ABOUT',
      'REACTION_TARGETS',
      'REACTION_REACH',
      'REPLY_CODES',
      'SESSION_ORIGINS',
      'LABEL_TASK_NAMES',
      'LABEL_TASKS',
      'DEFAULT_LABEL_MODEL',
      'isLabelModelId',
      'ITEM_CONTENTS',
    ]

    // Act
    const missing = names.filter((name) => !(name in engine))

    // Assert
    expect(missing).toStrictEqual([])
  })
})
