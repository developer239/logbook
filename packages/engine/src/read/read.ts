import { WarehouseStore } from '@log-book/warehouse'
import { formatQuery, formatSearch, formatSessions, formatTimeline, formatTree } from './format.js'
import { WarehouseQueries, type ISessionFilter } from './queries.js'
import { REPORTS, reportsFor } from './reports.js'

const DEFAULT_MAX_ROWS = 200

// The CLI's read commands, each answered as the markdown it prints. Each opens the warehouse read-only, so it never
// blocks a sync and can never write; a missing warehouse, or one at another version, ends it with the store's error.
export interface IReadOperations {
  readonly sessions: (filter?: ISessionFilter) => Promise<string>
  readonly search: (query: string, options?: { limit?: number }) => Promise<string>
  readonly tree: (session: string, options?: { isFromRoot?: boolean }) => Promise<string>
  readonly timeline: (session: string) => Promise<string>
  // A report name, a topic or `all`; each report printed with its title and description.
  readonly report: (selector: string, options?: { maxRows?: number }) => Promise<string>
  readonly sql: (query: string, options?: { maxRows?: number }) => Promise<string>
}

export const readOperations = (warehousePath: string): IReadOperations => {
  const answer = async (work: (queries: WarehouseQueries) => string): Promise<string> => {
    const reader = await WarehouseStore.openReadOnly(warehousePath)
    try {
      return work(new WarehouseQueries(reader))
    } finally {
      reader.close()
    }
  }
  return {
    sessions: async (filter = {}) => answer((queries) => formatSessions(queries.sessions(filter))),
    search: async (query, options = {}) =>
      answer((queries) => formatSearch(query, queries.search(query, options.limit))),
    tree: async (session, options = {}) =>
      answer((queries) => formatTree(queries.tree(options.isFromRoot === true ? queries.rootOf(session) : session))),
    timeline: async (session) =>
      answer((queries) => {
        const resolved = queries.resolveSession(session)
        return formatTimeline(resolved, queries.timeline(resolved))
      }),
    report: async (selector, options = {}) => {
      const names = reportsFor(selector)
      return answer((queries) =>
        names
          .map((name) => {
            const { title, description, sql } = REPORTS[name]
            return formatQuery(title, queries.query(sql, options.maxRows ?? DEFAULT_MAX_ROWS), description)
          })
          .join('\n')
      )
    },
    sql: async (query, options = {}) =>
      answer((queries) => formatQuery('Query', queries.query(query, options.maxRows ?? DEFAULT_MAX_ROWS))),
  }
}
