import { describe, expect, it } from 'vitest'
import { ParamError } from './errors'
import { checkPage, parsePage } from './paging'

describe('parsePage', () => {
  it('should read a missing page as the first', () => {
    expect(parsePage(new URLSearchParams())).toBe(0)
  })

  it('should refuse a number too large to count exactly', () => {
    expect(() => parsePage(new URLSearchParams('page=99999999999999999999'))).toThrow(ParamError)
  })
})

describe('checkPage', () => {
  it('should refuse a page past the last one', () => {
    expect(() => checkPage(5, 28, 100)).toThrow('There is no page 6; the list has 1 page')
  })

  it('should allow the first page of an empty list', () => {
    expect(() => checkPage(0, 0, 100)).not.toThrow()
  })
})
