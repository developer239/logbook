import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { IFinding } from './k7.js'

export interface IK10Inputs {
  // The built site, such as .vitepress/dist.
  built: string
  // Findings name files relative to it.
  repository: string
}

interface IVideoBudget {
  file: string
  // What the video should stay under, and the size it fails at.
  budget: number
  limit: number
}

const RULE = 'K10'
const MB = 1024 * 1024
const PNG_LIMIT = MB
// GitHub Pages publishes a site of at most 1 GB.
const SITE_LIMIT = 200 * MB
const VIDEOS: readonly IVideoBudget[] = [
  { file: 'captures/tour.mp4', budget: 6 * MB, limit: 12 * MB },
  { file: 'captures/conversation-scroll.mp4', budget: 3 * MB, limit: 6 * MB },
]

const megabytes = (bytes: number): string => `${(bytes / MB).toFixed(1)} MB`

// The sizes the built site is held to: every PNG under 1 MB, each video under twice its budget, the whole site under
// 200 MB. The report lists each video against its budget, the largest PNG and the site's total, on every run.
export const checkK10 = async ({
  built,
  repository,
}: IK10Inputs): Promise<{ findings: IFinding[]; report: string[] }> => {
  const paths = (await readdir(built, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(built, join(entry.parentPath, entry.name)).split('\\').join('/'))
  const sizes = new Map(
    await Promise.all(paths.map(async (path) => [path, (await stat(join(built, path))).size] as const))
  )
  const total = [...sizes.values()].reduce((sum, size) => sum + size, 0)
  const pngs = [...sizes]
    .filter(([path]) => path.toLowerCase().endsWith('.png'))
    .toSorted((left, right) => right[1] - left[1])
  const finding = (path: string, message: string): IFinding => ({
    rule: RULE,
    file: relative(repository, join(built, path)),
    line: 1,
    message,
  })
  const [largest] = pngs
  return {
    findings: [
      ...pngs
        .filter(([, size]) => size > PNG_LIMIT)
        .map(([path, size]) => finding(path, `is ${megabytes(size)}, over 1 MB`)),
      ...VIDEOS.flatMap(({ file, limit }) => {
        const size = sizes.get(file) ?? 0
        return size > limit ? [finding(file, `is ${megabytes(size)}, over ${megabytes(limit)}`)] : []
      }),
      ...(total > SITE_LIMIT ? [finding('', `the site is ${megabytes(total)}, over 200 MB`)] : []),
    ],
    report: [
      ...VIDEOS.map(({ file, budget }) => {
        const size = sizes.get(file)
        return `${file}: ${size === undefined ? 'missing' : megabytes(size)} of a ${megabytes(budget)} budget`
      }),
      `Largest PNG: ${largest === undefined ? 'none' : `${largest[0]}, ${megabytes(largest[1])}`}`,
      `Site: ${megabytes(total)} in ${String(paths.length)} files`,
    ],
  }
}
