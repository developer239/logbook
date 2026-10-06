// What a capture file carries besides its picture: the metadata containers found in it, or why its structure could not
// be read to its end, in which case it cannot be shown to be clean.
export type Inspection = { found: string[] } | { problem: string }

// A file whose structure ends early or breaks its format.
class Unreadable extends Error {}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_REFUSED = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf'])
const JPEG_START = Buffer.from([0xff, 0xd8, 0xff])
const JPEG_REFUSED: Readonly<Record<number, string>> = { 0xe1: 'an APP1 segment', 0xfe: 'a COM segment' }
const JPEG_END = 0xd9
const JPEG_SCAN = 0xda
const WEBP_REFUSED = new Set(['EXIF', 'XMP '])
const GIF_EXTENSION = 0x21
const GIF_COMMENT = 0xfe
const GIF_IMAGE = 0x2c
const GIF_TRAILER = 0x3b
const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])
const EBML_SEGMENT = 0x18538067
const EBML_TAGS = 0x1254c367
// The ISO base media boxes a file of that family starts with, and the boxes that hold other boxes.
const BMFF_FIRST = new Set(['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip', 'pnot'])
const BMFF_CONTAINERS = new Set([
  'moov',
  'trak',
  'mdia',
  'minf',
  'stbl',
  'edts',
  'dinf',
  'mvex',
  'moof',
  'traf',
  'mfra',
])
const BMFF_REFUSED = new Set(['udta', 'meta'])
// Image formats of the same box family, which M5 does not read.
const BMFF_IMAGE_BRANDS = new Set(['avif', 'avis', 'heic', 'heix', 'mif1', 'msf1'])

const ascii = (bytes: Buffer, start: number, length: number): string => bytes.toString('latin1', start, start + length)

// The bytes from start to end, refusing a range that runs past the file.
const need = (bytes: Buffer, start: number, length: number, what: string): void => {
  if (length < 0 || start + length > bytes.length) {
    throw new Unreadable(`it ends inside ${what}`)
  }
}

const pngFound = (bytes: Buffer): string[] => {
  const found: string[] = []
  let at = PNG_SIGNATURE.length
  for (;;) {
    need(bytes, at, 8, 'a chunk header')
    const length = bytes.readUInt32BE(at)
    const type = ascii(bytes, at + 4, 4)
    need(bytes, at + 8, length + 4, `its ${type} chunk`)
    if (PNG_REFUSED.has(type)) {
      found.push(`a ${type} chunk`)
    }
    if (type === 'IEND') {
      return found
    }
    at += 12 + length
  }
}

// The end of a JPEG scan: the next marker that is neither a stuffed byte nor a restart marker.
const scanEnd = (bytes: Buffer, from: number): number => {
  for (let at = from; at + 1 < bytes.length; at += 1) {
    const next = bytes[at + 1] ?? 0
    if (bytes[at] === 0xff && next !== 0x00 && (next < 0xd0 || next > 0xd7)) {
      return at
    }
  }
  throw new Unreadable('it ends inside its scan data')
}

const isStandaloneJpegMarker = (marker: number): boolean => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)

const jpegFound = (bytes: Buffer): string[] => {
  const found: string[] = []
  let at = 2
  for (;;) {
    need(bytes, at, 2, 'a marker')
    if (bytes[at] !== 0xff) {
      throw new Unreadable('a segment does not start with a marker')
    }
    const marker = bytes[at + 1] ?? 0
    if (marker === JPEG_END) {
      return found
    }
    if (marker === 0xff || isStandaloneJpegMarker(marker)) {
      at += marker === 0xff ? 1 : 2
      continue
    }
    need(bytes, at + 2, 2, 'a segment length')
    const length = bytes.readUInt16BE(at + 2)
    need(bytes, at + 2, length, 'a segment')
    const refused = JPEG_REFUSED[marker]
    if (refused !== undefined) {
      found.push(refused)
    }
    at = marker === JPEG_SCAN ? scanEnd(bytes, at + 2 + length) : at + 2 + length
  }
}

const webpFound = (bytes: Buffer): string[] => {
  const found: string[] = []
  const end = 8 + bytes.readUInt32LE(4)
  need(bytes, 0, end, 'its RIFF container')
  for (let at = 12; at < end;) {
    need(bytes, at, 8, 'a chunk header')
    const type = ascii(bytes, at, 4)
    const length = bytes.readUInt32LE(at + 4)
    need(bytes, at + 8, length, `its ${type.trim()} chunk`)
    if (WEBP_REFUSED.has(type)) {
      found.push(`an ${type.trim()} chunk`)
    }
    at += 8 + length + (length % 2)
  }
  return found
}

// The position after a GIF block's data sub-blocks, which end with an empty one.
const afterSubBlocks = (bytes: Buffer, from: number): number => {
  let at = from
  for (;;) {
    need(bytes, at, 1, 'a data sub-block')
    const size = bytes[at] ?? 0
    if (size === 0) {
      return at + 1
    }
    at += 1 + size
  }
}

// A GIF colour table follows when the packed byte's top bit is set, with 2 to the power of its low three bits plus one
// colours of 3 bytes each.
const colorTableLength = (packed: number): number => (packed < 0x80 ? 0 : 3 * 2 ** ((packed % 8) + 1))

