import type { IItemPart } from '@log-book/engine'
import { describe, expect, it } from 'vitest'
import { callSitesOf, callSitesPage, itemContentsPage } from './privacy.js'

const CONTENTS: Readonly<Record<string, readonly IItemPart[]>> = {
  second: [{ part: 'reply', chars: 2500, keep: 'start' }],
  first: [
    { part: '(FAILED) or (ok)', chars: null, keep: 'start' },
    { part: 'output tail', chars: 300, keep: 'end' },
  ],
}

describe('itemContentsPage', () => {
  it('lists the tasks in task order, each with its parts in order and their clip sizes', () => {
    // Act
    const page = itemContentsPage(CONTENTS, ['first', 'second'])

    // Assert
    expect(page.split('\n')).toStrictEqual([
      '| Task | Part, in order | Clip size |',
      '| --- | --- | --- |',
      '| `first` | (FAILED) or (ok) | not cut |',
      '|  | output tail | 300 characters, from the end |',
      '| `second` | reply | 2500 characters, from the start |',
      '',
    ])
  })
})

describe('callSitesPage', () => {
  it('gives each entry of the call-site file one row with its file, what it calls and its case', () => {
    // Arrange
    const sites = callSitesOf(
      JSON.stringify([{ file: 'apps/cli/src/host-server.ts', calls: 'listens', case: 'local' }])
    )

    // Act
    const page = callSitesPage(sites)

    // Assert
    expect(page.split('\n').slice(2)).toStrictEqual(['| `apps/cli/src/host-server.ts` | listens | local |', ''])
  })

  it('refuses a call-site file that is not a list of entries', () => {
    expect(() => callSitesOf('[{"file": "apps/cli/src/host-server.ts"}]')).toThrow(
      'The network call-site file is not a list of entries with file, calls and case'
    )
  })
})
