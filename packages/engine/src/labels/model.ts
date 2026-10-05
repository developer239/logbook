// The cheapest current Claude model.
export const DEFAULT_LABEL_MODEL = 'claude-haiku-4-5'

// A letter or digit, then letters, digits, `.`, `_`, `-`, `:` or `@`, at most 128 characters. There is no list of
// models: aliases such as `haiku` pass unchanged.
const LABEL_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u

// The one rule for a model value everywhere: the CLI's --model, the web app's model field and the demo build.
export const isLabelModelId = (value: string): boolean => LABEL_MODEL_ID.test(value)
