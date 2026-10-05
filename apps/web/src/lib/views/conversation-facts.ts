import { count, duration } from '../format'
import { goalName, outcomeStatus, STARTED_BY, UNLABELLED_INLINE } from '../labels'
import type { IConversation } from '../queries/conversation'

export interface IFact {
  label: string
  value: string
  statusTone?: string
  badge?: string
  note?: string
  isWide?: boolean
}

export const conversationFacts = (head: IConversation): IFact[] => [
  {
    label: 'Took',
    value:
      head.startedAt === null || head.endedAt === null ? 'no time recorded' : duration(head.endedAt - head.startedAt),
  },
  { label: 'Active', value: duration(head.activeMs) },
  {
    label: 'Steps',
    value: count(head.steps),
    ...(head.failed > 0 ? { badge: `${count(head.failed)} failed` } : {}),
  },
  { label: 'Agents spawned', value: count(head.spawned) },
  { label: 'Compacted', value: head.compactions === 0 ? 'never' : `${count(head.compactions)}×` },
  { label: 'Goal', value: goalName(head.goal) },
  { label: 'Started by', value: STARTED_BY[head.startedBy] },
  {
    label: 'Outcome',
    value: head.outcome ?? UNLABELLED_INLINE,
    statusTone: outcomeStatus(head.outcome),
    ...(head.outcomeNote === null ? {} : { note: head.outcomeNote }),
    isWide: true,
  },
]
