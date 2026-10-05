import { describe, expect, it } from 'vitest'
import { ITEM_CONTENTS } from './item-contents.js'
import { LABEL_TASK_NAMES } from './tasks.js'

describe('ITEM_CONTENTS', () => {
  it('has one entry per task in task order with the clip sizes of the request table', () => {
    // Arrange
    const tasks = Object.keys(ITEM_CONTENTS)

    // Act
    const sizes = Object.fromEntries(
      Object.entries(ITEM_CONTENTS).map(([task, parts]) => [
        task,
        parts.map(({ chars, keep }) => `${String(chars)}${keep === 'end' ? ' end' : ''}`),
      ])
    )

    // Assert
    expect(tasks).toStrictEqual([...LABEL_TASK_NAMES])
    expect(sizes).toStrictEqual({
      'shell': ['null', '1200', '300 end'],
      'tool-failure': ['null', '400', '600'],
      'session': ['null', '100', '900', '350', '400'],
      'outcome': ['null', '400', '400', '700', '300', '200'],
      'prompt': ['500', '500', '900', '140', 'null', '1500', '2000'],
      'reply': ['600', '1200', '140', '2500'],
    })
  })
})
