import { describe, expect, it } from 'vitest'
import { descriptionIn, homepageIn } from './published-fields.js'

describe('homepageIn', () => {
  it('gives the one https:// address assigned to SITE_URL', () => {
    // Act
    const homepage = homepageIn(
      "// The site's address.\nexport const SITE_URL = 'https://example.com/logbook/'\n\nexport const BASE = '/'\n"
    )

    // Assert
    expect(homepage).toBe('https://example.com/logbook/')
  })

  it.each([
    [
      'two values',
      "export const SITE_URL = isDomain ? 'https://example.com/' : 'https://example.github.io/logbook/'\n",
      'https://example.com/, https://example.github.io/logbook/',
    ],
    ['two assignments', "export let SITE_URL = 'https://a.example/'\nSITE_URL = 'https://b.example/'\n", 'https://a'],
    ['an http:// value', "export const SITE_URL = 'http://example.com/'\n", 'http://example.com/'],
    ['no value', 'export const SITE_URL = process.env.SITE\n', 'none'],
    ['no SITE_URL', "export const SITE = 'https://example.com/'\n", 'none'],
  ])('stops on %s, naming the file', (_case, site, found) => {
    expect(() => homepageIn(site)).toThrow(
      `apps/docs/site.ts must assign SITE_URL exactly one https:// address; it holds ${found}`
    )
  })
})

describe('descriptionIn', () => {
  it('gives the first line when it is a sentence', () => {
    // Act
    const description = descriptionIn('Log Book shows where the time went.\n\n## Install\n')

    // Assert
    expect(description).toBe('Log Book shows where the time went.')
  })

  it.each([
    ['a heading', '# Log Book\n\nLog Book shows where the time went.\n', '"# Log Book"'],
    ['an empty line', '\nLog Book shows where the time went.\n', '""'],
  ])('stops on %s', (_case, readme, line) => {
    expect(() => descriptionIn(readme)).toThrow(
      `README.md must open with the one sentence that describes Log Book, not ${line}.`
    )
  })
})
