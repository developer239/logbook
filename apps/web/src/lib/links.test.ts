import { describe, expect, it } from 'vitest'
import { ParamError } from './errors'
import { emptyFilter, filterOf, parseFilter } from './filter'
import {
  anchor,
  conversationHref,
  conversationsHref,
  decodeId,
  encodeId,
  pageHref,
  paneHref,
  selectHref,
  stepsHref,
  tokensHref,
  withSelection,
} from './links'
import { parseRange } from './range'

const range = parseRange(new URLSearchParams('range=30d'))
const custom = parseRange(new URLSearchParams('from=2026-10-01&to=2026-10-03'))

describe('ids', () => {
  it('should encode each part of a subagent id as its own path segment, and read it back', () => {
    const id = 'ses_1/agent:a b%'

    expect(encodeId(id)).toBe('ses_1/agent%3Aa%20b%25')
    expect(decodeId(encodeId(id))).toBe(id)
  })

  it('should refuse a path no link wrote', () => {
    expect(() => decodeId('ses_1/%zz')).toThrow(ParamError)
  })

  it('should link a conversation and its pane by the encoded id', () => {
    expect(conversationHref('a/b:c', {}, null)).toBe('/conversations/a/b%3Ac')
    expect(paneHref('a/b:c')).toBe('/pane/a/b%3Ac')
  })
})

describe('pageHref', () => {
  it('should link another page of the list, keeping the other parameters', () => {
    expect(pageHref(new URL('http://app/steps?failed=1&range=30d'), 2)).toBe('?failed=1&range=30d&page=2')
    expect(pageHref(new URL('http://app/steps?page=3&failed=1'), 0)).toBe('?page=0&failed=1')
  })
})

describe('anchor', () => {
  it('should make an element id of ids that hold colons and slashes', () => {
    expect(anchor('turn', 'ses_1:msg/2')).toBe('turn-ses_1-msg-2')
    expect(anchor('spawn', 'a/b', 'c:d')).toBe('spawn-a-b-c-d')
  })
})

describe('hrefs', () => {
  it('should keep the range on a link, a custom one by its days', () => {
    expect(tokensHref(range)).toBe('/tokens?range=30d')
    expect(tokensHref(custom)).toBe('/tokens?from=2026-10-01&to=2026-10-03')
    expect(tokensHref(null)).toBe('/tokens')
  })

  it('should let the range replace a range the link names', () => {
    expect(stepsHref({ cause: 'Tool bug', range: 'all' }, range)).toBe('/steps?cause=Tool+bug&range=30d')
  })

  it('should name a turn and a step only when there are some', () => {
    expect(conversationHref('s1', { turn: 't1', step: null }, range)).toBe('/conversations/s1?turn=t1&range=30d')
    expect(conversationHref('s1', { turn: 't1', step: 'c1' }, null)).toBe('/conversations/s1?turn=t1&step=c1')
  })

  it('should write a filter on the conversations link, and none when there is none', () => {
    expect(conversationsHref(emptyFilter(), range)).toBe('/conversations?range=30d')
    expect(conversationsHref(filterOf('goal', ['fix a bug']), null)).toBe('/conversations?q=goal%3A%22fix+a+bug%22')
    expect(conversationsHref(parseFilter('outcome:failed retry'), null)).toBe('/conversations?q=outcome%3Afailed+retry')
  })
})

describe('selection', () => {
  it('should select a turn and drop the step, keeping the other parameters', () => {
    const params = withSelection(new URLSearchParams('range=7d&turn=a&step=s'), { turn: 'b' })

    expect(params.toString()).toBe('range=7d&turn=b')
  })

  it('should select a step in a turn', () => {
    const params = withSelection(new URLSearchParams('range=7d'), { turn: 'b', step: 's' })

    expect(params.toString()).toBe('range=7d&turn=b&step=s')
  })

  it('should not change the parameters it was given', () => {
    const params = new URLSearchParams('turn=a')

    withSelection(params, { turn: 'b', step: 's' })

    expect(params.toString()).toBe('turn=a')
  })

  it('should link to the page with a turn selected, scrolled to the turn or the step', () => {
    const url = new URL('http://localhost/conversations/s1?range=7d&turn=a&step=old')

    expect(selectHref(url, { turn: 'b:1' })).toBe('?range=7d&turn=b%3A1#turn-b-1')
    expect(selectHref(url, { turn: 'b:1', step: 'c/2' })).toBe('?range=7d&turn=b%3A1&step=c%2F2#step-c-2')
  })
})
