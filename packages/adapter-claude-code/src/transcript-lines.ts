import { IMAGE_PART_TEXT } from '@log-book/adapter-api'
import type { IMessageRecord } from '@log-book/warehouse'

// The fields of a Claude Code transcript line the importer reads; every one may be missing or of another type.
export interface IContentBlock {
  type?: unknown
  text?: unknown
  thinking?: unknown
  id?: unknown
  name?: unknown
  input?: unknown
  tool_use_id?: unknown
  content?: unknown
  is_error?: unknown
  tool_name?: unknown
}

export interface IUsage {
  input_tokens?: unknown
  output_tokens?: unknown
  cache_read_input_tokens?: unknown
  cache_creation_input_tokens?: unknown
  output_tokens_details?: { thinking_tokens?: unknown }
}

export interface ITranscriptLine {
  type?: unknown
  subtype?: unknown
  uuid?: unknown
  timestamp?: unknown
  cwd?: unknown
  gitBranch?: unknown
  version?: unknown
  isMeta?: unknown
  isCompactSummary?: unknown
  isApiErrorMessage?: unknown
  origin?: { kind?: unknown }
  // `cli` for an interactive session, `sdk-cli` for `claude -p`.
  entrypoint?: unknown
  aiTitle?: unknown
  customTitle?: unknown
  content?: unknown
  attachment?: unknown
  compactMetadata?: unknown
  error?: unknown
  retryAttempt?: unknown
  sourceToolUseID?: unknown
  toolUseResult?: unknown
  message?: { id?: unknown; model?: unknown; content?: unknown; usage?: IUsage }
}

// One line of a transcript: its 1-based number, and the line as parsed, or null with the raw text when it did not
// parse to an object.
export interface ITranscriptEntry {
  number: number
  line: ITranscriptLine | null
  raw: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const stringOf = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const numberOf = (value: unknown): number | null => (typeof value === 'number' ? value : null)

export const blocksOf = (content: unknown): IContentBlock[] =>
  Array.isArray(content) ? content.filter((block): block is IContentBlock => isRecord(block)) : []

export const usageFields = (usage: IUsage | undefined): Partial<IMessageRecord> => ({
  tokensInput: numberOf(usage?.input_tokens),
  tokensOutput: numberOf(usage?.output_tokens),
  tokensReasoning: numberOf(usage?.output_tokens_details?.thinking_tokens),
  tokensCacheRead: numberOf(usage?.cache_read_input_tokens),
  tokensCacheWrite: numberOf(usage?.cache_creation_input_tokens),
})

const resultBlockText = (block: IContentBlock): string => {
  if (block.type === 'text') {
    return stringOf(block.text) ?? ''
  }
  if (block.type === 'tool_reference') {
    return `(tool reference: ${stringOf(block.tool_name) ?? ''})`
  }
  return block.type === 'image' ? IMAGE_PART_TEXT : ''
}

// A tool result's text: string content as it is; for blocks, their text, a deferred tool load's `tool_reference` as
// `(tool reference: <name>)` and an image as `(image)`, joined with newlines.
export const toolResultText = (content: unknown): string =>
  stringOf(content) ??
  blocksOf(content)
    .map((block) => resultBlockText(block))
    .filter((text) => text !== '')
    .join('\n')

// The line's time in epoch milliseconds, or null when it has none that parses.
export const timeOf = (line: ITranscriptLine): number | null => {
  const timestamp = stringOf(line.timestamp)
  if (timestamp === null) {
    return null
  }
  const time = Date.parse(timestamp)
  return Number.isNaN(time) ? null : time
}

const parseLine = (raw: string): { isParsed: boolean; value: unknown } => {
  try {
    return { isParsed: true, value: JSON.parse(raw) as unknown }
  } catch {
    return { isParsed: false, value: raw }
  }
}

// Every non-empty line in order. A last line with no trailing newline that fails to parse is being written: it is
// skipped, and the next sync reads it once the file's size changes. Any other line that does not parse to an object
// keeps its raw text, or the value it parsed to.
export const parseTranscript = (text: string): ITranscriptEntry[] => {
  const rows = text.split('\n')
  return rows.flatMap((raw, index) => {
    if (raw.trim() === '') {
      return []
    }
    const { isParsed, value } = parseLine(raw)
    if (!isParsed && index === rows.length - 1) {
      return []
    }
    return [{ number: index + 1, line: isRecord(value) ? value : null, raw: value }]
  })
}
