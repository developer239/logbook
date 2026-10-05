import { conformanceCases } from '@log-book/adapter-api/conformance'
import { describe, expect, it } from 'vitest'
import { fixtureSet21 } from '../fixtures/fixture-set.js'
import { claudeCode } from './adapter.js'

describe('the Claude Code adapter on the conformance suite', () => {
  it.each(conformanceCases(claudeCode(), [fixtureSet21]).map((testCase) => [testCase.name, testCase]))(
    '%s',
    async (_name, testCase) => {
      // Act
      const run = testCase.run()

      // Assert
      await expect(run).resolves.toBeUndefined()
    }
  )
})
