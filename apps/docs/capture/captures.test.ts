import { describe, expect, it } from 'vitest'
import { shotIdsIn, siteShotOf, siteShotsOf } from './captures.js'

const SHOTS = [{ id: 'dashboard', alt: 'The dashboard', viewport: [1440, 900] as const }]
const MANIFEST = {
  captures: [
    { file: 'dashboard-dark.png', shot: 'dashboard', scheme: 'dark' },
    { file: 'dashboard-light.png', shot: 'dashboard', scheme: 'light' },
  ],
}

describe('siteShotsOf and siteShotOf', () => {
  it('gives a shot of the manifest its alt text, its size and both captures', () => {
    // Act
    const shot = siteShotOf(siteShotsOf(MANIFEST, SHOTS), 'dashboard', 'index.md')

    // Assert
    expect(shot).toStrictEqual({
      alt: 'The dashboard',
      width: 1440,
      height: 900,
      dark: 'dashboard-dark.png',
      light: 'dashboard-light.png',
    })
  })

  it('throws on a shot id the manifest does not have, naming it and the page', () => {
    expect(() => siteShotOf(siteShotsOf(MANIFEST, SHOTS), 'nope', 'index.md')).toThrow(
      'index.md shows the shot nope, which the captures do not have; run pnpm docs:capture'
    )
  })

  it('refuses a manifest capture of a shot the shot list does not have', () => {
    const manifest = { captures: [{ file: 'old-dark.png', shot: 'old', scheme: 'dark' }] }

    expect(() => siteShotsOf(manifest, SHOTS)).toThrow(
      'The capture manifest has the shot old, which the shot list does not have'
    )
  })
})

describe('shotIdsIn', () => {
  it('finds the id of every Shot of a page', () => {
    expect(shotIdsIn('<Shot id="dashboard" />\n<p>text</p><Shot caption="Example" id="tokens"/>')).toStrictEqual([
      'dashboard',
      'tokens',
    ])
  })
})
