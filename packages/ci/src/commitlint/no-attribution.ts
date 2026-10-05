import type { Plugin, RuleOutcome } from '@commitlint/types'

const TRAILER = /^co-authored-by\s*:/imu
const GENERATED = /Generated with/u

// Commits carry no attribution: no Co-Authored-By trailer in any letter case, and no line saying what generated them.
// Agents write many commits, so the rule is checked on every one. The root commitlint config imports this source
// file itself, so the hook needs no build of this package.
const hasAttribution = (raw: string): boolean => TRAILER.test(raw) || GENERATED.test(raw)

export const noAttribution: Plugin = {
  rules: {
    'no-attribution': ({ raw }, when = 'always'): RuleOutcome => {
      const isClean = !hasAttribution(raw ?? '')
      return [
        when === 'never' ? !isClean : isClean,
        'a commit carries no attribution: remove the Co-Authored-By trailer and any line with "Generated with"',
      ]
    },
  },
}
