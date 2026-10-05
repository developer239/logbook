import { ParamError } from './errors'
import { plural } from './format'

export const parsePage = (params: URLSearchParams): number => {
  const value = params.get('page') ?? '0'
  const page = /^\d+$/u.test(value) ? Number(value) : Number.NaN

  if (!Number.isSafeInteger(page)) {
    throw new ParamError(`page must be a whole number, got ${value}`)
  }

  return page
}

export const checkPage = (page: number, total: number, pageSize: number): void => {
  if (page > 0 && page * pageSize >= total) {
    const pages = Math.ceil(total / pageSize)
    throw new ParamError(`There is no page ${String(page + 1)}; the list has ${plural(pages, 'page')}`)
  }
}
