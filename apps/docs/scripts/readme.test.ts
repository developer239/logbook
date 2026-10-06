import { describe, expect, it } from 'vitest'
import { firstLineOf } from './readme.js'

describe('firstLineOf', () => {
  it.each([
    ['an empty first line', '\nLog Book in one sentence.\n'],
    ['a heading', '# Log Book\n'],
  ])('refuses %s', (_case, readme) => {
    expect(() => firstLineOf(readme)).toThrow('README.md must start with the one-sentence description')
  })
})
