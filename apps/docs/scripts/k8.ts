import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { codeLines, pagesOf, type IFinding } from './k7.js'

export interface IK8Inputs {
  // The documentation package's directory, which holds src.
  docs: string
  // The built site's captures, with the run's manifest.
  captures: string
  // Findings name files relative to it.
  repository: string
}

type Scheme = 'dark' | 'light'

// A text capture of the run: the web app's path it was taken on, without range or filter parameters, and its text
// with every run of whitespace collapsed.
interface IPageText {
  path: string
  scheme: Scheme
  text: string
}

interface IQuote {
  line: number
  page: string
  label: string
}

const RULE = 'K8'
const SCHEMES: readonly Scheme[] = ['dark', 'light']
// A quoted UI label, such as <Ui page="/">Reactions from the agent</Ui>, which may span lines.
const UI_TAG = /<Ui\b[^>]*?\bpage="(?<page>[^"]*)"[^>]*>(?<label>[\s\S]*?)<\/Ui>/gu
// The page of one conversation, which the captures show as the showcase conversation's.
const CONVERSATION = '/conversations/:id'
const CONVERSATION_PATH = /^\/conversations\/[^/]+$/u
const WHITESPACE = /\s+/gu

const collapsed = (text: string): string => text.replaceAll(WHITESPACE, ' ').trim()

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isScheme = (value: unknown): value is Scheme => value === 'dark' || value === 'light'

const isPageCapture = (value: unknown): value is { page: string; file: string } =>
  isRecord(value) && typeof value.page === 'string' && typeof value.file === 'string'

// The text captures of one manifest entry, as file and page: a shot's one, or one for each page a video visits.
const entryCaptures = (entry: unknown): { scheme: Scheme; page: string; file: string }[] => {
  if (!isRecord(entry) || !isScheme(entry.scheme)) {
    throw new Error('The capture manifest holds a capture without a scheme')
  }
  const { scheme, page, text, texts } = entry
  if (typeof text === 'string' && typeof page === 'string') {
    return [{ scheme, page, file: text }]
  }
  if (Array.isArray(texts) && texts.every(isPageCapture)) {
    return texts.map((each) => ({ scheme, page: each.page, file: each.file }))
  }
  throw new Error('The capture manifest holds a capture with neither a text capture and its page nor a list of them')
}

const pageTextsOf = async (captures: string): Promise<IPageText[]> => {
  const manifest: unknown = JSON.parse(await readFile(join(captures, 'manifest.json'), 'utf8'))
  const entries = isRecord(manifest) ? manifest.captures : undefined
  if (!Array.isArray(entries)) {
    throw new Error('The capture manifest holds no list of captures')
  }
  return Promise.all(
    entries.flatMap(entryCaptures).map(async ({ scheme, page, file }) => ({
      path: new URL(page, 'http://capture.invalid').pathname,
      scheme,
      text: collapsed(await readFile(join(captures, file), 'utf8')),
    }))
  )
}

const isPageOf = (page: string, path: string): boolean =>
  page === CONVERSATION ? CONVERSATION_PATH.test(path) : page === path

// Every <Ui page> of a page's text outside its code blocks, with the line it starts on.
const quotesOf = (text: string): IQuote[] => {
  const fenced = new Set(codeLines(text).map(({ line }) => line))
  return [...text.matchAll(UI_TAG)]
    .map((match) => ({
      line: text.slice(0, match.index).split('\n').length,
      page: match.groups?.page ?? '',
      label: collapsed(match.groups?.label ?? ''),
    }))
    .filter((quote) => !fenced.has(quote.line))
}

// The schemes in which no text capture of the quote's page holds its label.
const missingSchemes = (quote: IQuote, texts: readonly IPageText[]): Scheme[] =>
  SCHEMES.filter(
    (scheme) =>
      !texts.some(
        (each) => each.scheme === scheme && isPageOf(quote.page, each.path) && each.text.includes(quote.label)
      )
  )

// Every UI label a page quotes with <Ui page> is in a text capture of that page in the dark and in the light scheme,
// so renaming a heading in the web app fails until the docs follow. A finding names the docs page, its line, the label
// and the page path.
export const checkK8 = async ({ docs, captures, repository }: IK8Inputs): Promise<IFinding[]> => {
  const texts = await pageTextsOf(captures)
  const findings = await Promise.all(
    (await pagesOf(docs)).map(async (page) => {
      const path = join(docs, 'src', page)
      return quotesOf(await readFile(path, 'utf8')).flatMap((quote) => {
        const missing = missingSchemes(quote, texts)
        if (missing.length === 0) {
          return []
        }
        const where = missing.length === SCHEMES.length ? 'no' : `no ${missing.join(' or ')}`
        return [
          {
            rule: RULE,
            file: relative(repository, path),
            line: quote.line,
            message: `"${quote.label}" is in ${where} capture of ${quote.page}`,
          },
        ]
      })
    })
  )
  return findings.flat()
}
