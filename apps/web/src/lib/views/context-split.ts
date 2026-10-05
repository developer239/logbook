import { CONTEXT_KINDS, type ContextKind, type IContextSnapshot } from '../context'
import { pct } from '../format'

interface IContextSegment {
  kind: ContextKind
  tokens: number
  width: string
}

interface IContextBar {
  label: string
  total: number
  segments: IContextSegment[]
}

export interface IContextView {
  summary: IContextSegment[]
  bars: IContextBar[]
}

const segmentsOf = (snapshot: IContextSnapshot, most: number): IContextSegment[] =>
  CONTEXT_KINDS.filter((kind) => snapshot.byKind[kind] > 0).map((kind) => ({
    kind,
    tokens: snapshot.byKind[kind],
    width: pct(snapshot.byKind[kind] / most),
  }))

// One scale, so the last bar shows how far the turn grew.
export const contextView = (first: IContextSnapshot, last: IContextSnapshot, isSame: boolean): IContextView => {
  const most = Math.max(first.total, last.total, 1)

  const bar = (label: string, snapshot: IContextSnapshot): IContextBar => ({
    label,
    total: snapshot.total,
    segments: segmentsOf(snapshot, most),
  })

  return {
    summary: segmentsOf(last, most),
    bars: isSame
      ? [bar('In the context', last)]
      : [bar('At its first request', first), bar('At its last request', last)],
  }
}
