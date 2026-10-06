import { describe, expect, it } from 'vitest'
import {
  attributesIn,
  committedOf,
  type ISiteCaptures,
  siteCommittedOf,
  siteShotOf,
  siteShotsOf,
  siteVideoOf,
  siteVideosOf,
} from './captures.js'

const SHOTS = [{ id: 'dashboard', alt: 'The dashboard', viewport: [1440, 900] as const }]
const TOUR = { file: 'tour.mp4', video: 'tour', scheme: 'dark', viewport: [1280, 800], poster: 'dashboard-dark.png' }
const MANIFEST = {
  captures: [
    { file: 'dashboard-dark.png', shot: 'dashboard', scheme: 'dark' },
    { file: 'dashboard-light.png', shot: 'dashboard', scheme: 'light' },
    TOUR,
  ],
}

const capturesOf = (manifest: unknown, committed: readonly string[] = []): ISiteCaptures => ({
  shots: siteShotsOf(manifest, SHOTS),
  ...siteVideosOf(manifest),
  committed,
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

describe('committedOf and siteCommittedOf', () => {
  it('gives the committed captures under committed/ by their path there', () => {
    // Arrange
    const manifest = {
      captures: [
        { file: 'apps/docs/src/public/committed/dashboard-90-days.png' },
        { file: 'apps/docs/src/public/elsewhere.png' },
      ],
    }

    // Act
    const committed = committedOf(manifest)

    // Assert
    expect(committed).toStrictEqual(['dashboard-90-days.png'])
  })

  it('throws on a committed capture the manifest does not list, naming the file and the page', () => {
    expect(() => siteCommittedOf(capturesOf(MANIFEST, ['dashboard-90-days.png']), 'example.png', 'index.md')).toThrow(
      'index.md shows the committed capture example.png, which apps/docs/committed-captures.json does not list'
    )
  })
})

describe('attributesIn', () => {
  it('finds an attribute of every Shot or Video of a page', () => {
    // Arrange
    const html =
      '<Shot id="dashboard" />\n<p>text</p><Video id="tour" /><Shot caption="Example" id="tokens"/>' +
      '<Shot committed="example.png" alt="Example" />'

    // Act
    const found = {
      shots: attributesIn(html, 'Shot', 'id'),
      committed: attributesIn(html, 'Shot', 'committed'),
      videos: attributesIn(html, 'Video', 'id'),
    }

    // Assert
    expect(found).toStrictEqual({ shots: ['dashboard', 'tokens'], committed: ['example.png'], videos: ['tour'] })
  })
})
