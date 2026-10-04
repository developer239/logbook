import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PromptLoaderService } from './prompt-loader.js'

describe('PromptLoaderService', () => {
  it('replaces a placeholder used twice and leaves one without a value as written', () => {
    // Arrange
    const template = 'Label {{record}} as {{task}}; then {{record}} again. Keep {{other}}.'

    // Act
    const built = PromptLoaderService.build(template, { record: 'call 1', task: 'purpose' })

    // Assert
    expect(built).toBe('Label call 1 as purpose; then call 1 again. Keep {{other}}.')
  })

  it('reads a prompt file as UTF-8 text', async () => {
    // Arrange
    const directory = await mkdtemp(join(tmpdir(), 'log-book-prompt-'))
    const path = join(directory, 'prompt.md')
    await writeFile(path, 'Classify {{record}} — ☕\n', 'utf8')

    // Act
    const loaded = PromptLoaderService.load(pathToFileURL(path))
    await rm(directory, { recursive: true, force: true })

    // Assert
    expect(loaded).toBe('Classify {{record}} — ☕\n')
  })
})
