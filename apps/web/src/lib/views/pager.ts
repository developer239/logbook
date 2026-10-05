export interface IPageSpan {
  first: number
  last: number
  hasNewer: boolean
  hasOlder: boolean
}

export const pageSpan = (page: number, size: number, total: number): IPageSpan | null =>
  total <= size
    ? null
    : {
        first: page * size + 1,
        last: Math.min(total, (page + 1) * size),
        hasNewer: page > 0,
        hasOlder: (page + 1) * size < total,
      }
