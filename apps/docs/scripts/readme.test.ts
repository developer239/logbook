import { describe, expect, it } from 'vitest'
import { firstLineOf, syncedReadme } from './readme.js'

const SITE_URL = 'https://developer239.github.io/logbook/'
const STATEMENT = 'Log Book runs on your computer. See [what it sends](/privacy/).\n'
const STALE = [
  'Log Book in one sentence.',
  '',
  '## What Log Book sends, and where',
  '',
  '<!-- statement:start -->',
  'An older statement.',
  '<!-- statement:end -->',
  '',
  '## License',
  '',
].join('\n')

describe('syncedReadme', () => {
  it('rewrites a stale block with absolute links, keeps every line outside the markers, and changes nothing a second time', () => {
    // Act
    const once = syncedReadme(STALE, STATEMENT, SITE_URL)
    const twice = syncedReadme(once, STATEMENT, SITE_URL)

    // Assert
    expect({ once: once.split('\n'), isStable: twice === once }).toStrictEqual({
      once: [
        'Log Book in one sentence.',
        '',
        '## What Log Book sends, and where',
        '',
        '<!-- statement:start -->',
        '',
        'Log Book runs on your computer. See [what it sends](https://developer239.github.io/logbook/privacy/).',
        '',
        '<!-- statement:end -->',
        '',
        '## License',
        '',
      ],
      isStable: true,
    })
  })

  it('refuses a README without its markers', () => {
    expect(() => syncedReadme('Log Book in one sentence.\n', STATEMENT, SITE_URL)).toThrow(
      'README.md needs <!-- statement:start --> and then <!-- statement:end --> around the statement'
    )
  })
})

describe('firstLineOf', () => {
  it.each([
    ['an empty first line', '\nLog Book in one sentence.\n'],
    ['a heading', '# Log Book\n'],
  ])('refuses %s', (_case, readme) => {
    expect(() => firstLineOf(readme)).toThrow('README.md must start with the one-sentence description')
  })
})
