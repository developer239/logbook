import { noAttribution } from './packages/ci/src/commitlint/no-attribution.ts'

// Conventional Commits, because semantic-release decides every version from the commit titles on main, and no
// attribution trailer. The hook checks each commit; the checks job checks every pull request again and is the
// authority.
export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [noAttribution],
  rules: {
    'body-leading-blank': [2, 'always'],
    'no-attribution': [2, 'always'],
  },
}
