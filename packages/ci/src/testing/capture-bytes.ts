// Capture files for the checks' tests, built byte by byte: the smallest file of each format, with extra metadata
// containers where a test plants them.

const bytesOf = (text: string): Buffer => Buffer.from(text, 'latin1')

const u32be = (value: number): Buffer => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32BE(value)
  return bytes
}

const u32le = (value: number): Buffer => {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32LE(value)
  return bytes
}

const u16be = (value: number): Buffer => {
  const bytes = Buffer.alloc(2)
  bytes.writeUInt16BE(value)
  return bytes
}

// A PNG chunk; the check reads no checksum, so it is zero.
const pngChunk = (type: string, data: Buffer = Buffer.alloc(0)): Buffer =>
  Buffer.concat([u32be(data.length), bytesOf(type), data, Buffer.alloc(4)])

// A 1 by 1 grey PNG with these chunks before its image data.
export const png = (extra: readonly string[] = []): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0])),
    ...extra.map((type) => pngChunk(type, bytesOf('example'))),
    pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])),
    pngChunk('IEND'),
  ])

const jpegSegment = (marker: number, data: Buffer): Buffer =>
  Buffer.concat([Buffer.from([0xff, marker]), u16be(data.length + 2), data])

// A JPEG with its APP0 (JFIF) segment, these segments, and a scan holding a stuffed byte and a restart marker.
export const jpeg = (extra: readonly number[] = []): Buffer =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe0, bytesOf('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')),
    ...extra.map((marker) => jpegSegment(marker, bytesOf(marker === 0xe1 ? 'Exif\0\0example' : 'example'))),
    jpegSegment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])),
    Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]),
    Buffer.from([0xff, 0xd9]),
  ])

const webpChunk = (type: string, data: Buffer): Buffer =>
  Buffer.concat([bytesOf(type), u32le(data.length), data, Buffer.alloc(data.length % 2)])

// A WebP with an image chunk and these chunks.
export const webp = (extra: readonly string[] = []): Buffer => {
  const body = Buffer.concat([
    bytesOf('WEBP'),
    webpChunk('VP8L', bytesOf('/\0\0\0\0')),
    ...extra.map((type) => webpChunk(type, bytesOf('example'))),
  ])
  return Buffer.concat([bytesOf('RIFF'), u32le(body.length), body])
}

// A 1 by 1 GIF, with a comment extension when asked.
export const gif = (hasComment = false): Buffer =>
  Buffer.concat([
    bytesOf('GIF89a'),
    Buffer.from([1, 0, 1, 0, 0x80, 0, 0]),
    Buffer.from([0, 0, 0, 0xff, 0xff, 0xff]),
    ...(hasComment ? [Buffer.from([0x21, 0xfe, 3]), bytesOf('abc'), Buffer.from([0])] : []),
    Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([2, 2, 0x4c, 0x01, 0]),
    Buffer.from([0x3b]),
  ])

const box = (type: string, ...children: Buffer[]): Buffer => {
  const body = Buffer.concat(children)
  return Buffer.concat([u32be(body.length + 8), bytesOf(type), body])
}

// An MP4 whose movie box holds these boxes beside its track; a brand of avif makes it an AVIF image.
export const mp4 = (inMovie: readonly string[] = [], brand = 'isom'): Buffer =>
  Buffer.concat([
    box('ftyp', bytesOf(brand), u32be(0), bytesOf('isommp41')),
    box(
      'moov',
      box('mvhd', Buffer.alloc(8)),
      box('trak', box('tkhd', Buffer.alloc(8))),
      ...inMovie.map((type) => box(type, Buffer.alloc(4)))
    ),
    box('mdat', bytesOf('frames')),
  ])

// An EBML element whose id is given in its bytes, with a one-byte size, under 127 bytes.
const element = (id: readonly number[], data: Buffer): Buffer =>
  Buffer.concat([Buffer.from(id), Buffer.from([0x80 + data.length]), data])

// A WebM with its EBML header and a Segment holding Info, and Tags when asked.
export const webm = (hasTags = false): Buffer =>
  Buffer.concat([
    element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], bytesOf('webm'))),
    element(
      [0x18, 0x53, 0x80, 0x67],
      Buffer.concat([
        element([0x15, 0x49, 0xa9, 0x66], element([0x2a, 0xd7, 0xb1], Buffer.from([0x0f, 0x42, 0x40]))),
        ...(hasTags ? [element([0x12, 0x54, 0xc3, 0x67], element([0x73, 0x73], Buffer.alloc(0)))] : []),
      ])
    ),
  ])
