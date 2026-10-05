// One workspace package an importer may take, through any subpath unless `subpath` names the only one.
interface IAllowedImport {
  readonly name: string
  readonly subpath?: string
}

export interface IDependencyRow {
  readonly mayImport: readonly IAllowedImport[]
  // Every workspace package of the row is a development dependency, never a runtime one.
  readonly isDevOnly?: boolean
}

const CORE = { name: '@log-book/core' }
const WAREHOUSE = { name: '@log-book/warehouse' }
const ADAPTER_API = { name: '@log-book/adapter-api' }
const CLAUDE_CODE = { name: '@log-book/adapter-claude-code' }
const OPENCODE = { name: '@log-book/adapter-opencode' }
const ENGINE = { name: '@log-book/engine' }
const WEB = { name: '@log-book/web' }
const SOURCE_WRITER = '/source-writer'

// The package any workspace package may take only as a development dependency and import only from tests.
export const DEMO_PACKAGE = '@log-book/demo'
// The package no workspace package may depend on: its commands read files.
export const CI_PACKAGE = '@log-book/ci'

// The dependency rule: what each workspace package may import; anything not listed is forbidden.
export const DEPENDENCY_RULE: Readonly<Record<string, IDependencyRow>> = {
  [CORE.name]: { mayImport: [] },
  [WAREHOUSE.name]: { mayImport: [CORE] },
  [ADAPTER_API.name]: { mayImport: [CORE, WAREHOUSE] },
  [CLAUDE_CODE.name]: { mayImport: [CORE, WAREHOUSE, ADAPTER_API] },
  [OPENCODE.name]: { mayImport: [CORE, WAREHOUSE, ADAPTER_API] },
  [ENGINE.name]: { mayImport: [CORE, WAREHOUSE, ADAPTER_API] },
  [WEB.name]: { mayImport: [CORE, WAREHOUSE] },
  '@log-book/cli': { mayImport: [CORE, WAREHOUSE, ADAPTER_API, CLAUDE_CODE, OPENCODE, ENGINE, WEB] },
  [DEMO_PACKAGE]: {
    mayImport: [
      CORE,
      WAREHOUSE,
      ADAPTER_API,
      { ...CLAUDE_CODE, subpath: SOURCE_WRITER },
      { ...OPENCODE, subpath: SOURCE_WRITER },
      ENGINE,
    ],
  },
  '@log-book/docs': {
    mayImport: [ENGINE, { name: DEMO_PACKAGE }, { name: '@log-book/cli', subpath: '/grammar' }],
    isDevOnly: true,
  },
  [CI_PACKAGE]: { mayImport: [] },
}
