import { WarehouseStore } from '@log-book/warehouse'
import type { RewriteMessage } from './rewrite-messages.js'

// The engine's rewrite process: forked with an IPC channel, it opens its own read-write connection, compacts the
// warehouse whose path is its one argument, reports each step on the channel and exits. It prints nothing and installs
// no signal handler, so a stop ends it at once and SQLite rolls back a rewrite that had not committed. It imports
// packages and types only, so Node can run its source as it is.

const send = async (message: RewriteMessage): Promise<void> =>
  new Promise((resolve) => {
    process.send?.(message, () => {
      resolve()
    })
  })

const compact = async (store: WarehouseStore): Promise<void> => {
  store.optimizeFullText()
  await send({ type: 'step-ended', step: 'full-text' })
  await send({ type: 'pages-before-vacuum', pages: store.readPageCount() })
  store.vacuum()
  await send({ type: 'step-ended', step: 'vacuum' })
  store.truncateWal()
  await send({ type: 'step-ended', step: 'checkpoint' })
}

const run = async (warehousePath: string): Promise<void> => {
  try {
    const store = await WarehouseStore.open(warehousePath)
    try {
      await compact(store)
    } finally {
      store.close()
    }
    await send({ type: 'done' })
  } catch (error: unknown) {
    await send({ type: 'failed', message: error instanceof Error ? error.message : String(error) })
  }
}

await run(process.argv[2] ?? '')
process.disconnect()
