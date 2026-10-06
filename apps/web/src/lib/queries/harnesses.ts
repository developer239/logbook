import { all } from '../warehouse'

// A harness as its adapter describes it in the row each sync writes: what it is called, which agent a session without
// one ran as, which alias the conversation filter takes, where discovery found it, and the drift notice the last sync
// stored when the harness wrote data newer than this Log Book is tested with.
export interface IHarness {
  id: string
  name: string
  defaultAgent: string
  filterAlias: string
  isFound: boolean
  location: string | null
  locationVariables: string[]
  problem: string | null
  // One or two sentences, each naming the harness, shown as written.
  notice: string | null
}

// Every harness that ever synced, by id; read once per request and passed to whatever names a harness.
export type Harnesses = ReadonlyMap<string, IHarness>

interface IHarnessRow extends Omit<IHarness, 'isFound' | 'locationVariables'> {
  isFound: number
  locationVariables: string
}

const variablesOf = (id: string, text: string): string[] => {
  const variables: unknown = JSON.parse(text)
  if (!Array.isArray(variables) || !variables.every((variable) => typeof variable === 'string')) {
    throw new Error(`The harness ${id} lists its location variables as something other than a list of names`)
  }
  return variables
}

export const harnessesOf = (): Harnesses =>
  new Map(
    all<IHarnessRow>(
      `SELECT id, name, default_agent AS defaultAgent, filter_alias AS filterAlias, is_found AS isFound, location,
         location_variables AS locationVariables, problem, notice
       FROM harness ORDER BY id`
    ).map((row) => [
      row.id,
      { ...row, isFound: row.isFound === 1, locationVariables: variablesOf(row.id, row.locationVariables) },
    ])
  )
