import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeHome } from '../build/build-demo.js'
import type { DemoSize } from '../plan/types.js'
import { isInventedOnly, machineFacts } from './check-demo.js'

export type ScanRule = 'C4' | 'C5' | 'ids'

// A rule a line of the text breaks, by its number from 1; never the text it found.
export interface IScanFinding {
  rule: ScanRule
  line: number
}

export interface IScanOptions {
  size: DemoSize
  seed: number
}

// The tokens an id is made of: a UUID, or a session, message or tool call id of a harness that writes them.
const ID_TOKEN =
  /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:ses|msg|toolu)_[A-Za-z0-9]+)\b/giu

// Every id token of the demo of a size and seed, kept for the life of the process.
const known = new Map<string, Promise<ReadonlySet<string>>>()

const tokensOf = (text: string): string[] => [...text.matchAll(ID_TOKEN)].map(([token]) => token.toLowerCase())

// The id tokens of every session, message and tool call id the writers give the demo of that size and seed: ids are
// writer counters, so the anchor does not change them. The writers run into a temporary home, removed afterwards; the
// scan imports nothing and runs no CLI.
const generatedIds = async ({ size, seed }: IScanOptions): Promise<ReadonlySet<string>> => {
  const directory = await mkdtemp(join(tmpdir(), 'demo-scan-'))
  try {
    const { expected } = await writeHome(directory, { size, seed })
    return new Set(
      expected.flatMap((imported) =>
        [
          imported.session.id,
          ...imported.messages.map((message) => message.id),
          ...imported.toolCalls.map((call) => call.id),
        ].flatMap(tokensOf)
      )
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const idsOf = async (options: IScanOptions): Promise<ReadonlySet<string>> => {
  const key = `${options.size}/${String(options.seed)}`
  const ids = known.get(key) ?? generatedIds(options)
  known.set(key, ids)
  return ids
}

// Scans text that carries no manifest, such as a ticket draft or a page captured from a demo host: the check's machine
// facts (C4) with the scanning machine's home, user and host, its invented shapes (C5), and `ids`, every id one the
// demo of that size and seed generates. Resolves to every finding, none when the text passes.
export const scanText = async (text: string, options: IScanOptions): Promise<IScanFinding[]> => {
  const facts = machineFacts([homedir()])
  const ids = await idsOf(options)
  return text.split('\n').flatMap((line, index) => {
    const rules: ScanRule[] = [
      ...(facts.some((fact) => fact.test(line)) ? (['C4'] as const) : []),
      ...(isInventedOnly(line) ? [] : (['C5'] as const)),
      // A token of another shape breaks C5 already.
      ...(tokensOf(line).every((token) => !isInventedOnly(token) || ids.has(token)) ? [] : (['ids'] as const)),
    ]
    return rules.map((rule) => ({ rule, line: index + 1 }))
  })
}