const gifFound = (bytes: Buffer): string[] => {
  const found: string[] = []
  need(bytes, 6, 7, 'its screen descriptor')
  let at = 13 + colorTableLength(bytes[10] ?? 0)
  for (;;) {
    need(bytes, at, 1, 'a block')
    const introducer = bytes[at]
    if (introducer === GIF_TRAILER) {
      return found
    }
    if (introducer === GIF_EXTENSION) {
      need(bytes, at + 1, 1, 'an extension label')
      if (bytes[at + 1] === GIF_COMMENT) {
        found.push('a comment extension')
      }
      at = afterSubBlocks(bytes, at + 2)
    } else if (introducer === GIF_IMAGE) {
      need(bytes, at + 1, 10, 'an image descriptor')
      at = afterSubBlocks(bytes, at + 11 + colorTableLength(bytes[at + 9] ?? 0))
    } else {
      throw new Unreadable('a block is neither an extension, an image nor the trailer')
    }
  }
}

// A box's type, header length and whole length; a size of 1 gives a 64-bit length after the type, and 0 runs to the
// end of the box holding it.
const boxAt = (bytes: Buffer, at: number, end: number): { type: string; header: number; length: number } => {
  need(bytes, at, 8, 'a box header')
  const size = bytes.readUInt32BE(at)
  const type = ascii(bytes, at + 4, 4)
  if (size === 0) {
    return { type, header: 8, length: end - at }
  }
  if (size !== 1) {
    return { type, header: 8, length: size }
  }
  need(bytes, at, 16, `its ${type} box header`)
  return { type, header: 16, length: Number(bytes.readBigUInt64BE(at + 8)) }
}

// Every refused box between start and end, looking into the boxes that hold others.
const boxesFound = (bytes: Buffer, start: number, end: number): string[] => {
  const found: string[] = []
  for (let at = start; at < end;) {
    const { type, header, length } = boxAt(bytes, at, end)
    if (length < header || at + length > end) {
      throw new Unreadable(`its ${type} box runs past its end`)
    }
    if (BMFF_REFUSED.has(type)) {
      found.push(`a ${type} box`)
    } else if (BMFF_CONTAINERS.has(type)) {
      found.push(...boxesFound(bytes, at + header, at + length))
    }
    at += length
  }
  return found
}

// An EBML variable-length integer at a position: its length in bytes and its value, with the length marker kept for
// an element id and cleared for a size. A size of all ones is unknown, returned as null.
const vint = (bytes: Buffer, at: number, isId: boolean): { length: number; value: number | null } => {
  need(bytes, at, 1, 'an element')
  const first = bytes[at] ?? 0
  const length = Math.clz32(first) - 23
  if (length < 1 || length > 8) {
    throw new Unreadable('an element has an invalid length')
  }
  need(bytes, at, length, 'an element')
  // A size drops its length marker, the first set bit, keeping the bits below it.
  const lowBits = 2 ** (8 - length)
  const marker = isId ? first : first % lowBits
  let value = marker
  let isAllOnes = marker === lowBits - 1
  for (let index = 1; index < length; index += 1) {
    const byte = bytes[at + index] ?? 0
    value = value * 256 + byte
    isAllOnes &&= byte === 0xff
  }
  return { length, value: !isId && isAllOnes ? null : value }
}

// Every Tags element among the elements between start and end, looking into the Segment.
const elementsFound = (bytes: Buffer, start: number, end: number): string[] => {
  const found: string[] = []
  for (let at = start; at < end;) {
    const id = vint(bytes, at, true)
    const size = vint(bytes, at + id.length, false)
    const dataStart = at + id.length + size.length
    if (size.value === null && id.value !== EBML_SEGMENT) {
      throw new Unreadable('an element other than the Segment has an unknown size')
    }
    const dataEnd = size.value === null ? end : dataStart + size.value
    need(bytes, dataStart, dataEnd - dataStart, 'an element')
    if (id.value === EBML_TAGS) {
      found.push('a Tags element')
    } else if (id.value === EBML_SEGMENT) {
      found.push(...elementsFound(bytes, dataStart, dataEnd))
    }
    at = dataEnd
  }
  return found
}

const startsWith = (bytes: Buffer, prefix: Buffer): boolean => bytes.subarray(0, prefix.length).equals(prefix)

const bmffFound = (bytes: Buffer): string[] => {
  if (ascii(bytes, 4, 4) === 'ftyp' && BMFF_IMAGE_BRANDS.has(ascii(bytes, 8, 4))) {
    throw new Unreadable('it is an AVIF or HEIF image, which M5 does not read')
  }
  return boxesFound(bytes, 0, bytes.length)
}

// Each format M5 reads: how its first bytes look, and what it carries.
const FORMATS: readonly { isIt: (bytes: Buffer) => boolean; found: (bytes: Buffer) => string[] }[] = [
  { isIt: (bytes) => startsWith(bytes, PNG_SIGNATURE), found: pngFound },
  { isIt: (bytes) => startsWith(bytes, JPEG_START), found: jpegFound },
  {
    isIt: (bytes) => bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP',
    found: webpFound,
  },
  { isIt: (bytes) => ['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6)), found: gifFound },
  { isIt: (bytes) => startsWith(bytes, EBML), found: (bytes) => elementsFound(bytes, 0, bytes.length) },
  { isIt: (bytes) => bytes.length >= 12 && BMFF_FIRST.has(ascii(bytes, 4, 4)), found: bmffFound },
]

// The format from the file's first bytes, and what it carries.
const foundIn = (bytes: Buffer): string[] => {
  const format = FORMATS.find(({ isIt }) => isIt(bytes))
  if (format === undefined) {
    throw new Unreadable('it is none of PNG, JPEG, WebP, GIF, MP4, MOV or WebM')
  }
  return format.found(bytes)
}

// The metadata containers a capture carries, each named once, or why it could not be read to its end.
export const inspectCapture = (bytes: Buffer): Inspection => {
  try {
    return { found: [...new Set(foundIn(bytes))] }
  } catch (error) {
    if (error instanceof Unreadable) {
      return { problem: error.message }
    }
    throw error
  }
}
