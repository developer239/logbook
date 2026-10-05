import { WarehouseStore } from '@log-book/warehouse'
import type { RewriteMessage, RewriteTask } from './rewrite-messages.js'

// The engine's rewrite process: forked with an IPC channel, it opens its own read-write connection to the warehouse
// whose path is its one argument, runs the task its first message names, reports each step on the channel and exits.
// It prints nothing and installs no signal handler, so a stop ends it at once and SQLite rolls back a transaction that
// had not committed. It imports packages and types only, so Node can run its source as it is.

const send = async (message: RewriteMessage): Promise<void> =>
  new Promise((resolve) => {
    process.send?.(message, () => {
      resolve()
    })
  })

const forget = async (store: WarehouseStore, sessionIds: readonly string[], forgottenAt: number): Promise<void> => {
  const { sessionIds: removed, labelCount } = store.forgetSessions(sessionIds, forgottenAt)
  await send({ type: 'forgotten', sessionCount: removed.length, labelCount })
  await send({ type: 'step-ended', step: 'deletion' })
}

const compact = async (store: WarehouseStore): Promise<void> => {
  store.optimizeFullText()
  await send({ type: 'step-ended', step: 'full-text' })
  await send({ type: 'pages-before-vacuum', pages: store.readPageCount() })
  store.vacuum()
  await send({ type: 'step-ended', step: 'vacuum' })
  store.truncateWal()
  await send({ type: 'step-ended', step: 'checkpoint' })
}

// Forget's last step is the compaction, which purges the forgotten text from the file.
const run = async (warehousePath: string, task: RewriteTask): Promise<void> => {
  try {
    const store = await WarehouseStore.open(warehousePath)
    try {
      if (task.kind === 'forget') {
        await forget(store, task.sessionIds, task.forgottenAt)
      }
      await compact(store)
    } finally {
      store.close()
    }
    await send({ type: 'done' })
  } catch (error: unknown) {
    await send({ type: 'failed', message: error instanceof Error ? error.message : String(error) })
  }
}

const task = await new Promise<RewriteTask>((resolve) => {
  process.once('message', resolve)
})
await run(process.argv[2] ?? '', task)
process.disconnect()
