import { all, get } from '../warehouse'

export interface ISqlCondition {
  sql: string
  params: (string | number | null)[]
}

export const allOf = (conditions: readonly ISqlCondition[]): ISqlCondition => ({
  sql: conditions.map((condition) => condition.sql).join(' AND '),
  params: conditions.flatMap((condition) => condition.params),
})

export interface IList {
  columns: string
  from: string
  where: ISqlCondition
  // Ties are broken by a column of its own, so a row is on one page only.
  order: string
}

// A page past the end has no row to carry the total, so only then is the list
// counted.
export const pagedRows = <TRow>(list: IList, page: number, size: number): { rows: TRow[]; total: number } => {
  const found = all<TRow & { total: number }>(
    `SELECT ${list.columns}, COUNT(*) OVER () AS total FROM ${list.from} WHERE ${list.where.sql}
     ORDER BY ${list.order} LIMIT ? OFFSET ?`,
    ...list.where.params,
    size,
    page * size
  )

  const [first] = found
  const rows = found.map(({ total: _total, ...row }) => row as TRow)

  if (first !== undefined) {
    return { rows, total: first.total }
  }

  if (page === 0) {
    return { rows, total: 0 }
  }

  const counted = get<{ total: number }>(
    `SELECT COUNT(*) AS total FROM ${list.from} WHERE ${list.where.sql}`,
    ...list.where.params
  )

  return { rows, total: counted?.total ?? 0 }
}
