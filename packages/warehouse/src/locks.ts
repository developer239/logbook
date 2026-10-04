import { randomUUID } from 'node:crypto'
import { existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { isErrnoCode, LogBookError } from '@log-book/core'
import { WAREHOUSE_ERROR_CODES, WarehouseLockHeldError } from './errors.js'

const SYNC_LOCK_SUFFIX = '.lock'
const LABELS_LOCK_SUFFIX = '.labels.lock'
const LOCK_FILE_MODE = 0o600
const RELEASING_SIGNALS = ['SIGTERM', 'SIGINT'] as const

const SYNC_LOCK_OPERATIONS = ['sync', 'compact', 'forget'] as const
const LABELS_LOCK_OPERATIONS = ['labels', 'compact', 'forget'] as const

export type SyncLockOperation = (typeof SYNC_LOCK_OPERATIONS)[number]
export type LabelsLockOperation = (typeof LABELS_LOCK_OPERATIONS)[number]

export interface ITakeLockOptions {
  // The holder the file names; the current process when omitted.
  pid?: number
}

export interface IHeldLock {
  // Deletes the lock file; calling it again does nothing.
  release: () => void
}

export interface ILockState<TOperation extends string> {
  // The file exists and its pid is alive.
  isHeld: boolean
  // The pid in the file is alive.
  isAlive: boolean
  pid: number | null
  startedAt: number | null
  operation: TOperation | null
}

interface ILockContent<TOperation extends string> {
  pid: number
  startedAt: number
  operation: TOperation
}

// kill(pid, 0) sends nothing: it succeeds for a live process, and EPERM means one that exists under another user.
const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return isErrnoCode(error, 'EPERM')
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const parseLockContent = <TOperation extends string>(
  path: string,
  text: string,
  operations: readonly TOperation[]
): ILockContent<TOperation> => {
  const unreadable = (cause?: unknown): LogBookError =>
    new LogBookError(
      `The lock file ${path} was not written by Log Book.`,
      WAREHOUSE_ERROR_CODES.WAREHOUSE_LOCK_UNREADABLE,
      cause
    )
  let content: unknown = null
  try {
    content = JSON.parse(text)
  } catch (error: unknown) {
    throw unreadable(error)
  }
  if (
    !isRecord(content) ||
    typeof content.pid !== 'number' ||
    !Number.isSafeInteger(content.pid) ||
    content.pid <= 0 ||
    typeof content.startedAt !== 'number' ||
    !operations.some((operation) => operation === content.operation)
  ) {
    throw unreadable()
  }
  return { pid: content.pid, startedAt: content.startedAt, operation: content.operation as TOperation }
}

const readLock = <TOperation extends string>(
  lockPath: string,
  operations: readonly TOperation[]
): ILockState<TOperation> => {
  if (!existsSync(lockPath)) {
    return { isHeld: false, isAlive: false, pid: null, startedAt: null, operation: null }
  }
  const content = parseLockContent(lockPath, readFileSync(lockPath, 'utf8'), operations)
  const isAlive = isProcessAlive(content.pid)
  return { isHeld: isAlive, isAlive, ...content }
}

// The file appears with its whole content: it is written under a temporary name and linked into place, which fails
// when the lock exists, so no reader or second taker ever sees it empty or half written.
const createLockFile = (lockPath: string, text: string): boolean => {
  const temporaryPath = `${lockPath}.${randomUUID()}.tmp`
  writeFileSync(temporaryPath, text, { mode: LOCK_FILE_MODE })
  try {
    linkSync(temporaryPath, lockPath)
    return true
  } catch (error: unknown) {
    if (isErrnoCode(error, 'EEXIST')) {
      return false
    }
    throw error
  } finally {
    unlinkSync(temporaryPath)
  }
}

const deleteLockFile = (lockPath: string): void => {
  try {
    unlinkSync(lockPath)
  } catch (error: unknown) {
    if (!isErrnoCode(error, 'ENOENT')) {
      throw error
    }
  }
}

// The signal listeners of every lock this process holds, so a listener can tell the caller's own apart from them.
const ownSignalListeners = new Set<() => void>()

// A holder ended by SIGTERM or SIGINT leaves no lock file. When the caller handles the signal itself (the engine ends
// its run record first), the caller releases the lock and decides when to exit; the 'exit' listener still releases it
// if the caller exits without doing so. Only when nothing but locks handles the signal does each lock release its
// file, and the last one ends the process the way the signal would have.
const releaseOnExit = (release: () => void): (() => void) => {
  const signalListeners = RELEASING_SIGNALS.map((signal) => {
    const listener = (): void => {
      const callerListeners = process.listeners(signal).filter((other) => !ownSignalListeners.has(other as () => void))
      if (callerListeners.length > 0) {
        return
      }
      release()
      if (process.listenerCount(signal) === 0) {
        process.kill(process.pid, signal)
      }
    }
    ownSignalListeners.add(listener)
    process.on(signal, listener)
    return { signal, listener }
  })
  process.on('exit', release)
  return () => {
    for (const { signal, listener } of signalListeners) {
      ownSignalListeners.delete(listener)
      process.off(signal, listener)
    }
    process.off('exit', release)
  }
}

const holdLock = (lockPath: string, pid: number): IHeldLock => {
  let isReleased = false
  let stopListening: (() => void) | null = null
  const release = (): void => {
    if (isReleased) {
      return
    }
    isReleased = true
    stopListening?.()
    deleteLockFile(lockPath)
  }
  if (pid === process.pid) {
    stopListening = releaseOnExit(release)
  }
  return { release }
}

const takeLock = <TOperation extends string>(
  lockPath: string,
  operation: TOperation,
  operations: readonly TOperation[],
  pid: number,
  isRetry = false
): IHeldLock => {
  if (createLockFile(lockPath, JSON.stringify({ pid, startedAt: Date.now(), operation }))) {
    return holdLock(lockPath, pid)
  }
  const holder = parseLockContent(lockPath, readFileSync(lockPath, 'utf8'), operations)
  // A stale lock is taken over once; a second failure is an error, not a loop.
  if (isProcessAlive(holder.pid) || isRetry) {
    throw new WarehouseLockHeldError(
      `The lock ${lockPath} is held by process ${String(holder.pid)} (${holder.operation}).`,
      { ...holder, path: lockPath }
    )
  }
  deleteLockFile(lockPath)
  return takeLock(lockPath, operation, operations, pid, true)
}

export const takeSyncLock = (
  warehousePath: string,
  operation: SyncLockOperation,
  { pid = process.pid }: ITakeLockOptions = {}
): IHeldLock => takeLock(`${warehousePath}${SYNC_LOCK_SUFFIX}`, operation, SYNC_LOCK_OPERATIONS, pid)

export const takeLabelsLock = (
  warehousePath: string,
  operation: LabelsLockOperation,
  { pid = process.pid }: ITakeLockOptions = {}
): IHeldLock => takeLock(`${warehousePath}${LABELS_LOCK_SUFFIX}`, operation, LABELS_LOCK_OPERATIONS, pid)

// Change nothing: a stale file stays where it is.
export const readSyncLock = (warehousePath: string): ILockState<SyncLockOperation> =>
  readLock(`${warehousePath}${SYNC_LOCK_SUFFIX}`, SYNC_LOCK_OPERATIONS)

export const readLabelsLock = (warehousePath: string): ILockState<LabelsLockOperation> =>
  readLock(`${warehousePath}${LABELS_LOCK_SUFFIX}`, LABELS_LOCK_OPERATIONS)
