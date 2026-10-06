import type { ClosingKind } from './replies.js'

// The model ids each writer records, spelled as that harness spells current public ones. A new model generation
// changes this file only.
export const MODELS = {
  'claude-code': ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'],
  'opencode': ['anthropic/claude-sonnet-5-5', 'openai/gpt-5.5'],
} as const

// How often a model's turn of the rich set ends its own way where the turn would end plainly, in percent: one Claude Code
// model asks permission, one caves after pushback and another holds, and an OpenCode model pushes back most.
export interface IReplyHabit {
  closing: ClosingKind
  percent: number
}

export const REPLY_HABITS: Readonly<Record<string, IReplyHabit>> = {
  'claude-opus-5-5': { closing: 'permission', percent: 30 },
  'claude-sonnet-5-5': { closing: 'caves', percent: 30 },
  'claude-haiku-4-5': { closing: 'holds', percent: 25 },
  'anthropic/claude-sonnet-5-5': { closing: 'caves', percent: 15 },
  'openai/gpt-5.5': { closing: 'pushback', percent: 35 },
}

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
