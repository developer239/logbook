import { goalName } from '../labels'

interface ITimeRow {
  label: string
  title: string
  dot: number
  tick: number | null
  lead: string
  trail: string
}

export interface ITimeRows {
  rows: ITimeRow[]
  floor: number
  ceiling: number
}

export const GOAL_ROWS = 7

export const rowLabel = (goal: string | null): string => (goal === null ? 'All' : goalName(goal))
