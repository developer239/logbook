import { globSync } from 'node:fs'
import { basename, matchesGlob } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import config from '../vitest.config.js'

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist'])

interface IProjectSelection {
  name: string
  include: string[]
  exclude: string[]
}

const readProjects = (): IProjectSelection[] =>
  (config.test?.projects ?? []).map((project) => {
    if (typeof project !== 'object' || !('test' in project)) {
      throw new Error('Every project is declared inline with a test section')
    }
    const { name, include = [], exclude = [] } = project.test
    if (typeof name !== 'string') {
      throw new Error('Every project has a string name')
    }
    return { name, include, exclude }
  })

const selectingProjects = (file: string, projects: IProjectSelection[]): string[] =>
  projects
    .filter(
      ({ include, exclude }) =>
        include.some((pattern) => matchesGlob(file, pattern)) && !exclude.some((pattern) => matchesGlob(file, pattern))
    )
    .map(({ name }) => name)

const listTestFiles = (): string[] =>
  globSync('{packages,apps,test}/**/*.test.ts', {
    cwd: REPOSITORY_ROOT,
    exclude: (path) => SKIPPED_DIRECTORIES.has(basename(path)),
  }).toSorted()

describe('vitest.config', () => {
  it('runs the workers in the America/St_Johns time zone', () => {
    // Arrange
    const expected = { intl: 'America/St_Johns', env: 'America/St_Johns' }

    // Act
    const actual = { intl: Intl.DateTimeFormat().resolvedOptions().timeZone, env: process.env.TZ }

    // Assert
    expect(actual).toStrictEqual(expected)
  })

  it('selects every test file with exactly one project', () => {
    // Arrange
    const projects = readProjects()

    // Act
    const unselected = listTestFiles()
      .map((file) => ({ file, projects: selectingProjects(file, projects) }))
      .filter((selection) => selection.projects.length !== 1)

    // Assert
    expect(unselected).toStrictEqual([])
  })

  it('selects end-to-end test files only with the e2e project', () => {
    // Arrange
    const projects = readProjects()

    // Act
    const misplaced = listTestFiles()
      .filter((file) => file.endsWith('.e2e.test.ts'))
      .map((file) => ({ file, projects: selectingProjects(file, projects) }))
      .filter((selection) => selection.projects.join() !== 'e2e')

    // Assert
    expect(misplaced).toStrictEqual([])
  })
})
