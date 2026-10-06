import type { IItemPart } from '@log-book/engine'
import { escaped } from './reference.js'

// An entry of packages/engine/network-call-sites.json: a file that can make a network call, what it calls, and the
// case of the privacy statement that describes it.
export interface ICallSite {
  file: string
  calls: string
  case: string
}

const isCallSite = (value: unknown): value is ICallSite =>
  typeof value === 'object' &&
  value !== null &&
  'file' in value &&
  typeof value.file === 'string' &&
  'calls' in value &&
  typeof value.calls === 'string' &&
  'case' in value &&
  typeof value.case === 'string'

// The call-site file's entries, read as text: the site never imports it.
export const callSitesOf = (text: string): ICallSite[] => {
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed) || !parsed.every(isCallSite)) {
    throw new Error('The network call-site file is not a list of entries with file, calls and case')
  }
  return parsed
}

const clipOf = ({ chars, keep }: IItemPart): string =>
  chars === null ? 'not cut' : `${String(chars)} characters, from the ${keep}`

// Per task, in task order, the parts of an item in order and their clip sizes.
export const itemContentsPage = (
  contents: Readonly<Record<string, readonly IItemPart[]>>,
  order: readonly string[]
): string => {
  const rows = order.flatMap((task) => {
    const parts = contents[task]
    if (parts === undefined) {
      throw new Error(`The item contents have no task ${task}`)
    }
    return parts.map(
      (part, index) => `| ${index === 0 ? `\`${task}\`` : ''} | ${escaped(part.part)} | ${clipOf(part)} |`
    )
  })
  return ['| Task | Part, in order | Clip size |', '| --- | --- | --- |', ...rows, ''].join('\n')
}

// One row per entry: the file, what it calls and the statement's case for it.
export const callSitesPage = (sites: readonly ICallSite[]): string =>
  [
    '| File | What it calls | Statement case |',
    '| --- | --- | --- |',
    ...sites.map((site) => `| \`${site.file}\` | ${escaped(site.calls)} | ${site.case} |`),
    '',
  ].join('\n')
