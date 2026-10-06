import { describe, expect, it } from 'vitest'
import { gif, jpeg, mp4, png, webm, webp } from '../testing/capture-bytes.js'
import { inspectCapture } from './metadata.js'

describe('inspectCapture', () => {
  it.each(['tEXt', 'zTXt', 'iTXt', 'eXIf'])('refuses a PNG with a %s chunk, naming it', (type) => {
    // Act
    const inspection = inspectCapture(png([type]))

    // Assert
    expect(inspection).toStrictEqual({ found: [`a ${type} chunk`] })
  })

  it('passes the same PNG without them', () => {
    // Act
    const inspection = inspectCapture(png())

    // Assert
    expect(inspection).toStrictEqual({ found: [] })
  })

  it('refuses a JPEG with an EXIF APP1 segment and one with a COM segment, and passes one with only APP0', () => {
    // Act
    const inspections = [inspectCapture(jpeg([0xe1])), inspectCapture(jpeg([0xfe])), inspectCapture(jpeg())]

    // Assert
    expect(inspections).toStrictEqual([{ found: ['an APP1 segment'] }, { found: ['a COM segment'] }, { found: [] }])
  })

  it('refuses a WebP with an EXIF chunk and one with an XMP chunk, and passes one without', () => {
    // Act
    const inspections = [inspectCapture(webp(['EXIF'])), inspectCapture(webp(['XMP '])), inspectCapture(webp())]

    // Assert
    expect(inspections).toStrictEqual([{ found: ['an EXIF chunk'] }, { found: ['an XMP chunk'] }, { found: [] }])
  })

  it('refuses a GIF with a comment extension and passes one without', () => {
    // Act
    const inspections = [inspectCapture(gif(true)), inspectCapture(gif())]

    // Assert
    expect(inspections).toStrictEqual([{ found: ['a comment extension'] }, { found: [] }])
  })

  it('refuses an MP4 with moov/udta, naming udta, and one with a meta box, and passes one with neither', () => {
    // Act
    const inspections = [inspectCapture(mp4(['udta'])), inspectCapture(mp4(['meta'])), inspectCapture(mp4())]

    // Assert
    expect(inspections).toStrictEqual([{ found: ['a udta box'] }, { found: ['a meta box'] }, { found: [] }])
  })

  it('refuses a WebM with a Tags element and passes one without', () => {
    // Act
    const inspections = [inspectCapture(webm(true)), inspectCapture(webm())]

    // Assert
    expect(inspections).toStrictEqual([{ found: ['a Tags element'] }, { found: [] }])
  })

  it('cannot clear a truncated PNG or an AVIF image', () => {
    // Act
    const inspections = [inspectCapture(png().subarray(0, 45)), inspectCapture(mp4([], 'avif'))]

    // Assert
    expect(inspections).toStrictEqual([
      { problem: 'it ends inside its IDAT chunk' },
      { problem: 'it is an AVIF or HEIF image, which M5 does not read' },
    ])
  })
})
