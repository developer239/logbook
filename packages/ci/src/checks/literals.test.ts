import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KNOWN_TOOL_NAMES, KNOWN_TOOLS_FILE, OWNER_LITERALS } from '../rules/owner-literals.js'
import { gitWorkspaces } from '../testing/git-workspace.js'
import { harnessFindings, ownerFindings } from './literals.js'

// The adapters every harness test workspace holds, which make claude-code and opencode harness ids.
const ADAPTERS = {
  'packages/adapter-api/src/index.ts': 'export {}\n',
  'packages/adapter-claude-code/src/index.ts': 'export {}\n',
  'packages/adapter-opencode/src/index.ts': 'export {}\n',
}
const HARNESS_LINE = "const id = 'claude-code'\n"
// Built from the list at run time, as this file is scanned too and may not spell an owner literal.
const literalAt = (index: number): string => {
  const literal = OWNER_LITERALS[index]
  if (literal === undefined) {
    throw new Error(`No owner literal ${String(index)}`)
  }
  return literal
}
const workspaces = gitWorkspaces()
// The owner pass reads the artwork list and the committed capture manifest, which every repository holds.
const ownerWorkspace = async (files: Readonly<Record<string, string>>): Promise<string> =>
  workspaces.create({
    'apps/docs/artwork.json': '{ "files": [] }\n',
    'apps/docs/committed-captures.json': '{ "captures": [] }\n',
    ...files,
  })

afterEach(async () => {
  await workspaces.removeAll()
})

describe('the harness-id literal check', () => {
  it('fails a harness id as a whole quoted string outside an adapter, naming the file and line', async () => {
    // Arrange
    const root = await workspaces.create({ ...ADAPTERS, 'apps/web/src/lib/example.ts': `// Example\n${HARNESS_LINE}` })

    // Act
    const found = await harnessFindings(root)

    // Assert
    expect(found).toStrictEqual([
      "apps/web/src/lib/example.ts:2: 'claude-code' is a harness id outside an adapter [harness-id]",
    ])
  })

  it('passes the id in an adapter, a test, the demo, Markdown, a comment and a longer string', async () => {
    // Arrange
    const root = await workspaces.create({
      ...ADAPTERS,
      'packages/adapter-opencode/src/example.ts': HARNESS_LINE,
      'apps/web/src/lib/example.test.ts': HARNESS_LINE,
      'apps/web/test/example.ts': HARNESS_LINE,
      'packages/demo/src/example.ts': HARNESS_LINE,
      'apps/docs/src/example.md': HARNESS_LINE,
      'apps/web/src/lib/comment.ts': '// claude-code\n',
      'apps/web/src/lib/longer.ts': "const key = 'harness:opencode'\n",
    })

    // Act
    const found = await harnessFindings(root)

    // Assert
    expect(found).toStrictEqual([])
  })

  it('takes a new adapter directory as a harness id, in any quotes', async () => {
    // Arrange
    const root = await workspaces.create({
      ...ADAPTERS,
      'packages/adapter-codex/src/index.ts': 'export {}\n',
      'apps/cli/src/example.ts': 'const ids = ["codex", `codex`]\n',
    })

    // Act
    const found = await harnessFindings(root)

    // Assert
    expect(found).toStrictEqual(["apps/cli/src/example.ts:1: 'codex' is a harness id outside an adapter [harness-id]"])
  })
})

describe('the owner-literal check', () => {
  it.each(OWNER_LITERALS.map((literal, index) => [index, literal]))(
    'fails owner literal %i in a tracked Markdown file, also in capitals',
    async (index) => {
      // Arrange
      const literal = literalAt(index)
      const root = await ownerWorkspace({ 'notes.md': `Ported from ${literal}.\nAnd ${literal.toUpperCase()}.\n` })

      // Act
      const found = await ownerFindings(root)

      // Assert
      // Every owner literal the planted one holds is named, such as one literal inside a longer one.
      const named = OWNER_LITERALS.filter((other) => literal.toLowerCase().includes(other.toLowerCase()))
      expect(found).toStrictEqual(
        [1, 2].flatMap((line) =>
          named.map((other) => `notes.md:${String(line)}: ${other} is an owner-specific literal [owner-literal]`)
        )
      )
    }
  )

  it('passes every owner literal in the owner-literals file itself', async () => {
    // Arrange
    const root = await ownerWorkspace({
      'packages/ci/src/rules/owner-literals.ts': OWNER_LITERALS.map((literal) => `'${literal}'`).join('\n'),
    })

    // Act
    const found = await ownerFindings(root)

    // Assert
    expect(found).toStrictEqual([])
  })

  it('passes the four tool names in the known-tool table and fails any other owner literal there', async () => {
    // Arrange
    const root = await ownerWorkspace({
      [KNOWN_TOOLS_FILE]: `${KNOWN_TOOL_NAMES.map((name) => `  ['${name}', 'dispatch'],`).join('\n')}\n// ${literalAt(0)}\n`,
    })

    // Act
    const found = await ownerFindings(root)

    // Assert
    expect(found).toStrictEqual([`${KNOWN_TOOLS_FILE}:5: ${literalAt(0)} is an owner-specific literal [owner-literal]`])
  })

  it('names the literal and none of the rest of the line', async () => {
    // Arrange
    const root = await ownerWorkspace({ 'apps/web/src/secret.ts': `const token = 'abc123-${literalAt(4)}xyz'\n` })

    // Act
    const [finding] = await ownerFindings(root)

    // Assert
    expect({
      finding,
      holdsRest: ['abc123', 'xyz', 'token'].some((part) => finding?.includes(part) === true),
    }).toStrictEqual({
      finding: `apps/web/src/secret.ts:1: ${literalAt(4)} is an owner-specific literal [owner-literal]`,
      holdsRest: false,
    })
  })

  it('fails a tracked demo build output and a tracked SQLite database, and passes the same database untracked', async () => {
    // Arrange
    const database = 'SQLite format 3\u0000\u0010\u0000rows'
    const root = await ownerWorkspace({
      'packages/demo/out/small/manifest.json': '{}\n',
      'example.db': database,
    })
    await writeFile(join(root, 'untracked.db'), database)

    // Act
    const found = await ownerFindings(root)

    // Assert
    expect(found).toStrictEqual([
      'example.db: a SQLite database is tracked [sqlite]',
      "packages/demo/out/small/manifest.json: a demo build's output is tracked [demo-out]",
    ])
  })
})
