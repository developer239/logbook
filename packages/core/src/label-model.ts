// A letter or digit, then letters, digits, `.`, `_`, `-`, `:` or `@`, at most 128 characters. There is no list of
// models: aliases such as `haiku` pass unchanged.
const LABEL_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u

// What a model value must be, as the CLI and the web app tell a user who gave another.
export const LABEL_MODEL_RULE =
  'must start with a letter or digit and hold only letters, digits, . _ - : or @ (at most 128 characters)'

// The one rule for a model value everywhere: the CLI's --model, the web app's model field and the demo build.
export const isLabelModelId = (value: string): boolean => LABEL_MODEL_ID.test(value)
