import { existsSync } from 'node:fs'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

type THandler = (req: IncomingMessage, res: ServerResponse, next?: (error?: unknown) => void) => void | Promise<void>

const DIST = fileURLToPath(new URL('../dist', import.meta.url))

export interface IBuiltHandler {
  origin: string
  // The copy the server runs from.
  directory: string
  close: () => Promise<void>
}

// The build copied away from the repository, as the CLI's tarball holds it, mounted on a server the test binds. Each
// copy is its own module instance, so it opens the warehouse LOGBOOK_DB names afresh.
export const mountBuiltHandler = async (): Promise<IBuiltHandler> => {
  if (!existsSync(join(DIST, 'server', 'entry.mjs'))) {
    throw new Error('The web app is not built; run pnpm build:packages first')
  }
  const directory = await mkdtemp(join(tmpdir(), 'web-handler-'))
  await cp(DIST, join(directory, 'dist'), { recursive: true })
  const { handler } = (await import(pathToFileURL(join(directory, 'dist', 'server', 'entry.mjs')).href)) as {
    handler: THandler
  }
  const server = createServer((req, res) => {
    void handler(req, res, () => {
      res.statusCode = 404
      res.end()
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })

  return {
    origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    directory,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
      await rm(directory, { recursive: true, force: true })
    },
  }
}
