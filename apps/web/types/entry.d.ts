import type { ChildProcess } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'

// What the host passes in `locals`, which reaches the pages as Astro.locals: its child registry, through which the
// web app starts every logbook child, so stopping the host stops them.
export interface IWebLocals {
  children?: { spawn: (args: readonly string[]) => ChildProcess }
}

// The build's server entry, dist/server/entry.mjs, in middleware mode: the host mounts this handler on a server it
// binds itself, so the app opens no socket of its own. `next` is called for a request the app does not serve, and
// `locals` reaches the pages as Astro.locals.
export declare const handler: (
  req: IncomingMessage,
  res: ServerResponse,
  next?: (error?: unknown) => void,
  locals?: IWebLocals
) => void | Promise<void>
