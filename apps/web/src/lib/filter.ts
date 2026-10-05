import { ParamError } from './errors'

// Terms of different fields all apply; the values of one field are alternatives.
export const FILTER_FIELDS = [
  'goal',
  'outcome',
  'by',
  'harness',
  'agent',
  'model',
  'project',
  'tool',
  'cause',
  'has',
] as const

export type FilterField = (typeof FILTER_FIELDS)[number]

const BY_VALUES = ['me', 'agent', 'script'] as const

const HAS_VALUES = ['failures', 'retry', 'correction', 'spawned'] as const

export interface IFilter {
  terms: Map<FilterField, string[]>
  text: string[]
}

const isField = (name: string): name is FilterField => (FILTER_FIELDS as readonly string[]).includes(name)

const TOKEN = /(\w+):("[^"]*"|[^\s",]+)((?:,(?:"[^"]*"|[^\s",]+))*)|"([^"]*)"|(\S+)/gu

const unquote = (value: string): string => (value.startsWith('"') ? value.slice(1, -1) : value)

const valuesOf = (first: string, rest: string): string[] =>
  [first, ...(rest.match(/"[^"]*"|[^,]+/gu) ?? [])].map(unquote).filter((value) => value.trim() !== '')

export const CLOSED: Partial<Record<FilterField, readonly string[]>> = { by: BY_VALUES, has: HAS_VALUES }

export const parseFilter = (query: string): IFilter => {
  const terms = new Map<FilterField, string[]>()
  const text: string[] = []

  for (const match of query.matchAll(TOKEN)) {
    const [, name, first, rest, phrase, word] = match
    const field = name?.toLowerCase()

    if (field !== undefined && first !== undefined && isField(field)) {
      const values = valuesOf(first, rest ?? '')

      if (values.length === 0) {
        throw new ParamError(`${field}: takes a value, got none`)
      }

      const allowed = CLOSED[field]

      if (allowed !== undefined) {
        const wrong = values.find((value) => !allowed.includes(value))

        if (wrong !== undefined) {
          throw new ParamError(`${field}: takes ${allowed.join(', ')}, got ${wrong}`)
        }
      }

      const known = terms.get(field)

      if (known === undefined) {
        terms.set(field, values)
      } else {
        known.push(...values)
      }

      continue
    }

    const said = phrase ?? word ?? match[0]

    if (said.trim() !== '') {
      text.push(said)
    }
  }

  return { terms, text }
}

const quoted = (value: string): string => (/[\s,]/u.test(value) ? `"${value}"` : value)

export const formatFilter = (filter: IFilter): string =>
  [
    ...[...filter.terms.entries()].map(([field, values]) => `${field}:${values.map(quoted).join(',')}`),
    ...filter.text.map((said) => (/\s/u.test(said) ? `"${said}"` : said)),
  ].join(' ')

export const emptyFilter = (): IFilter => ({ terms: new Map(), text: [] })

export const filterOf = (field: FilterField, values: readonly string[]): IFilter => ({
  terms: new Map([[field, [...values]]]),
  text: [],
})

export const toggleTerms = (filter: IFilter, field: FilterField, values: readonly string[]): IFilter => {
  const terms = new Map(filter.terms)
  const current = terms.get(field) ?? []
  const next = hasTerms(filter, field, values)
    ? current.filter((value) => !values.includes(value))
    : [...current, ...values.filter((value) => !current.includes(value))]

  if (next.length === 0) {
    terms.delete(field)
  } else {
    terms.set(field, next)
  }

  return { terms, text: filter.text }
}

export const hasTerms = (filter: IFilter, field: FilterField, values: readonly string[]): boolean =>
  values.every((value) => filter.terms.get(field)?.includes(value) === true)
