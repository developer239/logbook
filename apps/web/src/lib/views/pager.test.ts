import { describe, expect, it } from 'vitest'
import { pageSpan } from './pager'

describe('pageSpan', () => {
  it('should have nothing to say for a list that fits on one page', () => {
    expect(pageSpan(0, 100, 100)).toBeNull()
    expect(pageSpan(0, 100, 0)).toBeNull()
  })

  it('should say the first page has only older ones', () => {
    expect(pageSpan(0, 100, 250)).toEqual({ first: 1, last: 100, hasNewer: false, hasOlder: true })
  })

  it('should say a middle page has both', () => {
    expect(pageSpan(1, 100, 250)).toEqual({ first: 101, last: 200, hasNewer: true, hasOlder: true })
  })

  it('should end the last page at the total, with only newer ones before it', () => {
    expect(pageSpan(2, 100, 250)).toEqual({ first: 201, last: 250, hasNewer: true, hasOlder: false })
    expect(pageSpan(1, 100, 200)).toEqual({ first: 101, last: 200, hasNewer: true, hasOlder: false })
  })
})
