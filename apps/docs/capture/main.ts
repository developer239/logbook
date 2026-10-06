import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { buildDemo, startDemo, type IStartedDemo } from '@log-book/demo'
import { chromium, type Browser } from 'playwright'
import { captureShot, type ICaptureRecord } from './capture.js'
import { SCHEMES, SHOTS, type BuildName, type Scheme } from './shots.js'

// From dist/capture where the build leaves this module.
const CAPTURES = new URL('../../src/public/captures/', import.meta.url)

interface IHost {
  build: BuildName
  started: IStartedDemo
}

// The rich set, built here or reused from --demo-out, and the small set without labels for the not-labelled shot.
const startHosts = async (temporary: string, demoOut: string | undefined): Promise<IHost[]> => {
  const rich =
    demoOut === undefined ? (await buildDemo({ size: 'rich', out: join(temporary, 'rich') })).out : resolve(demoOut)
  const small = (await buildDemo({ size: 'small', labels: 'none', out: join(temporary, 'not-labelled') })).out
  return Promise.all([
    startDemo({ out: rich, port: 0 }).then((started) => ({ build: 'rich' as const, started })),
    startDemo({ out: small, port: 0 }).then((started) => ({ build: 'not-labelled' as const, started })),
  ])
}

const hostFor = (hosts: readonly IHost[], build: BuildName): IStartedDemo => {
  const host = hosts.find((candidate) => candidate.build === build)
  if (host === undefined) {
    throw new Error(`No host for the ${build} build`)
  }
  return host.started
}

// Every shot of one scheme, one after another in one browser context.
const captureScheme = async (browser: Browser, hosts: readonly IHost[], scheme: Scheme): Promise<ICaptureRecord[]> => {
  const context = await browser.newContext({
    colorScheme: scheme,
    timezoneId: 'UTC',
    locale: 'en-US',
    deviceScaleFactor: 2,
  })
  try {
    return await SHOTS.reduce<Promise<ICaptureRecord[]>>(async (done, shot) => {
      const records = await done
      const { url, plan } = hostFor(hosts, shot.build)
      const record = await captureShot({ context, host: url, plan, shot, scheme, directory: CAPTURES.pathname })
      return [...records, record]
    }, Promise.resolve([]))
  } finally {
    await context.close()
  }
}

const captureAll = async (hosts: readonly IHost[]): Promise<ICaptureRecord[]> => {
  const browser = await chromium.launch({ headless: true })
  try {
    return await SCHEMES.reduce<Promise<ICaptureRecord[]>>(
      async (done, scheme) => [...(await done), ...(await captureScheme(browser, hosts, scheme))],
      Promise.resolve([])
    )
  } finally {
    await browser.close()
  }
}

const manifestOf = (hosts: readonly IHost[], captures: readonly ICaptureRecord[]): string =>
  `${JSON.stringify(
    { demo: hosts.map(({ build, started }) => ({ build, ...started.manifest.build })), captures },
    null,
    2
  )}\n`

const lineOf = (error: unknown): string => {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return `${error.code}: ${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}

// pnpm docs:capture: builds the demo or reuses --demo-out, starts its hosts, captures every shot in both schemes into
// src/public/captures with the run's manifest, and stops the hosts, also after a failure. Its zone must be UTC
// before any module loads, which the bin shim sees to.
export const runCapture = async (argv: readonly string[], write: (line: string) => void): Promise<number> => {
  const { values } = parseArgs({ args: [...argv], options: { 'demo-out': { type: 'string' } }, strict: true })
  const demoOut =
    values['demo-out'] === undefined ? undefined : resolve(process.env.INIT_CWD ?? process.cwd(), values['demo-out'])
  const temporary = await mkdtemp(join(tmpdir(), 'docs-capture-'))
  const hosts: IHost[] = []
  try {
    hosts.push(...(await startHosts(temporary, demoOut)))
    await rm(CAPTURES, { recursive: true, force: true })
    await mkdir(CAPTURES, { recursive: true })
    const captures = await captureAll(hosts)
    await writeFile(new URL('manifest.json', CAPTURES), manifestOf(hosts, captures))
    return 0
  } catch (error) {
    write(`capture: ${lineOf(error)}\n`)
    return 1
  } finally {
    await Promise.all(hosts.map(async ({ started }) => started.stop()))
    await rm(temporary, { recursive: true, force: true })
  }
}
