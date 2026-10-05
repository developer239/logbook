import { join, resolve } from 'node:path'

// The environment of every logbook process the demo starts, built from nothing rather than filtered from the caller's,
// so a variable nobody thought of cannot carry the developer's real data into it. With the harness variables unset,
// every adapter resolves its location under HOME; the minimal PATH reaches no claude, so a demo host cannot spend a
// subscription. A caller that needs one more variable adds it to the new object it gets.
export const sealedEnvironment = (out: string): Record<string, string> => {
  const root = resolve(out)
  return {
    HOME: join(root, 'home'),
    LOGBOOK_DB: join(root, 'warehouse.db'),
    PATH: '/usr/bin:/bin',
    TZ: 'UTC',
    LANG: 'C.UTF-8',
  }
}
