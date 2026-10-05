import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { ADAPTER_ERROR_CODES, sessionIdOf, type IImportedUnit } from '@log-book/adapter-api'
import { isErrnoCode, LogBookError } from '@log-book/core'
import { ADAPTER_ID, SessionBuilder } from './session-builder.js'
import { parseTranscript } from './transcript-lines.js'

const TRANSCRIPT_EXTENSION = '.jsonl'

const readTranscript = async (path: string, locator: string): Promise<string> => {
  try {
    return await readFile(path, 'utf8')
  } catch (error: unknown) {
    if (isErrnoCode(error, 'ENOENT')) {
      throw new LogBookError(`The transcript ${path} is gone.`, ADAPTER_ERROR_CODES.ADAPTER_UNIT_GONE, error)
    }
    throw new LogBookError(
      `Cannot read the transcript ${locator}: ${error instanceof Error ? error.message : String(error)}`,
      ADAPTER_ERROR_CODES.ADAPTER_UNIT_UNREADABLE,
      error
    )
  }
}

// One transcript, read whole, as one session whose source id is the file name without `.jsonl`; its harness version
// is the newest any line records.
export const importTranscript = async (path: string, locator: string): Promise<IImportedUnit> => {
  const sourceId = basename(locator, TRANSCRIPT_EXTENSION)
  const builder = new SessionBuilder(sessionIdOf(ADAPTER_ID, sourceId))
  for (const line of parseTranscript(await readTranscript(path, locator))) {
    builder.add(line)
  }
  return { sessions: [builder.build(sourceId)], harnessVersion: builder.harnessVersion }
}
