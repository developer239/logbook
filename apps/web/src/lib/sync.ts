import { runCookbook } from './cookbook'

let running: Promise<void> | undefined

export const sync = (): Promise<void> => {
  running ??= runCookbook(['sync']).finally(() => {
    running = undefined
  })
  return running
}
