import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { IFinding } from './k7.js'
import type { ICallSite } from './privacy.js'
import { readmeDrift } from './readme.js'

export interface IK6Inputs {
  // The documentation package's directory, which holds src and the built site.
  docs: string
  // Findings name files relative to it.
  repository: string
  callSites: readonly ICallSite[]
  // The built site, such as .vitepress/dist.
  built: string
  // The repository's README, whose statement block copies the statement.
  readme: string
  siteUrl: string
}

interface IMarker {
  case: string
  line: number
}

const RULE = 'K6'
const MARKER = /<!-- data-flow-case: (?<case>[\w-]+) -->/gu
// A link to a heading of another page of the site, such as (/labelling/what-it-sends#what-each-request-contains).
const ANCHORED_LINK = /\]\((?<path>\/[^)#\s]*)#(?<anchor>[^)\s]+)\)/gu
const STATEMENT = join('src', 'privacy', 'statement.md')
const SUMMARY = join('src', 'privacy', 'summary.md')

const markersOf = (text: string): IMarker[] =>
  text
    .split('\n')
    .flatMap((line, index) =>
      [...line.matchAll(MARKER)].map((match) => ({ case: match.groups?.case ?? '', line: index + 1 }))
    )

const pageOf = async (inputs: IK6Inputs, file: string): Promise<{ file: string; markers: IMarker[] }> => ({
  file: relative(inputs.repository, join(inputs.docs, file)),
  markers: markersOf(await readFile(join(inputs.docs, file), 'utf8')),
})

// A case of the call sites that the statement has no marker for, and a marker in the statement or the summary for a
// case no call site has, so a new kind of call cannot ship without its section and a removed one leaves no promise.
const caseFindings = async (inputs: IK6Inputs): Promise<IFinding[]> => {
  const cases = new Set(inputs.callSites.map((site) => site.case))
  const [statement, summary] = await Promise.all([pageOf(inputs, STATEMENT), pageOf(inputs, SUMMARY)])
  const marked = new Set(statement.markers.map((marker) => marker.case))
  return [
    ...[...cases]
      .filter((each) => !marked.has(each))
      .map((each) => ({
        rule: RULE,
        file: statement.file,
        line: 1,
        message: `the call sites have the case ${each}, which the statement has no marker for`,
      })),
    ...[statement, summary].flatMap((page) =>
      page.markers
        .filter((marker) => !cases.has(marker.case))
        .map((marker) => ({
          rule: RULE,
          file: page.file,
          line: marker.line,
          message: `a marker for the case ${marker.case}, which no call site has`,
        }))
    ),
  ]
}

const builtPageOf = (built: string, path: string): string =>
  join(built, path.endsWith('/') ? `${path}index.html` : `${path}.html`)

const hasAnchor = async (file: string, anchor: string): Promise<boolean> => {
  try {
    return (await readFile(file, 'utf8')).includes(`id="${anchor}"`)
  } catch {
    return false
  }
}

// Every link of the statement to a heading of another page resolves to that heading in the built site.
const linkFindings = async (inputs: IK6Inputs): Promise<IFinding[]> => {
  const lines = (await readFile(join(inputs.docs, STATEMENT), 'utf8')).split('\n')
  const links = lines.flatMap((line, index) =>
    [...line.matchAll(ANCHORED_LINK)].map((match) => ({
      path: match.groups?.path ?? '',
      anchor: match.groups?.anchor ?? '',
      line: index + 1,
    }))
  )
  const resolved = await Promise.all(
    links.map(async (link) => hasAnchor(builtPageOf(inputs.built, link.path), link.anchor))
  )
  return links
    .filter((_link, index) => resolved[index] !== true)
    .map((link) => ({
      rule: RULE,
      file: relative(inputs.repository, join(inputs.docs, STATEMENT)),
      line: link.line,
      message: `the link to ${link.path}#${link.anchor} reaches no such heading in the built site`,
    }))
}

// The README's statement block, between its markers, is the statement with its links made absolute.
const readmeFindings = async (inputs: IK6Inputs): Promise<IFinding[]> => {
  const [readme, statement] = await Promise.all([
    readFile(inputs.readme, 'utf8'),
    readFile(join(inputs.docs, STATEMENT), 'utf8'),
  ])
  const drift = readmeDrift(readme, statement, inputs.siteUrl)
  return drift === null
    ? []
    : [{ rule: RULE, file: relative(inputs.repository, inputs.readme), line: 1, message: drift }]
}

// K6: the statement's case markers match the call-site file, its links reach the headings they name, and the README
// holds it word for word.
export const checkK6 = async (inputs: IK6Inputs): Promise<IFinding[]> => [
  ...(await caseFindings(inputs)),
  ...(await linkFindings(inputs)),
  ...(await readmeFindings(inputs)),
]
