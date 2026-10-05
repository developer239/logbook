import { describe, expect, it } from 'vitest'
import { startHost, waitForStop, type IServing, type IStartSteps } from './host.js'

const PATHS = { warehousePath: '/home/example/warehouse.db', dataDirectory: '/home/example' }
const OPENED = { path: PATHS.warehousePath, previousVersion: 0, version: 1 }

// Stand-ins for the steps; each records its call, and whether the warehouse was open when it ran.
const recordingSteps = (calls: string[]): IStartSteps => ({
  resolvePaths: () => {
    calls.push('resolvePaths')
    return PATHS
  },
  migrate: async () => {
    calls.push('migrate')
    return Promise.resolve(OPENED)
  },
  announce: async () => {
    calls.push('announce')
    return Promise.resolve()
  },
  serve: async () => {
    calls.push('serve')
    return Promise.resolve({ stop: async () => Promise.resolve(), kill: () => undefined })
  },
  detect: () => {
    calls.push('detect')
  },
})

// Signals the test sends by hand.
const handSignals = (): {
  send: () => void
  listeners: () => number
  signals: (listener: () => void) => () => void
} => {
  const listeners = new Set<() => void>()
  return {
    send: () => {
      for (const listener of listeners) {
        listener()
      }
    },
    listeners: () => listeners.size,
    signals: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

describe('startHost', () => {
  it('runs the steps in the order of the start sequence, opening the warehouse first at step 4', async () => {
    // Arrange
    const calls: string[] = []

    // Act
    await startHost(recordingSteps(calls))

    // Assert
    expect(calls).toStrictEqual(['resolvePaths', 'migrate', 'announce', 'serve', 'detect'])
  })
})

describe('waitForStop', () => {
  it('stops the host on the first stop signal, and exits 0 once it has stopped', async () => {
    // Arrange
    const events: string[] = []
    const { promise: stopped, resolve: finishStop } = Promise.withResolvers<undefined>()
    const serving: IServing = {
      stop: async () => {
        events.push('stop')
        await stopped
      },
      kill: () => events.push('kill'),
    }
    const hand = handSignals()
    const waiting = waitForStop(serving, hand.signals)

    // Act
    hand.send()
    finishStop(undefined)
    const code = await waiting

    // Assert
    expect({ code, events, listeners: hand.listeners() }).toStrictEqual({ code: 0, events: ['stop'], listeners: 0 })
  })

  it('kills the children and exits 0 at once on a second stop signal while stopping', async () => {
    // Arrange
    const events: string[] = []
    const serving: IServing = {
      stop: async () => {
        events.push('stop')
        return new Promise(() => undefined)
      },
      kill: () => events.push('kill'),
    }
    const hand = handSignals()
    const waiting = waitForStop(serving, hand.signals)

    // Act
    hand.send()
    hand.send()
    const code = await waiting

    // Assert
    expect({ code, events, listeners: hand.listeners() }).toStrictEqual({
      code: 0,
      events: ['stop', 'kill'],
      listeners: 0,
    })
  })
})
