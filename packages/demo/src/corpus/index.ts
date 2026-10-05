import type { IPlanCorpus } from '../plan/types.js'
import { COMMANDS } from './commands.js'
import corpusMark from './corpus-mark.json' with { type: 'json' }
import { MODEL_RATES, MODELS } from './models.js'
import { CAST, PROJECTS } from './projects.js'
import { PROMPTS } from './prompts.js'
import { REPLIES } from './replies.js'
import { SHAPES } from './shapes.js'
import { TOOLS } from './tools.js'
import { WORK } from './work.js'

// Every text the dataset holds comes from here, keyed by corpus file so a rule that finds a bad entry names its file
// and key; each corpus file's data exports are listed under it, so the corpus rules hold them all. The rules find
// prompts and command files by their key: a string at, or in a list at, a key named `prompt`, `openingPrompt` (a prompt
// a scripted session may open with) or `commandFile`.
export const CORPUS = {
  'commands.ts': { COMMANDS },
  'models.ts': { MODELS, MODEL_RATES },
  'projects.ts': { CAST, PROJECTS },
  'prompts.ts': { PROMPTS },
  'replies.ts': { REPLIES },
  'shapes.ts': { SHAPES },
  'tools.ts': { TOOLS },
  'work.ts': { WORK },
}

// The corpus the planner and the script builder take.
export const PLAN_CORPUS: IPlanCorpus = {
  projects: PROJECTS,
  work: WORK,
  shapes: SHAPES,
  prompts: PROMPTS,
  replies: REPLIES,
  tools: TOOLS,
  commands: COMMANDS,
  rates: MODEL_RATES,
}

// Recorded in every build's manifest; CI fails a packed tarball that contains it. It lives in a data file so the
// package check reads it without importing the demo.
export const DEMO_CORPUS_MARK = corpusMark.mark
