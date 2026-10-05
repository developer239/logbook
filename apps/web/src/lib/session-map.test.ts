import { describe, expect, it } from 'vitest'
import { mapPlaces } from './session-map'
import { MINUTE } from './time'

describe('mapPlaces', () => {
  it('should place nothing for a session with no turns', () => {
    expect(mapPlaces([])).toEqual([])
  })

  it('should place turns by their durations and the gaps between them', () => {
    const places = mapPlaces([
      { startedAt: 0, durationMs: 10 * MINUTE },
      { startedAt: 20 * MINUTE, durationMs: 20 * MINUTE },
    ])

    expect(places.map((place) => place.byTime)).toEqual([
      { start: 0, end: 0.25 },
      { start: 0.5, end: 1 },
    ])
  })

  it('should hold a long gap to an hour', () => {
    const places = mapPlaces([
      { startedAt: 0, durationMs: 60 * MINUTE },
      { startedAt: 10 * 60 * MINUTE, durationMs: 60 * MINUTE },
    ])

    expect(places.map((place) => place.byTime.start)).toEqual([0, 2 / 3])
  })

  it('should give every turn the same width by turn', () => {
    const places = mapPlaces([
      { startedAt: 0, durationMs: 1 },
      { startedAt: 5, durationMs: 1000 },
      { startedAt: 2000, durationMs: 1 },
      { startedAt: 3000, durationMs: 1 },
    ])

    expect(places.map((place) => place.byTurn)).toEqual([
      { start: 0, end: 0.25 },
      { start: 0.25, end: 0.5 },
      { start: 0.5, end: 0.75 },
      { start: 0.75, end: 1 },
    ])
  })
})
