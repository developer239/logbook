import type { IncomingMessage, ServerResponse } from 'node:http'

// The build's server entry, dist/server/entry.mjs, in middleware mode: the host mounts this handler on a server it
// binds itself, so the app opens no socket of its own. `next` is called for a request the app does not serve, and
// `locals` reaches the pages as Astro.locals.
export declare const handler: (
  req: IncomingMessage,
  res: ServerResponse,
  next?: (error?: unknown) => void,
  locals?: object
) => void | Promise<void>
