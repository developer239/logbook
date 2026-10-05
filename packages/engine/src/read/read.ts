import { WarehouseStore } from '@log-book/warehouse'
import { formatQuery, formatSearch, formatSessions, formatTimeline, formatTree } from './format.js'
import { WarehouseQueries, type ISessionFilter } from './queries.js'

const DEFAULT_MAX_ROWS = 200

// The CLI's read commands, each answered as the markdown it prints. Each opens the warehouse read-only, so it never
// blocks a sync and can never write; a missing warehouse, or one at another version, ends it with the store's error.
export interface IReadOperations {
  readonly sessions: (filter?: ISessionFilter) => Promise<string>
  readonly search: (query: string, options?: { limit?: number }) => Promise<string>
  readonly tree: (session: string, options?: { isFromRoot?: boolean }) => Promise<string>
  readonly timeline: (session: string) => Promise<string>
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
    sql: async (query, options = {}) =>
      answer((queries) => formatQuery('Query', queries.query(query, options.maxRows ?? DEFAULT_MAX_ROWS))),
  }
}
