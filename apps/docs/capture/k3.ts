import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { scanText, type DemoSize } from '@log-book/demo'
import type { IFinding } from '../scripts/k7.js'

export interface IK3Inputs {
  // The built site's captures, with the run's manifest.
  captures: string
  // Findings name files relative to it.
  repository: string
}

interface IDemoBuild {
  build: string
  size: DemoSize
  seed: number
}

interface ITextCapture {
  text: string
  build: string
}

const RULE = 'K3'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isDemoBuild = (value: unknown): value is IDemoBuild =>
  isRecord(value) &&
  typeof value.build === 'string' &&
  (value.size === 'small' || value.size === 'rich') &&
  typeof value.seed === 'number'

const isVideoText = (value: unknown): value is { file: string } => isRecord(value) && typeof value.file === 'string'

// The text captures of one manifest entry: a shot's one, or one for each page a video visits; null for neither.
const textCapturesOf = (value: unknown): ITextCapture[] | null => {
  if (!isRecord(value) || typeof value.build !== 'string') {
    return null
  }
  const { build, text, texts } = value
  if (typeof text === 'string') {
    return [{ text, build }]
  }
  if (Array.isArray(texts) && texts.every(isVideoText)) {
    return texts.map((each) => ({ text: each.file, build }))
  }
  return null
}

// The run's demo builds and its text captures, as the capture manifest records them.
const manifestOf = (manifest: unknown): { demo: IDemoBuild[]; captures: ITextCapture[] } => {
  const demo = isRecord(manifest) ? manifest.demo : undefined
  const entries = isRecord(manifest) ? manifest.captures : undefined
  const captures = Array.isArray(entries) ? entries.map(textCapturesOf) : null
  if (!Array.isArray(demo) || !demo.every(isDemoBuild) || captures === null || captures.includes(null)) {
    throw new Error(
      'The capture manifest holds no demo builds with size and seed and no text captures with their build'
    )
  }
  return { demo, captures: captures.flatMap((each) => each ?? []) }
}

// Every line of a text capture that the demo's scan refuses, with the size and seed of the build it was captured from:
// another id shape (C5), the checking machine's home, user or host (C4), or an id that demo does not generate. A
// finding names the capture, the line and the rule, never the text it found.
export const checkK3 = async ({ captures, repository }: IK3Inputs): Promise<IFinding[]> => {
  const manifest = manifestOf(JSON.parse(await readFile(join(captures, 'manifest.json'), 'utf8')))
  const findings = await Promise.all(
    manifest.captures.map(async (capture) => {
      const build = manifest.demo.find((candidate) => candidate.build === capture.build)
      if (build === undefined) {
        throw new Error(`The capture ${capture.text} comes from the build ${capture.build}, which the manifest lacks`)
      }
      const path = join(captures, capture.text)
      const scanned = await scanText(await readFile(path, 'utf8'), { size: build.size, seed: build.seed })
      return scanned.map((finding) => ({
        rule: RULE,
        file: relative(repository, path),
        line: finding.line,
        message: finding.rule,
      }))
    })
  )
  return findings.flat()
}
