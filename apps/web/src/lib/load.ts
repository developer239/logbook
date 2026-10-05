import { NotFoundError, ParamError, WarehouseError } from './errors'
import { checkSchema, syncedAt } from './warehouse'

export type Loaded<TData> =
  | { ok: true; data: TData; syncedAt: number | null }
  | { ok: false; problem: string; status: number; syncedAt: number | null }

export const syncedAtOrNull = (): number | null => {
  try {
    checkSchema()
    return syncedAt()
  } catch (error) {
    if (error instanceof WarehouseError) {
      return null
    }

    throw error
  }
}

export const load = <TData>(read: () => TData): Loaded<TData> => {
  try {
    checkSchema()
    return { ok: true, data: read(), syncedAt: syncedAt() }
  } catch (error) {
    if (error instanceof WarehouseError) {
      return { ok: false, problem: error.message, status: error.status, syncedAt: null }
    }

    if (error instanceof ParamError || error instanceof NotFoundError) {
      return { ok: false, problem: error.message, status: error.status, syncedAt: syncedAtOrNull() }
    }

    throw error
  }
}
