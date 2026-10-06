import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ARTWORK_FILE, COMMITTED_CAPTURES_FILE, COVERED_CATEGORIES, OWNER_LOGIN } from '../rules/capture-rules.js'
import { png } from '../testing/capture-bytes.js'
import { gitWorkspaces } from '../testing/git-workspace.js'
import { trackedFiles } from '../tracked-files.js'
import { captureFindings } from './captures.js'

const COMMITTED = 'apps/docs/src/public/committed'
const OWNER_PNG = `${COMMITTED}/dashboard-90-days.png`
const DEMO_PNG = `${COMMITTED}/conversation-dark.png`
const DEMO_TEXT = `${COMMITTED}/conversation-dark.txt`
const PNG_BYTES = png()
const TEXT = 'Turn 01\n'
const workspaces = gitWorkspaces()

const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')

const ownerEntry = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  file: OWNER_PNG,
  sha256: sha256(PNG_BYTES),
  source: 'owner',
  screen: 'dashboard',
  covered: [...COVERED_CATEGORIES],
  approval: { by: OWNER_LOGIN, on: '2026-10-12', pullRequest: 41 },
  ...fields,
})

const demoEntry = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  file: DEMO_PNG,
  sha256: sha256(PNG_BYTES),
  source: 'demo',
  build: { size: 'rich', seed: 1, labels: 'all', model: 'claude-haiku-4-5', anchor: '2026-10-04T15:00:00Z' },
  page: '/conversations/claude-code:de30da7a-0000-4000-8000-000000000001',
  text: DEMO_TEXT,
  textSha256: sha256(TEXT),
  ...fields,
})

// A repository holding these files, the artwork list and the manifest with these entries, all tracked; the findings
// of its tracked files.
const findingsFor = async (
  files: Readonly<Record<string, string | Buffer>>,
  entries: readonly unknown[],
  artwork: readonly string[] = []
): Promise<string[]> => {
  const root = await workspaces.create({
    [ARTWORK_FILE]: JSON.stringify({ files: artwork }),
    [COMMITTED_CAPTURES_FILE]: JSON.stringify({ captures: entries }),
    ...files,
  })
  return captureFindings(root, await trackedFiles(root, ['.']))
}

afterEach(async () => {
  await workspaces.removeAll()
})

describe('M1, every committed image or video on record', () => {
  it('fails a tracked PNG with no entry, and passes it listed as artwork', async () => {
    // Act
    const [unlisted, artwork] = [
      await findingsFor({ [OWNER_PNG]: PNG_BYTES }, []),
      await findingsFor({ [OWNER_PNG]: PNG_BYTES }, [], [OWNER_PNG]),
    ]

    // Assert
    expect({ unlisted, artwork }).toStrictEqual({
      unlisted: [`${OWNER_PNG}: M1 is neither artwork in ${ARTWORK_FILE} nor an entry of ${COMMITTED_CAPTURES_FILE}`],
      artwork: [],
    })
  })

  it('fails an entry whose SHA-256 differs from the bytes', async () => {
    // Act
    const found = await findingsFor({ [OWNER_PNG]: PNG_BYTES }, [ownerEntry({ sha256: sha256(png(['IDAT'])) })])

    // Assert
    expect(found).toStrictEqual([`${OWNER_PNG}: M1 sha256 does not match its bytes`])
  })

  it('fails an entry whose file is not tracked', async () => {
    // Act
    const found = await findingsFor({}, [ownerEntry()])

    // Assert
    expect(found).toStrictEqual([`${OWNER_PNG}: M1 file is not tracked`])
  })

  it('fails two entries for one file', async () => {
    // Act
    const found = await findingsFor({ [OWNER_PNG]: PNG_BYTES }, [ownerEntry(), ownerEntry()])

    // Assert
    expect(found).toStrictEqual([`${OWNER_PNG}: M1 has 2 entries`])
  })

  it('counts a file whose extension is in capitals', async () => {
    // Act
    const found = await findingsFor({ 'EXAMPLE.PNG': PNG_BYTES }, [])

    // Assert
    expect(found).toStrictEqual([
      `EXAMPLE.PNG: M1 is neither artwork in ${ARTWORK_FILE} nor an entry of ${COMMITTED_CAPTURES_FILE}`,
    ])
  })
})

