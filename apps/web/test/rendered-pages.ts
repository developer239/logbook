import type { IBuiltDemo } from '@log-book/demo'
import { inject } from 'vitest'
import { encodeId } from '../src/lib/links'
import { logbookStub, type ILogbookStub } from '../src/lib/testing/logbook-stub'
import { copyDemo, type DemoSet, type ITestWarehouse } from '../src/lib/testing/warehouse'
import { mountBuiltHandler, type IBuiltHandler } from './built-handler'
import { firstPromptOf, idOf, ownStepsOf, promptBefore, sessionWith } from './plan-facts'

export interface IMountedSet {
  demo: IBuiltDemo
  warehouse: ITestWarehouse
  built: IBuiltHandler
  close: () => Promise<void>
}

export interface IRenderedPage {
  path: string
  status: number
  body: string
}

export interface IServedPage extends IRenderedPage {
  // The origin of the handler that served it.
  origin: string
}

// The built handler over its own copy of a demo set. Mount one set at a time: copying a set resets the test's module
// registry, which the handler loads its pages through, so a handler mounted before reads the newer copy.
export const mountSet = async (set: DemoSet): Promise<IMountedSet> => {
  const warehouse = await copyDemo(set)
  const built = await mountBuiltHandler()
  return {
    demo: inject(set),
    warehouse,
    built,
    close: async () => {
      await built.close()
      await warehouse.remove()
    },
  }
}

// What `logbook labels plan` would print for the set: its harnesses, as their descriptor rows name them.
export const answerPlan = (stub: ILogbookStub, warehouse: ITestWarehouse): void => {
  const harnesses = warehouse.db.prepare('SELECT id, name FROM harness ORDER BY id').all() as {
    id: string
    name: string
  }[]
  stub.answer(0, [], {
    stdout: JSON.stringify({
      model: 'claude-haiku-4-5',
      claudeVersion: '2.1.290',
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      apiKeyInEnvironment: false,
      tasks: [{ task: 'shell', records: harnesses.length }],
      harnesses: harnesses.map((harness) => ({ ...harness, records: 1 })),
      records: harnesses.length,
      estimatedInputTokens: 1000,
    }),
  })
}

// Every route of the app over the whole of the set's time, the conversation and its pane on a session of the plan: its
// first turn and the first call in it.
export const routesOf = (demo: IBuiltDemo): string[] => {
  const key = sessionWith(demo, (step) => step.kind === 'call')
  const turn = firstPromptOf(demo, key).key
  const step = ownStepsOf(demo, key).find(
    (candidate) => candidate.kind === 'call' && promptBefore(demo, key, candidate.key) === turn
  )
  if (step === undefined) {
    throw new Error(`${key} plans no call in its first turn`)
  }
  const id = encodeId(idOf(demo, key))
  const pane = new URLSearchParams({ range: 'all', turn: idOf(demo, turn), step: idOf(demo, step.key) })

  return [
    '/?range=all',
    '/conversations?range=all',
    `/conversations/${id}?range=all`,
    `/pane/${id}?${pane.toString()}`,
    '/steps?range=all',
    '/tokens?range=all',
    '/labels',
  ]
}

export const render = async (origin: string, paths: readonly string[]): Promise<IRenderedPage[]> =>
  Promise.all(
    paths.map(async (path) => {
      const response = await fetch(`${origin}${path}`)
      return { path, status: response.status, body: await response.text() }
    })
  )

// Every route of a set, rendered by its own handler with a stub logbook in `directory`, which is then closed.
export const renderSet = async (set: DemoSet, directory: string): Promise<IServedPage[]> => {
  const stub = await logbookStub(directory)
  const mounted = await mountSet(set)
  answerPlan(stub, mounted.warehouse)
  const { origin } = mounted.built
  const pages = await render(origin, routesOf(mounted.demo))
  await mounted.close()
  return pages.map((page) => ({ ...page, origin }))
}
