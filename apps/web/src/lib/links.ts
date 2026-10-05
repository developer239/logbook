import { ParamError } from './errors'
import { formatFilter, type IFilter } from './filter'
import type { IRange } from './range'

const withRange = (path: string, params: Readonly<Record<string, string>>, range: IRange | null): string => {
  const search = new URLSearchParams({ ...params, ...range?.params })
  const query = search.toString()
  return query === '' ? path : `${path}?${query}`
}

export const stepsHref = (params: Record<string, string>, range: IRange | null): string =>
  withRange('/steps', params, range)

export const tokensHref = (range: IRange | null): string => withRange('/tokens', {}, range)

const FILTER_PARAM = 'q'

export const conversationsHref = (filter: IFilter, range: IRange | null): string => {
  const query = formatFilter(filter)
  return withRange('/conversations', query === '' ? {} : { [FILTER_PARAM]: query }, range)
}

export const pageHref = (url: URL, page: number): string => {
  const params = new URLSearchParams(url.search)
  params.set('page', String(page))
  return `?${params.toString()}`
}

// A subagent's id holds a slash, so each part of it is its own segment.
export const encodeId = (id: string): string => id.split('/').map(encodeURIComponent).join('/')

const decodeSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment)
  } catch (error) {
    if (error instanceof URIError) {
      throw new ParamError(`${segment} is not a part of an id written as a link writes it`)
    }

    throw error
  }
}

// It reads the raw path: Astro decodes a route parameter only partly (it leaves
// %3A as it is but turns %25 into %).
export const decodeId = (path: string): string => path.split('/').map(decodeSegment).join('/')

export const conversationHref = (
  id: string,
  at: { turn?: string | null; step?: string | null },
  range: IRange | null
): string =>
  withRange(
    `/conversations/${encodeId(id)}`,
    Object.fromEntries(Object.entries(at).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    range
  )

export const paneHref = (id: string): string => `/pane/${encodeId(id)}`

export const anchor = (kind: 'turn' | 'step' | 'spawn', ...ids: string[]): string =>
  `${kind}-${ids.join('-').replaceAll(/[^\w-]/gu, '-')}`

export const withSelection = (params: URLSearchParams, at: { turn: string; step?: string | null }): URLSearchParams => {
  const selected = new URLSearchParams(params)
  selected.set('turn', at.turn)

  if (at.step === undefined || at.step === null) {
    selected.delete('step')
  } else {
    selected.set('step', at.step)
  }

  return selected
}

export const selectHref = (url: URL, at: { turn: string; step?: string | null }): string => {
  const params = withSelection(url.searchParams, at)
  const target = at.step === undefined || at.step === null ? anchor('turn', at.turn) : anchor('step', at.step)
  return `?${params.toString()}#${target}`
}
