// The model ids each writer records, spelled as that harness spells current public ones. A new model generation
// changes this file only.
export const MODELS = {
  'claude-code': ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'],
  'opencode': ['anthropic/claude-sonnet-5-5', 'openai/gpt-5.5'],
} as const

const SECOND_LABEL_MODEL = 'claude-sonnet-5-5'
const SECOND_LABEL_MODEL_FOR_SONNET = 'claude-haiku-4-5'

// The model that labels the second model's sample again: a different one from the labelling model.
export const secondLabelModel = (labelModel: string): string =>
  labelModel === SECOND_LABEL_MODEL ? SECOND_LABEL_MODEL_FOR_SONNET : SECOND_LABEL_MODEL
