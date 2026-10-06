import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudeCodeSourceWriter } from '@log-book/adapter-claude-code/source-writer'
import { openCodeSourceWriter } from '@log-book/adapter-opencode/source-writer'
import { isErrnoCode, LogBookError } from '@log-book/core'
import { DEFAULT_LABEL_MODEL } from '@log-book/engine'
import { checkBuild } from '../check/check-demo.js'
import { DEMO_CORPUS_MARK, PLAN_CORPUS } from '../corpus/index.js'
import { MODELS } from '../corpus/models.js'
import { DEMO_ERROR_CODES } from '../errors.js'
import { importDemo } from '../import/import-demo.js'
import { planLabels } from '../plan/labels.js'
import { planDataset } from '../plan/planner.js'
import { scriptPlan } from '../plan/scripts.js'
import type { DemoSize, IDemoPlan, IPlanInputs, IWriterDeclaration, LabelsVariant } from '../plan/types.js'
import { demoWarehousePath } from '../sealed-environment.js'
import { MANIFEST_FILE, writeDemo, type IWrittenDemo } from '../write/write-demo.js'
import { writeLabels } from '../write/write-labels.js'

const HOUR_MS = 3_600_000

export interface IBuildOptions {
  size: DemoSize
  // 1 when absent.
  seed?: number
  // Epoch milliseconds; the size's own anchor when absent.
  anchor?: number
  // `all` when absent.
  labels?: LabelsVariant
  // The engine's default model when absent; ignored with labels `none`.
  model?: string
  // `packages/demo/out/<size>` in the repository when absent.
  out?: string
}

export interface IBuiltDemo {
  // Absolute.
  out: string
  // Absolute.
  warehouse: string
  manifest: IWrittenDemo['manifest']
  plan: IDemoPlan
}

// The small set's fixed anchor, so tests pass the same `now` to range parsing; the rich set's is the current hour.
const ANCHORS: Readonly<Record<DemoSize, (now: number) => number>> = {
  small: () => Date.UTC(2026, 8, 28, 18),
  // The hour it was built, which only its manifest still knows.
  rich: (now) => now,
}

// The writers of the two harnesses, and what the planner may ask of each.
const WRITERS = [claudeCodeSourceWriter(), openCodeSourceWriter()] as const
const DECLARATIONS: readonly IWriterDeclaration[] = [
  { capabilities: [...WRITERS[0].capabilities], families: [...WRITERS[0].families], models: MODELS['claude-code'] },
  { capabilities: [...WRITERS[1].capabilities], families: [...WRITERS[1].families], models: MODELS.opencode },
]

// The current time floored to the hour, so two builds within one hour are identical.
export const thisHour = (now: number): number => Math.floor(now / HOUR_MS) * HOUR_MS

export const defaultOut = (size: DemoSize): string => fileURLToPath(new URL(`../../out/${size}`, import.meta.url))

const notDemo = (out: string): LogBookError =>
  new LogBookError(
    `${out} holds something other than a demo build; give an empty or new directory`,
    DEMO_ERROR_CODES.DEMO_OUT_NOT_DEMO
  )

const isDemoBuild = async (out: string): Promise<boolean> => {
  try {
    const manifest: unknown = JSON.parse(await readFile(join(out, MANIFEST_FILE), 'utf8'))
    return (
      typeof manifest === 'object' &&
      manifest !== null &&
      'corpusMark' in manifest &&
      manifest.corpusMark === DEMO_CORPUS_MARK
    )
  } catch {
    return false
  }
}

// The out directory may not exist, be empty, or hold a previous demo build, whose contents go; anything else stops the
// build and is left as it was, so an out directory can never point at real data and mix into it.
const guardOut = async (out: string): Promise<void> => {
  try {
    if (!(await stat(out)).isDirectory()) {
      throw notDemo(out)
    }
  } catch (error: unknown) {
    if (isErrnoCode(error, 'ENOENT')) {
      return
    }
    throw error
  }

  const entries = await readdir(out)
  if (entries.length === 0) {
    return
  }
  if (!(await isDemoBuild(out))) {
    throw notDemo(out)
  }
  await Promise.all(entries.map(async (entry) => rm(join(out, entry), { recursive: true, force: true })))
}

// Plans the set and writes its home, its plan file and its manifest into `out`: what the writers wrote, before any
// import.
export const writeHome = async (out: string, options: IBuildOptions): Promise<IWrittenDemo> => {
  const { size, seed = 1, labels = 'all', model = DEFAULT_LABEL_MODEL } = options
  const inputs: IPlanInputs = {
    size,
    seed,
    anchor: options.anchor ?? ANCHORS[size](thisHour(Date.now())),
    labels,
    model: labels === 'none' ? null : model,
    corpus: PLAN_CORPUS,
    writers: DECLARATIONS,
  }
  const plan = planDataset(inputs)
  const scripts = scriptPlan(plan, inputs)
  return writeDemo(out, { plan, writers: scripts, labels: planLabels(plan, scripts, PLAN_CORPUS), ids: {} }, WRITERS)
}

// Plans the set, writes the home, the plan file and the manifest, imports the home through the built CLI in the
// sealed environment and compares what it read with what the writers wrote, writes the planned labels and their
// labelling runs, and last checks the out directory against its manifest.
export const buildDemo = async (options: IBuildOptions): Promise<IBuiltDemo> => {
  if (process.env.TZ !== 'UTC') {
    throw new LogBookError(
      `the demo is built in UTC; set TZ=UTC (it is ${process.env.TZ ?? 'unset'})`,
      DEMO_ERROR_CODES.DEMO_TZ_NOT_UTC
    )
  }

  const out = resolve(options.out ?? defaultOut(options.size))
  await guardOut(out)
  const written = await writeHome(out, options)
  await importDemo(out, written)
  await writeLabels(demoWarehousePath(out), written.plan)
  await checkBuild(out)

  return { out, warehouse: demoWarehousePath(out), manifest: written.manifest, plan: written.plan }
}