describe('M2 to M4, each entry as its source asks', () => {
  it('passes a valid owner entry and a valid demo entry', async () => {
    // Act
    const found = await findingsFor({ [OWNER_PNG]: PNG_BYTES, [DEMO_PNG]: PNG_BYTES, [DEMO_TEXT]: TEXT }, [
      ownerEntry(),
      demoEntry(),
    ])

    // Assert
    expect(found).toStrictEqual([])
  })

  it('fails an owner entry without approval with M2', async () => {
    // Arrange
    const { approval: _approval, ...withoutApproval } = ownerEntry()

    // Act
    const found = await findingsFor({ [OWNER_PNG]: PNG_BYTES }, [withoutApproval])

    // Assert
    expect(found).toStrictEqual([`${OWNER_PNG}: M2 lacks approval`])
  })

  it('fails an owner entry missing the machine category with M4, naming covered', async () => {
    // Act
    const found = await findingsFor({ [OWNER_PNG]: PNG_BYTES }, [
      ownerEntry({ covered: COVERED_CATEGORIES.filter((category) => category !== 'machine') }),
    ])

    // Assert
    expect(found).toStrictEqual([
      `${OWNER_PNG}: M4 covered does not hold every category in order (${COVERED_CATEGORIES.join(', ')})`,
    ])
  })

  it('fails an owner entry approved by another login with M4', async () => {
    // Act
    const found = await findingsFor({ [OWNER_PNG]: PNG_BYTES }, [
      ownerEntry({ approval: { by: 'someone-else', on: '2026-10-12', pullRequest: 41 } }),
    ])

    // Assert
    expect(found).toStrictEqual([`${OWNER_PNG}: M4 approval.by is not ${OWNER_LOGIN}`])
  })

  it('fails an owner entry with a text capture tracked beside it with M4', async () => {
    // Act
    const found = await findingsFor({ [OWNER_PNG]: PNG_BYTES, [`${COMMITTED}/dashboard-90-days.txt`]: TEXT }, [
      ownerEntry(),
    ])

    // Assert
    expect(found).toStrictEqual([
      `${OWNER_PNG}: M4 a text capture ${COMMITTED}/dashboard-90-days.txt is tracked beside it`,
    ])
  })

  it('fails a demo entry built without labels that names a model with M2', async () => {
    // Act
    const found = await findingsFor({ [DEMO_PNG]: PNG_BYTES, [DEMO_TEXT]: TEXT }, [
      demoEntry({
        build: { size: 'small', seed: 1, labels: 'none', model: 'claude-haiku-4-5', anchor: '2026-10-04T15:00:00Z' },
      }),
    ])

    // Assert
    expect(found).toStrictEqual([`${DEMO_PNG}: M2 has an extra field build.model`])
  })

  it("fails a demo entry whose text capture's SHA-256 differs with M3", async () => {
    // Act
    const found = await findingsFor({ [DEMO_PNG]: PNG_BYTES, [DEMO_TEXT]: 'Turn 02\n' }, [demoEntry()])

    // Assert
    expect(found).toStrictEqual([`${DEMO_PNG}: M3 textSha256 does not match the text capture`])
  })
})

describe('M5, no metadata in a capture', () => {
  it('fails a capture of either source that carries a text chunk, naming the file, M5 and the chunk', async () => {
    // Arrange
    const withText = png(['tEXt'])

    // Act
    const found = await findingsFor({ [OWNER_PNG]: withText, [DEMO_PNG]: withText, [DEMO_TEXT]: TEXT }, [
      ownerEntry({ sha256: sha256(withText) }),
      demoEntry({ sha256: sha256(withText) }),
    ])

    // Assert
    expect(found).toStrictEqual([`${OWNER_PNG}: M5 carries a tEXt chunk`, `${DEMO_PNG}: M5 carries a tEXt chunk`])
  })

  it('fails a capture it cannot read to its end, naming the file', async () => {
    // Arrange
    const truncated = PNG_BYTES.subarray(0, 45)

    // Act
    const found = await findingsFor({ [OWNER_PNG]: truncated }, [ownerEntry({ sha256: sha256(truncated) })])

    // Assert
    expect(found).toStrictEqual([
      `${OWNER_PNG}: M5 cannot be shown to carry no metadata: it ends inside its IDAT chunk`,
    ])
  })
})

describe('the two lists', () => {
  it('fails a repository without the committed capture manifest, naming it', async () => {
    // Arrange
    const root = await workspaces.create({ [ARTWORK_FILE]: JSON.stringify({ files: [] }) })

    // Act
    const found = await captureFindings(root, await trackedFiles(root, ['.']))

    // Assert
    expect(found).toStrictEqual([`${COMMITTED_CAPTURES_FILE}: missing; it holds { "captures": [...] }`])
  })
})
