// Every character of the source is escaped first, so the output carries no
// markup the source did not ask for in Markdown.

const escape = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

// Code spans are held out first, so nothing inside them is read as Markdown.
const inline = (text: string): string => {
  const spans: string[] = []

  const held = text.replaceAll('\uE000', '').replaceAll(/`([^`\n]+)`/gu, (_match, code: string) => {
    spans.push(`<code>${escape(code)}</code>`)
    return `\uE000${String(spans.length - 1)}\uE000`
  })

  return escape(held)
    .replaceAll(/\*\*(?=\S)(.+?)(?<=\S)\*\*/gu, '<b>$1</b>')
    .replaceAll(/\uE000(\d+)\uE000/gu, (_match, index: string) => spans[Number(index)] ?? '')
}

const FENCE = /^\s*(```|~~~)/u
const BULLET = /^\s*[-*+]\s+(.*)$/u
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/u
const HEADING = /^\s*#{1,6}\s+(.*)$/u

type Block =
  | { kind: 'code'; lines: string[] }
  | { kind: 'ul' | 'ol' | 'p'; lines: string[] }
  | { kind: 'h'; text: string }

const blocks = (source: string): Block[] => {
  const result: Block[] = []
  const lines = source.replaceAll('\r\n', '\n').split('\n')

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const fence = FENCE.exec(line)

    if (fence !== null) {
      const code: string[] = []

      for (
        index += 1;
        index < lines.length && !(lines[index] ?? '').trimStart().startsWith(fence[1] ?? '```');
        index += 1
      ) {
        code.push(lines[index] ?? '')
      }

      result.push({ kind: 'code', lines: code })
      continue
    }

    if (line.trim() === '') {
      result.push({ kind: 'p', lines: [] })
      continue
    }

    const heading = HEADING.exec(line)

    if (heading !== null) {
      result.push({ kind: 'h', text: heading[1] ?? '' })
      continue
    }

    const bullet = BULLET.exec(line)
    const numbered = NUMBERED.exec(line)
    const kind = bullet === null ? (numbered === null ? 'p' : 'ol') : 'ul'
    const text = bullet?.[1] ?? numbered?.[1] ?? line
    const last = result.at(-1)

    if (last?.kind === kind && (kind !== 'p' || last.lines.length > 0)) {
      last.lines.push(text)
    } else {
      result.push({ kind, lines: [text] })
    }
  }

  return result
}

export const markdown = (source: string): string =>
  blocks(source)
    .map((block) => {
      switch (block.kind) {
        case 'code':
          return `<pre><code>${escape(block.lines.join('\n'))}</code></pre>`
        case 'h':
          return `<p><b>${inline(block.text)}</b></p>`
        case 'ul':
        case 'ol':
          return `<${block.kind}>${block.lines.map((line) => `<li>${inline(line)}</li>`).join('')}</${block.kind}>`
        case 'p':
          return block.lines.length === 0 ? '' : `<p>${block.lines.map(inline).join('<br>')}</p>`
        default:
          return undefined
      }
    })
    .join('')
