import type { LabelTaskName } from './tasks.js'

export interface ILabelInputRate {
  // Input tokens per record, Claude Code's framing and the prompt cache included.
  tokensPerRecord: number
  // The model and the Claude Code version the rate was measured with.
  measuredWith: { model: string; claudeCode: string }
}

// The per-record input rates the estimate multiplies, measured on one developer's warehouse of about 1,000 sessions
// and rounded. The four Sonnet rows have no Haiku measurement: a token count depends on the model's tokenizer.
export const LABEL_INPUT_RATES: Readonly<Record<LabelTaskName, ILabelInputRate>> = {
  'shell': { tokensPerRecord: 200, measuredWith: { model: 'claude-haiku-4-5', claudeCode: '2.1.286' } },
  'tool-failure': { tokensPerRecord: 330, measuredWith: { model: 'claude-haiku-4-5', claudeCode: '2.1.286' } },
  'session': { tokensPerRecord: 530, measuredWith: { model: 'claude-sonnet-5-5', claudeCode: '2.1.286' } },
  'outcome': { tokensPerRecord: 510, measuredWith: { model: 'claude-sonnet-5-5', claudeCode: '2.1.286' } },
  'prompt': { tokensPerRecord: 1800, measuredWith: { model: 'claude-sonnet-5-5', claudeCode: '2.1.286' } },
  'reply': { tokensPerRecord: 1700, measuredWith: { model: 'claude-sonnet-5-5', claudeCode: '2.1.286' } },
}
