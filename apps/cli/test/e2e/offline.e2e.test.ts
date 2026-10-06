import { networkInterfaces } from 'node:os'
import type { ISessionScript } from '@log-book/adapter-api/source-writer'
import { openSqlite } from '@log-book/core'
import { describe, expect, inject, it } from 'vitest'
import { useE2eHarness } from './harness.js'

// Sync, the pages and the rule labels need no network: only labelling calls leave the machine. CI runs this file alone
// inside a Linux network namespace with only loopback up, with LOGBOOK_E2E_OFFLINE=1; everywhere else it runs as part
// of every pnpm test:e2e.
const harness = useE2eHarness()

const OFFLINE_VARIABLE = 'LOGBOOK_E2E_OFFLINE'
const RULES_LABELLER = 'rules'
const NEEDS_CLAUDE = 'needs Claude Code: install it (https://claude.com/claude-code) or set CLAUDE_BIN'

// With LOGBOOK_E2E_OFFLINE=1, fails unless this process sees only loopback interfaces, so a CI step that ran it outside
// the namespace fails instead of passing on a machine that had the network all along.
const refuseOnline = (): void => {
  if (process.env[OFFLINE_VARIABLE] !== '1') {
    return
  }
  const others = Object.entries(networkInterfaces())
    .filter(([, addresses]) => (addresses ?? []).some((address) => !address.internal))
    .map(([name]) => name)
  if (others.length > 0) {
    throw new Error(`not offline: ${others.join(', ')}`)
  }
}

const ruleLabels = async (warehouse: string): Promise<number> => {
  const db = await openSqlite(warehouse, { isReadOnly: true })
  try {
    const [row] = db.prepare('SELECT count(*) AS labels FROM label WHERE labeller = ?').all(RULES_LABELLER) as {
      labels: number
    }[]
    return row?.labels ?? 0
  } finally {
    db.close()
  }
}

// A top-level session of the small set and its first prompt, by their warehouse ids.
const sessionAndTurn = (): { session: string; turn: string } => {
  const { plan } = inject('e2eDemo')
  const scripts: ISessionScript[] = plan.writers.flatMap((writer) => writer.scripts)
  const script = scripts.find((candidate) => candidate.steps.some((step) => step.kind === 'prompt'))
  const prompt = script?.steps.find((step) => step.kind === 'prompt')
  const session = plan.ids[script?.key ?? '']
  const turn = plan.ids[prompt?.key ?? '']
  if (session === undefined || turn === undefined) {
    throw new Error('the small set has no top-level session with a prompt')
  }
  return { session, turn }
}

const encodeId = (id: string): string => id.split('/').map(encodeURIComponent).join('/')

describe('the offline run', () => {
  it('syncs, writes rule labels and serves every page with no network', async () => {
    // Arrange
    refuseOnline()
    const home = await harness.createHome()
    const { session, turn } = sessionAndTurn()
    const pane = new URLSearchParams({ range: 'all', turn })
    const pages = [
      '/?range=all',
      '/conversations?range=all',
      `/conversations/${encodeId(session)}?range=all`,
      `/pane/${encodeId(session)}?${pane.toString()}`,
      '/steps?range=all',
      '/tokens?range=all',
      '/labels',
    ]

    // Act
    const sync = await harness.run(home, ['sync'])
    const labels = await ruleLabels(home.environment.LOGBOOK_DB ?? '')
    const host = await harness.startHost(home, { args: ['--no-open', '--no-sync'] })
    const responses = await Promise.all(
      pages.map(async (path) => {
        const response = await fetch(`${host.url}${path}`)
        return { path, status: response.status, text: await response.text() }
      })
    )
    const stopped = await host.stop()

    // Assert
    expect({
      sync: sync.code,
      hasRuleLabels: labels > 0,
      statuses: responses.map(({ path, status }) => ({ path, status })),
      isLabelsSayingNoClaude: responses.find(({ path }) => path === '/labels')?.text.includes(NEEDS_CLAUDE),
      stopped,
    }).toStrictEqual({
      sync: 0,
      hasRuleLabels: true,
      statuses: pages.map((path) => ({ path, status: 200 })),
      isLabelsSayingNoClaude: true,
      stopped: 0,
    })
  })
})
