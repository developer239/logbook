import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// The Vite environments whose output ships in dist/, by the key the record lists them under. The prerender
// environment only renders pages during the build, and Astro deletes its output, so nothing of it is recorded.
/** @type {Readonly<Partial<Record<string, 'server' | 'client'>>>} */
const SHIPPED = { ssr: 'server', client: 'client' }
const NODE_MODULES = /(?:^|\/)node_modules\//u
const RECORD = './build/modules.json'

/**
 * The npm modules among a build's module ids, as paths from the repository root with `/` separators, each once and
 * sorted: an id whose file lies under a node_modules directory, its query cut off. App sources, workspace packages,
 * which pnpm links outside node_modules, and virtual modules are left out.
 *
 * @param {readonly string[]} moduleIds
 * @param {string} repositoryRoot
 * @returns {string[]}
 */
export const npmModulePaths = (moduleIds, repositoryRoot) =>
  [
    ...new Set(
      moduleIds
        .filter((id) => !id.startsWith('\0') && !id.startsWith('virtual:'))
        .map((id) => id.split('?')[0] ?? id)
        .filter((path) => isAbsolute(path))
        .map((path) => relative(repositoryRoot, path).split(sep).join('/'))
        .filter((path) => !path.startsWith('../') && NODE_MODULES.test(path))
    ),
  ].toSorted()

/**
 * Writes apps/web/build/modules.json on every `astro build`: the npm modules the build inlined into what ships, so the
 * CLI's stage can write their notices. It sits outside dist/, so it never ships; `astro dev` writes nothing.
 *
 * @returns {import('astro').AstroIntegration}
 */
export const recordModules = () => {
  /** @type {Record<'server' | 'client', Set<string>>} */
  const collected = { server: new Set(), client: new Set() }
  let appRoot = new URL('./', import.meta.url)

  return {
    name: 'log-book-record-modules',
    hooks: {
      'astro:config:setup': ({ command, config, updateConfig }) => {
        if (command !== 'build') {
          return
        }
        appRoot = config.root
        updateConfig({
          vite: {
            plugins: [
              {
                name: 'log-book-record-modules',
                /** @param {unknown} _options @param {Record<string, { type: string; moduleIds?: readonly string[] }>} bundle */
                generateBundle(_options, bundle) {
                  /** @type {{ environment?: { name: string } }} */
                  const context = this
                  const key = SHIPPED[context.environment?.name ?? '']
                  if (key === undefined) {
                    return
                  }
                  for (const output of Object.values(bundle)) {
                    if (output.type === 'chunk') {
                      for (const id of output.moduleIds ?? []) {
                        collected[key].add(id)
                      }
                    }
                  }
                },
              },
            ],
          },
        })
      },
      'astro:build:done': async () => {
        const repositoryRoot = fileURLToPath(new URL('../../', appRoot))
        const record = {
          server: npmModulePaths([...collected.server], repositoryRoot),
          client: npmModulePaths([...collected.client], repositoryRoot),
        }
        const file = new URL(RECORD, appRoot)
        await mkdir(new URL('./', file), { recursive: true })
        await writeFile(file, `${JSON.stringify(record, null, 2)}\n`)
      },
    },
  }
}
