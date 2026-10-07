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
  locationVariables: [
    { name: DATABASE_VARIABLE, changes: "OpenCode's database file; a relative path is inside its data directory" },
    {
      name: DISABLE_CHANNEL_DATABASE_VARIABLE,
      changes: '1 or true reads opencode.db, instead of the newest opencode-<channel>.db',
    },
    { name: DATA_HOME_VARIABLE, changes: "OpenCode's data directory (opencode inside it)" },
  ],
}

export const openCode = (): IHarnessAdapter => ({
  descriptor: DESCRIPTOR,
  locate: locateDatabase,
  openSource: openDatabase,
  prepareCommands: (_location, env, projectDirs) => prepareCommands(env, projectDirs),
})
