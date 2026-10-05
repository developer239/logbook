// The model ids each writer records, spelled as that harness spells current public ones. A new model generation
// changes this file only.
export const MODELS = {
  'claude-code': ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'],
  'opencode': ['anthropic/claude-sonnet-5-5', 'openai/gpt-5.5'],
} as const

export interface IModelRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

// Invented US dollars per million tokens of each model, for the cost a writer that declares `reported-cost` records.
export const MODEL_RATES: Readonly<Record<string, IModelRates>> = {
  'claude-opus-5-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'anthropic/claude-sonnet-5-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'openai/gpt-5.5': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
}

const SECOND_LABEL_MODEL = 'claude-sonnet-5-5'
const SECOND_LABEL_MODEL_FOR_SONNET = 'claude-haiku-4-5'

// The model that labels the second model's sample again: a different one from the labelling model.
export const secondLabelModel = (labelModel: string): string =>
  labelModel === SECOND_LABEL_MODEL ? SECOND_LABEL_MODEL_FOR_SONNET : SECOND_LABEL_MODEL
