import { readdir } from 'node:fs/promises'
import {
  ADAPTER_ERROR_CODES,
  type IAdapterContext,
  type IHarnessAdapter,
  type IHarnessDescriptor,
  type IHarnessLocation,
  type ISourceReader,
} from '@log-book/adapter-api'
import { ERROR_CODES, LogBookError } from '@log-book/core'
import { listTranscriptSets } from './listing.js'
import { CONFIG_DIR_VARIABLE, locateProjects } from './locate.js'

// name, defaultAgent and filterAlias are the values the conversation filter has always used.
const DESCRIPTOR: IHarnessDescriptor = {
  id: 'claude-code',
  name: 'Claude Code',
  defaultAgent: 'Claude',
  unitNoun: 'transcripts',
  filterAlias: 'claude',
  parserVersion: 1,
  testedVersions: ['2.1'],
  locationVariables: [CONFIG_DIR_VARIABLE],
}

const notImplemented = (what: string): Promise<never> =>
  Promise.reject(new LogBookError(`The Claude Code adapter cannot ${what} yet.`, ERROR_CODES.INTERNAL_ERROR))

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
    importUnit: () => notImplemented('import a transcript'),
    close: () => Promise.resolve(),
  }
}

export const claudeCode = (): IHarnessAdapter => ({
  descriptor: DESCRIPTOR,
  locate: locateProjects,
  openSource,
  prepareCommands: () => notImplemented('recognise commands'),
})
