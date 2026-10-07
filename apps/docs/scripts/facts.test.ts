import { describe, expect, it } from 'vitest'
import { factOf, type Facts } from './facts.js'

const FACTS: Facts = {
  defaultPort: '7314',
  defaultAddress: 'http://127.0.0.1:7314',
  defaultModel: 'claude-haiku-4-5',
  nodeFloor: '24.15',
}

describe('factOf', () => {
  it('gives a fact by its name', () => {
    // Act
    const port = factOf(FACTS, 'defaultPort', 'start/first-run.md')

    // Assert
    expect(port).toBe('7314')
  })

  it('throws on an unknown name, naming it and the page', () => {
    expect(() => factOf(FACTS, 'defaultColour', 'start/first-run.md')).toThrow(
      'start/first-run.md asks for the fact defaultColour'
    )
  })
})
