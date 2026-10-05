import { homedir } from 'node:os'
import type { IAdapterEnvironment } from '@log-book/adapter-api'

// The environment every operation hands the adapters, built when the operation starts. Tests point it at a temporary
// home by setting HOME and the harness's own variables.
export const adapterEnvironment = (): IAdapterEnvironment => ({
  variables: process.env,
  homeDir: homedir(),
  cwd: process.cwd(),
  platform: process.platform === 'darwin' ? 'darwin' : 'linux',
})

// The `~/` form of every path the engine writes into the warehouse, also inside a message that quotes one: each
// occurrence of the home directory followed by `/` becomes `~/`. The home directory alone, and any path outside it,
// stay as they are. Imported columns are never converted: they hold what the harness recorded.
export const withHomeAsTilde = (text: string, homeDir: string): string => text.replaceAll(`${homeDir}/`, '~/')
