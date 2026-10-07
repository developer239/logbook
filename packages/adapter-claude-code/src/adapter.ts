import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ADAPTER_ERROR_CODES,
  type IAdapterContext,
  type IHarnessAdapter,
  type IHarnessDescriptor,
  type IHarnessLocation,
  type ISourceReader,
} from '@log-book/adapter-api'
import { LogBookError } from '@log-book/core'
import { prepareCommands } from './commands.js'
import { importTranscript } from './import-transcript.js'
import { listTranscriptSets } from './listing.js'
import { CONFIG_DIR_VARIABLE, locateProjects } from './locate.js'
import { ADAPTER_ID } from './session-builder.js'

// name, defaultAgent and filterAlias are the values the conversation filter has always used.
const DESCRIPTOR: IHarnessDescriptor = {
  id: ADAPTER_ID,
  name: 'Claude Code',
  defaultAgent: 'Claude',
  unitNoun: 'transcripts',
  filterAlias: 'claude',
  parserVersion: 2,
  testedVersions: ['2.1'],
  locationVariables: [CONFIG_DIR_VARIABLE],
}

// The reader holds no handle, so close does nothing; a transcript records no format marker besides each line's
// version, which the imported unit's harness version already reports.
const openSource = async (location: IHarnessLocation, context: IAdapterContext): Promise<ISourceReader> => {
  try {
    await readdir(location.root)
  } catch (error: unknown) {
    throw new LogBookError(
      `Cannot list ${location.root}: ${error instanceof Error ? error.message : String(error)}`,
      ADAPTER_ERROR_CODES.ADAPTER_SOURCE_UNREADABLE,
      error
    )
  }
  return {
    formatDrift: null,
    listUnits: () => listTranscriptSets(location.root, context.signal),
    importUnit: (unit) => importTranscript(join(location.root, unit.locator), unit.locator),
    close: () => Promise.resolve(),
  }
}

export const claudeCode = (): IHarnessAdapter => ({
  descriptor: DESCRIPTOR,
  locate: locateProjects,
  openSource,
  prepareCommands: (_location, env, projectDirs) => prepareCommands(env, projectDirs),
})
