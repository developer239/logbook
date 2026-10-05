import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { isProcessAlive } from '@log-book/warehouse'

// The running host of one warehouse: its pid, the port its server is bound to, its version and when it started.
export interface IHostFile {
  pid: number
  port: number
  version: string
  startedAt: number
}

const HOST_FILE_MODE = 0o600
const PROBE_TIMEOUT_MS = 1000
// The header every response of a Log Book host carries.
const HOST_HEADER = 'x-log-book'

// This module's own location, which the network allowlist test reads, so moving the file without its entry fails.
export const HOST_PROBE_URL = import.meta.url

// Next to the warehouse, so a LOGBOOK_DB override moves it with the warehouse and a second warehouse has its own host.
export const hostFilePath = (warehousePath: string): string => `${warehousePath}.host`

// The file appears with its whole content: it is written under a temporary name and renamed into place, so a reader
// never sees it empty or half written.
export const writeHostFile = (path: string, host: IHostFile): void => {
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporaryPath, JSON.stringify(host), { mode: HOST_FILE_MODE })
  renameSync(temporaryPath, path)
}

// Safe to call when the file is gone.
export const deleteHostFile = (path: string): void => {
  rmSync(path, { force: true })
}

const isWhole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const parseHostFile = (text: string): IHostFile | null => {
  let content: unknown = null
  try {
    content = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(content)) {
    return null
  }
  const { pid, port, version, startedAt } = content
  if (isWhole(pid) && isWhole(port) && typeof version === 'string' && isWhole(startedAt)) {
    return { pid, port, version, startedAt }
  }
  return null
}

// The host file's content, or null when there is none or it does not parse.
export const readHostFile = (path: string): IHostFile | null => {
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  return parseHostFile(text)
}

// Whether a Log Book host answers on this loopback port: its response carries the x-log-book header. No header, an
// error or no answer within a second means another program holds the port, or none.
export const isLogBookAt = async (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const asking = request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', timeout: PROBE_TIMEOUT_MS },
      (response) => {
        response.resume()
        resolve(response.headers[HOST_HEADER] !== undefined)
      }
    )
    asking.on('timeout', () => {
      asking.destroy()
      resolve(false)
    })
    asking.on('error', () => {
      resolve(false)
    })
    asking.end()
  })

// The host that runs for this warehouse, or null. Both its pid and its answer count, since a pid alone can be reused
// by an unrelated process after a reboot; a file left behind otherwise is stale.
export const runningHost = async (path: string): Promise<IHostFile | null> => {
  const host = readHostFile(path)
  if (host === null || !isProcessAlive(host.pid)) {
    return null
  }
  return (await isLogBookAt(host.port)) ? host : null
}
