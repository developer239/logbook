import { describe, expect, it } from 'vitest'
import { contextSnapshots, type ContextEvent } from './context'

const request = (id: string, tokens: number): ContextEvent => ({ type: 'request', id, tokens })
const prompt = (tokens: number): ContextEvent => ({ type: 'item', kind: 'prompts', label: 'prompt', tokens })
const result = (label: string, tokens: number): ContextEvent => ({ type: 'item', kind: 'builtIn', label, tokens })

describe('contextSnapshots', () => {
  it('should take what the first request holds beyond the prompt as the start', () => {
    const snapshots = contextSnapshots([prompt(100), request('r1', 30_100)], new Set(['r1']))

    expect(snapshots.get('r1')?.byKind).toMatchObject({ start: 30_000, prompts: 100, unaccounted: 0 })
  })

  it('should call growth the transcript does not explain unaccounted', () => {
    const snapshots = contextSnapshots(
      [prompt(100), request('r1', 30_100), result('Read a.ts', 2000), request('r2', 35_100)],
      new Set(['r2'])
    )

    expect(snapshots.get('r2')?.byKind).toMatchObject({ start: 30_000, builtIn: 2000, unaccounted: 3000 })
  })

  it('should shrink arrivals to the measured growth when their estimate is larger', () => {
    const snapshots = contextSnapshots(
      [prompt(100), request('r1', 30_100), result('Read a.ts', 4000), result('Read b.ts', 4000), request('r2', 34_100)],
      new Set(['r2'])
    )

    expect(snapshots.get('r2')?.byKind).toMatchObject({ builtIn: 4000, unaccounted: 0 })
    expect(snapshots.get('r2')?.largest.map((item) => item.tokens)).toEqual([2000, 2000, 100])
  })

  it('should start again from the start and what was carried when the context shrinks', () => {
    const snapshots = contextSnapshots(
      [
        prompt(100),
        request('r1', 30_100),
        result('Read a.ts', 90_000),
        request('r2', 120_100),
        prompt(500),
        request('r3', 45_000),
      ],
      new Set(['r3'])
    )

    expect(snapshots.get('r3')?.byKind).toMatchObject({ start: 30_000, carried: 14_500, prompts: 500, builtIn: 0 })
  })

  it('should leave out an arrival the measured growth shrinks to no tokens', () => {
    const snapshots = contextSnapshots(
      [prompt(100), request('r1', 30_100), result('Read a.ts', 2000), request('r2', 30_100)],
      new Set(['r2'])
    )

    expect(snapshots.get('r2')?.largest).toEqual([{ kind: 'prompts', label: 'prompt', tokens: 100 }])
  })

  it('should not call nothing carried over a compaction', () => {
    const snapshots = contextSnapshots(
      [request('r1', 30_000), result('Read a.ts', 90_000), request('r2', 120_000), request('r3', 30_000)],
      new Set(['r3'])
    )

    expect(snapshots.get('r3')?.byKind.carried).toBe(0)
    expect(snapshots.get('r3')?.largest).toEqual([])
  })
})
