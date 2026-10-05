import dns from 'node:dns'
import { syncBuiltinESMExports } from 'node:module'
import net from 'node:net'

// Every test process refuses a connection or a DNS lookup that would leave the machine, so no test passes because the
// network happened to be up and none can send anything anywhere. It patches this process only: the processes a test
// starts are children it does not reach.

const LOCALHOST = 'localhost'

const blocked = (target: string): Error => new Error(`Network access is blocked in tests: ${target}`)

// 127.0.0.0/8, ::1 and the IPv4-mapped loopback addresses.
const isLoopbackAddress = (address: string): boolean => {
  const unmapped = address.toLowerCase().startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return net.isIPv4(unmapped) ? unmapped.startsWith('127.') : unmapped === '::1'
}

const isAllowedHost = (host: string): boolean =>
  net.isIP(host) === 0 ? host.toLowerCase() === LOCALHOST : isLoopbackAddress(host)

interface IConnectTarget {
  host?: string
  port?: number | string
  path?: string
}

// The target of `socket.connect(...)` in each of its forms: Node's own normalised arguments, an options object, a
// port with a host, or a path.
const targetOf = (args: readonly unknown[]): IConnectTarget => {
  const [first, second] = args
  const options: unknown = Array.isArray(first) ? first[0] : first
  if (typeof options === 'object' && options !== null) {
    return options
  }
  if (typeof options === 'string' && Number.isNaN(Number(options))) {
    return { path: options }
  }
  return { port: options as number | string, ...(typeof second === 'string' ? { host: second } : {}) }
}

// The refusal of a connection outside loopback: a Unix domain socket is a path, not an address, and stays allowed.
const refusalOf = (target: IConnectTarget): Error | null => {
  if (target.path !== undefined) {
    return null
  }
  const host = target.host ?? LOCALHOST
  if (isAllowedHost(host)) {
    return null
  }
  return blocked(net.isIP(host) === 0 ? host : `${host}:${String(target.port ?? '')}`)
}

const freeze = (target: object, name: string, value: unknown): void => {
  Object.defineProperty(target, name, { value, writable: false, configurable: false, enumerable: true })
}

// Installed once per process: a worker that runs several files keeps the guard it installed first, and the
// properties cannot be redefined, so no test can switch it off.
const INSTALLED = Symbol.for('log-book.network-guard')
const registry = globalThis as typeof globalThis & { [INSTALLED]?: boolean }

if (registry[INSTALLED] !== true) {
  registry[INSTALLED] = true
  const { connect } = net.Socket.prototype
  Object.defineProperty(net.Socket.prototype, 'connect', {
    value: function value(this: net.Socket, ...args: unknown[]): net.Socket {
      const refusal = refusalOf(targetOf(args))
      if (refusal === null) {
        return Reflect.apply(connect, this, args) as net.Socket
      }
      // Failed as a real connection fails, at once and on the socket, so `fetch` carries it as its cause.
      process.nextTick(() => this.destroy(refusal))
      return this
    },
    writable: false,
    configurable: false,
  })

  type TLookup = (...args: unknown[]) => unknown

  const guardLookup = (lookup: TLookup, isPromise: boolean): TLookup =>
    function guardedLookup(this: unknown, ...args: unknown[]): unknown {
      const [hostname] = args
      if (typeof hostname === 'string' && isAllowedHost(hostname)) {
        return Reflect.apply(lookup, this, args)
      }
      const refusal = blocked(String(hostname))
      if (isPromise) {
        return Promise.reject(refusal)
      }
      const callback = args.at(-1)
      if (typeof callback === 'function') {
        process.nextTick(() => {
          ;(callback as (error: Error) => void)(refusal)
        })
        return undefined
      }
      throw refusal
    }

  freeze(dns, 'lookup', guardLookup(dns.lookup as TLookup, false))
  freeze(dns.promises, 'lookup', guardLookup(dns.promises.lookup as TLookup, true))
  // Named imports of the built-in modules see the guarded functions too.
  syncBuiltinESMExports()
}
