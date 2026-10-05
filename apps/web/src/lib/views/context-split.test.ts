import { describe, expect, it } from 'vitest'
import { CONTEXT_KINDS, type ContextKind, type IContextSnapshot } from '../context'
import { contextView } from './context-split'

const snapshot = (total: number, held: Partial<Record<ContextKind, number>>): IContextSnapshot => ({
  total,
  byKind: Object.fromEntries(CONTEXT_KINDS.map((kind) => [kind, held[kind] ?? 0])) as Record<ContextKind, number>,
  largest: [],
})

describe('contextView', () => {
  it('should draw both bars on the scale of the larger one', () => {
    const first = snapshot(1000, { start: 800, prompts: 200 })
    const last = snapshot(4000, { start: 800, prompts: 200, builtIn: 3000 })

    const view = contextView(first, last, false)

    expect(view.bars.map((bar) => [bar.label, bar.total])).toEqual([
      ['At its first request', 1000],
      ['At its last request', 4000],
    ])
    expect(view.bars[0]?.segments.map((segment) => segment.width)).toEqual(['20.00%', '5.00%'])
    expect(view.bars[1]?.segments.map((segment) => segment.width)).toEqual(['20.00%', '5.00%', '75.00%'])
  })

  it('should keep the kinds the context holds, in the kinds order, with their tokens', () => {
    const last = snapshot(100, { unaccounted: 10, prompts: 90 })

    expect(contextView(last, last, true).summary).toEqual([
      { kind: 'prompts', tokens: 90, width: '90.00%' },
      { kind: 'unaccounted', tokens: 10, width: '10.00%' },
    ])
  })

  it('should draw one bar for a turn that made one request', () => {
    const only = snapshot(500, { start: 500 })

    expect(contextView(only, only, true).bars.map((bar) => bar.label)).toEqual(['In the context'])
  })
})
