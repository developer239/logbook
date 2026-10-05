import type { IHarnessAdapter, IHarnessDescriptor } from '@log-book/adapter-api'
import { ERROR_CODES, LogBookError } from '@log-book/core'
import { DATA_HOME_VARIABLE, DATABASE_VARIABLE, DISABLE_CHANNEL_DATABASE_VARIABLE, locateDatabase } from './locate.js'

// name, defaultAgent and filterAlias are the values the conversation filter has always used.
const DESCRIPTOR: IHarnessDescriptor = {
  id: 'opencode',
  name: 'OpenCode',
  defaultAgent: 'OpenCode',
  unitNoun: 'sessions',
  filterAlias: 'opencode',
  parserVersion: 1,
  testedVersions: ['2.0'],
  locationVariables: [DATABASE_VARIABLE, DISABLE_CHANNEL_DATABASE_VARIABLE, DATA_HOME_VARIABLE],
}

const notImplemented = (what: string): Promise<never> =>
  Promise.reject(new LogBookError(`The OpenCode adapter cannot ${what} yet.`, ERROR_CODES.INTERNAL_ERROR))

export const openCode = (): IHarnessAdapter => ({
  descriptor: DESCRIPTOR,
  locate: locateDatabase,
  openSource: () => notImplemented('open its database'),
  prepareCommands: () => notImplemented('recognise commands'),
})
