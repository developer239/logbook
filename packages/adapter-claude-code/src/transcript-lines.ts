// The fields of a Claude Code transcript line the importer reads; every one may be missing or of another type.
export interface IContentBlock {
  type?: unknown
  text?: unknown
  thinking?: unknown
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
  message?: { id?: unknown; model?: unknown; content?: unknown; usage?: IUsage }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const stringOf = (value: unknown): string | null => (typeof value === 'string' ? value : null)

export const numberOf = (value: unknown): number | null => (typeof value === 'number' ? value : null)

export const blocksOf = (content: unknown): IContentBlock[] =>
  Array.isArray(content) ? content.filter((block): block is IContentBlock => isRecord(block)) : []

// The line's time in epoch milliseconds, or null when it has none that parses.
export const timeOf = (line: ITranscriptLine): number | null => {
  const timestamp = stringOf(line.timestamp)
  if (timestamp === null) {
    return null
  }
  const time = Date.parse(timestamp)
  return Number.isNaN(time) ? null : time
}

// Each line that parses to a JSON object; a line that does not is skipped. The usual one is a last line with no
// trailing newline that Claude Code is still writing, which the next sync reads once the file's size changes.
export const parseTranscript = (text: string): ITranscriptLine[] =>
  text.split('\n').flatMap((raw) => {
    if (raw.trim() === '') {
      return []
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      return isRecord(parsed) ? [parsed] : []
    } catch {
      return []
    }
  })
