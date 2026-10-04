import type { IEventRecord, IMessageRecord } from '@log-book/warehouse'

// The whole text of the part that stands for an attached image.
export const IMAGE_PART_TEXT = '(image)'

export const ADAPTER_ERROR_CODES = {
  // openSource: the location exists but cannot be opened (permission denied, not a SQLite file, corrupt, I/O error).
  ADAPTER_SOURCE_UNREADABLE: 'ADAPTER_SOURCE_UNREADABLE',
  // openSource: readable, but not in a shape the adapter reads; the message names exactly what is missing.
  ADAPTER_FORMAT_UNSUPPORTED: 'ADAPTER_FORMAT_UNSUPPORTED',
  // importUnit: listed, but gone when read.
  ADAPTER_UNIT_GONE: 'ADAPTER_UNIT_GONE',
  // importUnit: exists but cannot be read.
  ADAPTER_UNIT_UNREADABLE: 'ADAPTER_UNIT_UNREADABLE',
  // The engine: a unit breaks a rule of validateImportedUnit, or two units share a locator.
  ADAPTER_OUTPUT_INVALID: 'ADAPTER_OUTPUT_INVALID',
  // The engine, at createEngine: a descriptor breaks a rule.
  ADAPTER_REGISTRATION_INVALID: 'ADAPTER_REGISTRATION_INVALID',
} as const

const HARNESS_VERSION = /^(?<major>\d+)\.(?<minor>\d+)(?:\.(?<patch>\d+))?$/u

export const sessionIdOf = (adapterId: string, sourceId: string): string => `${adapterId}:${sourceId}`

export const childIdOf = (sessionId: string, sourceId: string): string => `${sessionId}/${sourceId}`

// The first and last time any message of a session records. A loop, not Math.min(...times): a long session has more
// times than a call can spread.
export const timeSpan = (
  messages: readonly Pick<IMessageRecord, 'createdAt' | 'completedAt'>[]
): { startedAt: number | null; endedAt: number | null } => {
  let startedAt: number | null = null
  let endedAt: number | null = null
  for (const message of messages) {
    const last = message.completedAt ?? message.createdAt
    startedAt = startedAt === null ? message.createdAt : Math.min(startedAt, message.createdAt)
    endedAt = endedAt === null ? last : Math.max(endedAt, last)
  }
  return { startedAt, endedAt }
}

// What an adapter records about a record it does not know: the record itself (or a block, part or row of one), or an
// unrecognised value of a known field. `raw` is the record as parsed, or the line as a string when it did not parse.
export type UnknownRecordDescription =
  | {
      readonly what: 'record' | 'block' | 'part' | 'row'
      readonly type: string
      readonly harnessVersion: string | null
      readonly raw: unknown
    }
  | { readonly what: 'field'; readonly field: string; readonly value: unknown }

// The `unknown` event every adapter writes for a record it does not know, built the same way in each.
export const unknownEvent = (
  sessionId: string,
  sourceId: string,
  at: number,
  description: UnknownRecordDescription
): IEventRecord => ({
  id: childIdOf(sessionId, sourceId),
  sessionId,
  kind: 'unknown',
  at,
  dataJson: JSON.stringify(description),
})

const parseHarnessVersion = (version: string): number[] | null => {
  const groups = HARNESS_VERSION.exec(version)?.groups
  if (groups === undefined) {
    return null
  }
  return [Number(groups.major), Number(groups.minor), Number(groups.patch ?? '0')]
}

// Compares `major.minor[.patch]` strings numerically (2.10 is newer than 2.9): negative, zero or positive, or null
// when either does not parse.
export const compareHarnessVersions = (first: string, second: string): number | null => {
  const left = parseHarnessVersion(first)
  const right = parseHarnessVersion(second)
  if (left === null || right === null) {
    return null
  }
  for (const [index, part] of left.entries()) {
    const difference = part - (right[index] ?? 0)
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}
