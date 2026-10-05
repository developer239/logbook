import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { IImportedUnit } from '../contract.js'
import type { IFixtureSet } from './fixture-set.js'
import { expectedDirectory } from './home.js'

// Set to 1 to have the golden-output case rewrite every golden file of the sets it runs, so a deliberate change shows
// in review as a diff: `LOGBOOK_UPDATE_GOLDEN=1 pnpm test --project <adapter project>`.
const UPDATE_VARIABLE = 'LOGBOOK_UPDATE_GOLDEN'
// Stands for the temporary home a case ran in, so a golden file does not depend on where the copy was made.
const HOME_MARK = '<home>'

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => sortKeys(item))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => (left < right ? -1 : 1))
        .map(([key, item]) => [key, sortKeys(item)])
    )
  }
  return value
}

// The unit serialised with sorted keys, the home written as a mark.
export const goldenText = (unit: IImportedUnit, home: string): string =>
  `${JSON.stringify(sortKeys(unit), null, 2).split(home).join(HOME_MARK)}\n`

const goldenPath = (fixture: IFixtureSet, locator: string): string =>
  join(expectedDirectory(fixture), `${locator}.json`)

export const isUpdatingGolden = (): boolean => process.env[UPDATE_VARIABLE] === '1'

export const readGolden = async (fixture: IFixtureSet, locator: string): Promise<string> =>
  readFile(goldenPath(fixture, locator), 'utf8')

export const writeGolden = async (fixture: IFixtureSet, locator: string, text: string): Promise<void> => {
  const path = goldenPath(fixture, locator)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}
