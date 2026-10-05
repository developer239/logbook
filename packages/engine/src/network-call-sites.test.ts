import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import sites from '../network-call-sites.json' with { type: 'json' }

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

describe('network-call-sites.json', () => {
  it('names files that exist in the repository', () => {
    // Act
    const missing = sites.filter((site) => !existsSync(`${REPOSITORY_ROOT}${site.file}`)).map((site) => site.file)

    // Assert
    expect(missing).toStrictEqual([])
  })

  it('gives every entry the case labelling or local', () => {
    // Act
    const others = sites.filter((site) => site.case !== 'labelling' && site.case !== 'local')

    // Assert
    expect(others).toStrictEqual([])
  })

  it("has one labelling entry, the Claude client's file", () => {
    // Act
    const labelling = sites.filter((site) => site.case === 'labelling').map((site) => site.file)

    // Assert
    expect(labelling).toStrictEqual(['packages/engine/src/claude/claude-process.ts'])
  })
})
