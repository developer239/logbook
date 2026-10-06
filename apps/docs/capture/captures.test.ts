import { describe, expect, it } from 'vitest'
import { idsIn, type ISiteCaptures, siteShotOf, siteShotsOf, siteVideoOf, siteVideosOf } from './captures.js'

const SHOTS = [{ id: 'dashboard', alt: 'The dashboard', viewport: [1440, 900] as const }]
const TOUR = { file: 'tour.mp4', video: 'tour', scheme: 'dark', viewport: [1280, 800], poster: 'dashboard-dark.png' }
const MANIFEST = {
  captures: [
    { file: 'dashboard-dark.png', shot: 'dashboard', scheme: 'dark' },
    { file: 'dashboard-light.png', shot: 'dashboard', scheme: 'light' },
    TOUR,
  ],
}

const capturesOf = (manifest: unknown): ISiteCaptures => ({
  shots: siteShotsOf(manifest, SHOTS),
  ...siteVideosOf(manifest),
})

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

describe('siteVideosOf and siteVideoOf', () => {
  it('gives a video of the manifest its file, its size and its poster', () => {
    // Act
    const video = siteVideoOf(capturesOf(MANIFEST), 'tour', 'index.md')

    // Assert
    expect(video).toStrictEqual({ file: 'tour.mp4', width: 1280, height: 800, poster: 'dashboard-dark.png' })
  })

  it('throws on a poster the manifest does not have, naming it, the video and the page', () => {
    const manifest = { captures: [{ ...TOUR, poster: 'nope-dark.png' }] }

    expect(() => siteVideoOf(capturesOf(manifest), 'tour', 'index.md')).toThrow(
      'index.md shows the video tour, whose poster nope-dark.png the captures do not have'
    )
  })
})

describe('idsIn', () => {
  it('finds the id of every Shot or Video of a page', () => {
    // Arrange
    const html = '<Shot id="dashboard" />\n<p>text</p><Video id="tour" /><Shot caption="Example" id="tokens"/>'

    // Act
    const ids = { shots: idsIn(html, 'Shot'), videos: idsIn(html, 'Video') }

    // Assert
    expect(ids).toStrictEqual({ shots: ['dashboard', 'tokens'], videos: ['tour'] })
  })
})
