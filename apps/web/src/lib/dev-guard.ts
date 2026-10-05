import type { IncomingMessage, ServerResponse } from 'node:http'
import { checkRequest } from './guard'

type TNext = () => void

interface IDevServer {
  middlewares: { use: (handler: (req: IncomingMessage, res: ServerResponse, next: TNext) => void) => void }
}

// Under `astro dev`, Vite answers its own routes (modules, its client) before Astro's middleware runs; this plugin
// puts Log Book's check in front of all of them.
export const guardDevServer = {
  name: 'log-book-guard',
  configureServer: (server: IDevServer): void => {
    server.middlewares.use((req, res, next) => {
      const verdict = checkRequest({
        method: req.method ?? '',
        host: req.headers.host ?? null,
        origin: req.headers.origin ?? null,
      })

      if (verdict.isAccepted) {
        next()
        return
      }

      res.statusCode = verdict.status
      res.setHeader('Content-Type', 'text/plain;charset=UTF-8')
      res.end(verdict.body)
    })
  },
}
