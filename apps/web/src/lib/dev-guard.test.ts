import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { guardDevServer } from './dev-guard'
import { HOST_REFUSAL } from './guard'

type THandler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

interface IOutcome {
  isPassedOn: boolean
  status: number | null
  type: string | null
  body: string | null
}

// The handler the plugin adds to the dev server, run on one request.
const answer = (method: string, headers: Record<string, string>): IOutcome => {
  const handlers: THandler[] = []
  guardDevServer.configureServer({ middlewares: { use: (handler) => handlers.push(handler) } })
  const reply = {
    statusCode: 0,
    type: null as string | null,
    body: null as string | null,
    setHeader: (_name: string, value: string) => {
      reply.type = value
    },
    end: (body: string) => {
      reply.body = body
    },
  }
  let isPassedOn = false

  handlers[0]?.({ method, headers } as IncomingMessage, reply as unknown as ServerResponse, () => {
    isPassedOn = true
  })

  return {
    isPassedOn,
    status: reply.statusCode === 0 ? null : reply.statusCode,
    type: reply.type,
    body: reply.body,
  }
}

describe('guardDevServer', () => {
  it('should pass a request to a loopback name on to the dev server', () => {
    // Act
    const outcome = answer('GET', { host: '127.0.0.1:4321' })

    // Assert
    expect(outcome).toStrictEqual({ isPassedOn: true, status: null, type: null, body: null })
  })

  it('should answer a request to another name itself, before any route of the dev server', () => {
    // Act
    const outcome = answer('GET', { host: 'evil.example:4321' })

    // Assert
    expect(outcome).toStrictEqual({
      isPassedOn: false,
      status: 403,
      type: 'text/plain;charset=UTF-8',
      body: HOST_REFUSAL,
    })
  })
})
