import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { IFinding } from './k7.js'

export interface IK4Inputs {
  // The built site, such as .vitepress/dist.
  built: string
  // The repository's README.
  readme: string
  // The shot list's file, whose lines the findings name.
  shotList: string
  // Findings name files relative to it.
  repository: string
  shots: readonly string[]
}

const RULE = 'K4'
const SCHEMES = ['dark', 'light']

// Every shot of the list is shown somewhere: a built page holds one of its captures, which a Shot, the landing page's
// hero image, a video's poster and the og:image all put there, or the README shows one.
export const checkK4 = async ({ built, readme, shotList, repository, shots }: IK4Inputs): Promise<IFinding[]> => {
  const pages = (await readdir(built, { recursive: true })).filter((path) => path.endsWith('.html'))
  const texts = [
    ...(await Promise.all(pages.map(async (page) => readFile(join(built, page), 'utf8')))),
    await readFile(readme, 'utf8'),
  ]
  const listLines = (await readFile(shotList, 'utf8')).split('\n')
  return shots
    .filter((id) => !SCHEMES.some((scheme) => texts.some((text) => text.includes(`captures/${id}-${scheme}.png`))))
    .map((id) => ({
      rule: RULE,
      file: relative(repository, shotList),
      line: Math.max(1, listLines.findIndex((line) => line.includes(`id: '${id}'`)) + 1),
      message: `the shot ${id} is shown by no page and not in the README`,
    }))
}
