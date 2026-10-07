import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkRequest, HOST_REFUSAL, ORIGIN_REFUSAL, responseHeaders, type RequestVerdict } from './guard'

const ACCEPT: RequestVerdict = { isAccepted: true }
const HOST: RequestVerdict = { isAccepted: false, status: 403, body: HOST_REFUSAL }
const ORIGIN: RequestVerdict = { isAccepted: false, status: 403, body: ORIGIN_REFUSAL }

const POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; " +
  "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"

// A module the host loads on its own; any dependency would be missing from the build beside it.
const DEPENDENCY = /^\s*import\b|\brequire\s*\(|\bimport\s*\(/u

describe('checkRequest', () => {
  it.each<[string, string | null, string | null, RequestVerdict]>([
    ['GET', '127.0.0.1:7314', null, ACCEPT],
    ['GET', 'localhost:7314', null, ACCEPT],
    ['GET', 'LOCALHOST:7314', null, ACCEPT],
    ['GET', 'evil.example:7314', null, HOST],
    ['GET', '127.0.0.1.nip.example:7314', null, HOST],
    ['GET', '[::1]:7314', null, HOST],
    ['GET', null, null, HOST],
    // A cross-site GET cannot read the reply and changes nothing.
    ['GET', '127.0.0.1:7314', 'http://evil.example', ACCEPT],
    ['POST', '127.0.0.1:7314', 'http://127.0.0.1:7314', ACCEPT],
    ['POST', 'localhost:7314', 'http://localhost:7314', ACCEPT],
    ['POST', '127.0.0.1:7314', 'http://localhost:7314', ORIGIN],
    ['POST', '127.0.0.1:7314', 'http://127.0.0.1:3000', ORIGIN],
    ['POST', '127.0.0.1:7314', 'null', ORIGIN],
    ['POST', '127.0.0.1:7314', null, ORIGIN],
    // DNS rebinding: a page on another name is same-origin with itself.
    ['POST', 'evil.example:7314', 'http://evil.example:7314', HOST],
  ])('should answer %s with Host %s and Origin %s as expected', (method, host, origin, expected) => {
    // Act
    const verdict = checkRequest({ method, host, origin })

    // Assert
    expect(verdict).toStrictEqual(expected)
  })

  it('should refuse a method other than GET, HEAD and POST with 405', () => {
    // Act
    const verdict = checkRequest({ method: 'PUT', host: '127.0.0.1:7314', origin: 'http://127.0.0.1:7314' })

    // Assert
    expect(verdict).toMatchObject({ isAccepted: false, status: 405 })
  })
})

describe('responseHeaders', () => {
  it('should name the running version only when one is passed', () => {
    // Act
    const withVersion = responseHeaders('1.2.3')
    const withoutVersion = responseHeaders()

    // Assert
    const policy = {
      'Content-Security-Policy': POLICY,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    }
    expect({ withVersion, withoutVersion }).toStrictEqual({
      withVersion: { ...policy, 'x-log-book': '1.2.3' },
      withoutVersion: policy,
    })
  })
})

describe('guard.ts', () => {
  it('should depend on nothing, so it can be built and loaded on its own', () => {
    // Arrange
    const lines = readFileSync(new URL('guard.ts', import.meta.url), 'utf8').split('\n')

    // Act
    const dependencies = lines.flatMap((line, index) =>
      DEPENDENCY.test(line) ? [`${String(index + 1)}: ${line}`] : []
    )

    // Assert
    expect(dependencies).toStrictEqual([])
  })
})
