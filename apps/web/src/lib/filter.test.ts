import { describe, expect, it } from 'vitest'
import { ParamError } from './errors'
import { emptyFilter, filterOf, formatFilter, parseFilter, toggleTerms } from './filter'

describe('filter', () => {
  it('should read fields, quoted and comma-separated values, and the rest as text', () => {
    const filter = parseFilter('goal:"fix a bug" outcome:blocked,failed migration "badge catalog" http://x.y')

    expect(Object.fromEntries(filter.terms)).toEqual({ goal: ['fix a bug'], outcome: ['blocked', 'failed'] })
    expect(filter.text).toEqual(['migration', 'badge catalog', 'http://x.y'])
  })

  it('should search for a field it does not know as text', () => {
    expect(parseFilter('foo:bar').text).toEqual(['foo:bar'])
  })

  it('should merge a field given twice and reject a value a closed field does not take', () => {
    expect(parseFilter('by:me has:retry has:spawned').terms.get('has')).toEqual(['retry', 'spawned'])
    expect(() => parseFilter('by:robot')).toThrow(ParamError)
  })

  it('should write a filter back the way it reads, and toggle terms', () => {
    const filter = parseFilter('goal:"fix a bug" by:me retry')

    expect(formatFilter(filter)).toBe('goal:"fix a bug" by:me retry')
    expect(formatFilter(toggleTerms(filter, 'by', ['me']))).toBe('goal:"fix a bug" retry')
    expect(formatFilter(toggleTerms(filter, 'has', ['failures']))).toBe('goal:"fix a bug" by:me has:failures retry')
  })

  it('should read a field name in any case and refuse a value a closed field does not take, naming what it takes', () => {
    expect(parseFilter('GOAL:review').terms.get('goal')).toEqual(['review'])
    expect(() => parseFilter('has:everything')).toThrow(
      'has: takes failures, retry, correction, spawned, got everything'
    )
  })

  it('should build the filter of one field, or of none, that writes the way it reads', () => {
    expect(formatFilter(filterOf('goal', ['fix a bug', 'review']))).toBe('goal:"fix a bug",review')
    expect(formatFilter(emptyFilter())).toBe('')
  })
})
