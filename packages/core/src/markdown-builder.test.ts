import { describe, expect, it } from 'vitest'
import { MarkdownBuilder } from './markdown-builder.js'

describe('MarkdownBuilder', () => {
  it('builds a heading, a field, bullets, a table and a code block', () => {
    // Arrange
    const builder = MarkdownBuilder.create()

    // Act
    const built = builder
      .heading('Sessions', 1)
      .field('Count', '2')
      .bullet('first')
      .bullet('nested', 1)
      .table(['Name', 'Turns'], [['alpha', '3']])
      .codeBlock('SELECT 1', 'sql')
      .build()

    // Assert
    expect(built).toBe(
      [
        '# Sessions',
        '',
        '**Count:** 2',
        '- first',
        '  - nested',
        '| Name | Turns |',
        '| --- | --- |',
        '| alpha | 3 |',
        '',
        '```sql',
        'SELECT 1',
        '```',
      ].join('\n')
    )
  })
})
