import type { ToolFamily } from './tool-families.js'

// Tools of one add-on tool set the owner uses, by lowercase bare name, as data only: nothing in Log Book imports that
// add-on, reads its files or checks whether it is installed. The order is kept: source writers pick the first key
// with a family. These names appear in this file only; tests read the keys.
export const KNOWN_TOOLS: ReadonlyMap<string, ToolFamily> = new Map<string, ToolFamily>([
  ['oc_run', 'dispatch'],
  ['orch_dispatch', 'dispatch'],
  ['oc_wait_runs', 'wait'],
  ['orch_wait', 'wait'],
])
