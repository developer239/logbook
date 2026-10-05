import type { ScriptFamily } from './contract.js'

// For a family an adapter's own table lists, the intents a call may name and the neutral input keys of each; each
// writer writes them under its harness tool's own keys. A family missing here takes no intent, and its input is
// written as given.
export const SCRIPT_INTENTS: Readonly<Partial<Record<ScriptFamily, Readonly<Record<string, readonly string[]>>>>> = {
  'shell': { run: ['command'] },
  'read': { read: ['path'] },
  'edit': { edit: ['path', 'old', 'new'], write: ['path', 'content'] },
  'search': { text: ['pattern', 'path'], files: ['pattern'] },
  'web': { fetch: ['url'], search: ['query'] },
  'todo': { update: ['items'] },
  'question': { ask: ['question'] },
  'tool-search': { load: ['query'] },
  'wait': { output: ['task'] },
}
