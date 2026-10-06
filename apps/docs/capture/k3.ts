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

const isTextCapture = (value: unknown): value is ITextCapture =>
  isRecord(value) && typeof value.text === 'string' && typeof value.build === 'string'

// The run's demo builds and its text captures, as the capture manifest records them.
const manifestOf = (manifest: unknown): { demo: IDemoBuild[]; captures: ITextCapture[] } => {
  const demo = isRecord(manifest) ? manifest.demo : undefined
  const captures = isRecord(manifest) ? manifest.captures : undefined
  if (!Array.isArray(demo) || !demo.every(isDemoBuild) || !Array.isArray(captures) || !captures.every(isTextCapture)) {
    throw new Error(
      'The capture manifest holds no demo builds with size and seed and no text captures with their build'
    )
  }
  return { demo, captures }
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
