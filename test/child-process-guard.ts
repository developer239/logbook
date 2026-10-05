import { ChildProcess } from 'node:child_process'
import { basename } from 'node:path'
import { afterAll, afterEach, beforeEach } from 'vitest'

// Fails a test that leaves a process it started running after its own teardown, and kills that process, so a leaked
// host, lock holder or child script cannot keep a port, a lock or a file busy into the next test. Every child the test
// process starts through `spawn`, `fork`, `exec` or `execFile` is recorded, product code's included; the synchronous
// forms end before they return. A child's children are outside it.

type TScope = 'test' | 'file'

interface IChildRegistry {
  isInTest: boolean
  children: Record<TScope, Set<ChildProcess>>
}

const REGISTRY = Symbol.for('log-book.child-process-guard')
const holder = globalThis as typeof globalThis & { [REGISTRY]?: IChildRegistry }

// One registry per process: the patch below is installed once and every file's hooks read it.
const registry = (): IChildRegistry => {
  holder[REGISTRY] ??= { isInTest: false, children: { test: new Set(), file: new Set() } }
  return holder[REGISTRY]
}

const isRunning = (child: ChildProcess): boolean =>
  child.pid !== undefined && child.exitCode === null && child.signalCode === null

// The command line a report names: the program's own name, then its arguments.
export const commandLineOf = (child: ChildProcess): string => {
  const [program = '', ...args] = child.spawnargs
  return [basename(program), ...args].join(' ')
}

// The children of a scope that are still running, killed and forgotten; those that exited are forgotten too.
export const takeLeakedChildren = (scope: TScope): string[] => {
  const children = registry().children[scope]
  const leaked = [...children].filter((child) => isRunning(child))
  children.clear()
  for (const child of leaked) {
    child.kill('SIGKILL')
  }
  return leaked.map((child) => `pid ${String(child.pid)}, ${commandLineOf(child)}`)
}

// The children a scope holds now, for the guard's own tests.
export const recordedChildren = (scope: TScope): ChildProcess[] => [...registry().children[scope]]

const failOnLeaks = (scope: TScope): void => {
  const leaked = takeLeakedChildren(scope)
  if (leaked.length > 0) {
    throw new Error(leaked.map((line) => `Test left a child process running: ${line}`).join('\n'))
  }
}

if (holder[REGISTRY] === undefined) {
  // Every asynchronous form starts its process through this method, which Node's types leave out.
  const spawn: unknown = Reflect.get(ChildProcess.prototype, 'spawn')
  if (typeof spawn !== 'function') {
    throw new TypeError('ChildProcess.prototype.spawn is not a function in this Node.')
  }
  Object.defineProperty(ChildProcess.prototype, 'spawn', {
    value: function value(this: ChildProcess, ...args: unknown[]): unknown {
      const result: unknown = Reflect.apply(spawn, this, args)
      const { isInTest, children } = registry()
      children[isInTest ? 'test' : 'file'].add(this)
      return result
    },
    writable: false,
    configurable: false,
  })
}
registry().children.file.clear()

// Registered before the file's own hooks: this beforeEach runs first and these after hooks run last, once the test's
// and the file's own teardown has run.
beforeEach(() => {
  registry().isInTest = true
})

afterEach(() => {
  registry().isInTest = false
  failOnLeaks('test')
})

afterAll(() => {
  failOnLeaks('file')
})
