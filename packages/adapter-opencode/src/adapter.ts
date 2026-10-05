import type { IHarnessAdapter, IHarnessDescriptor } from '@log-book/adapter-api'
import { prepareCommands } from './commands.js'
import { openDatabase } from './database.js'
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

export const openCode = (): IHarnessAdapter => ({
  descriptor: DESCRIPTOR,
  locate: locateDatabase,
  openSource: openDatabase,
  prepareCommands: (_location, env, projectDirs) => prepareCommands(env, projectDirs),
})
