export class MarkdownBuilder {
  private readonly lines: string[] = []

  public static readonly create = (): MarkdownBuilder => new MarkdownBuilder()

  public heading = (text: string, level: 1 | 2 | 3 | 4 = 2): this => {
    this.lines.push(`${'#'.repeat(level)} ${text}`)
    this.lines.push('')
    return this
  }

  public field = (label: string, value: string): this => {
    this.lines.push(`**${label}:** ${value}`)
    return this
  }

  public text = (content: string): this => {
    this.lines.push(content)
    return this
  }

  public blank = (): this => {
    this.lines.push('')
    return this
  }

  public separator = (): this => {
    this.lines.push('')
    this.lines.push('---')
    this.lines.push('')
    return this
  }

  public bullet = (text: string, indent = 0): this => {
    const prefix = '  '.repeat(indent)
    this.lines.push(`${prefix}- ${text}`)
    return this
  }

  public table = (headers: string[], rows: string[][]): this => {
    this.lines.push(`| ${headers.join(' | ')} |`)
    this.lines.push(`| ${headers.map(() => '---').join(' | ')} |`)
    for (const row of rows) {
      this.lines.push(`| ${row.join(' | ')} |`)
    }
    this.lines.push('')
    return this
  }

  public codeBlock = (content: string, language?: string): this => {
    this.lines.push(`\`\`\`${language ?? ''}`)
    this.lines.push(content)
    this.lines.push('```')
    return this
  }

  public italic = (text: string): this => {
    this.lines.push(`_${text}_`)
    return this
  }

  public build = (): string => this.lines.join('\n')
}
