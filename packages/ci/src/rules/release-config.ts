// semantic-release's configuration, exactly: main is the one release branch, on the channel next; the version is
// decided from the commits, the notes written and the GitHub release made, and nothing else. No npm plugin, since
// publishing is the publish job's, and no git or changelog plugin, since nothing is committed back.
export const RELEASE_CONFIG_FILE = '.releaserc.json'

export const RELEASE_CONFIG = {
  branches: [{ name: 'main', channel: 'next' }],
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    ['@semantic-release/github', { successComment: false, failComment: false, releasedLabels: false }],
  ],
}
