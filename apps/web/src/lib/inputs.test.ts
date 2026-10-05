import { describe, expect, it } from 'vitest'
import { mainInput, prettyInput } from './inputs'

describe('mainInput', () => {
  it('should read the field that says what a call did, the command before the description', () => {
    expect(mainInput(JSON.stringify({ description: 'list files', command: 'ls -la' }))).toBe('ls -la')
  })

  it('should skip a field that is empty and read the next', () => {
    expect(mainInput(JSON.stringify({ command: '  ', path: '/tmp/a.ts' }))).toBe('/tmp/a.ts')
  })

  it('should take the first text field of an input it knows no field of', () => {
    expect(mainInput(JSON.stringify({ count: 3, label: 'second', other: 'third' }))).toBe('second')
  })

  it('should put the text on one line and cut it on whole characters', () => {
    expect(mainInput(JSON.stringify({ command: 'echo   a\nb' }))).toBe('echo a b')
    expect(mainInput(JSON.stringify({ command: 'abcdefghij' }), 5)).toBe('abcd…')
  })

  it('should show an input with no text as compact JSON, and one that is not JSON as it is', () => {
    expect(mainInput(JSON.stringify({ count: 3 }))).toBe('{"count":3}')
    expect(mainInput('not json')).toBe('not json')
  })
})

describe('prettyInput', () => {
  it('should indent JSON and leave anything else as it is', () => {
    expect(prettyInput('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(prettyInput('not json')).toBe('not json')
  })
})
