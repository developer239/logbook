import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { npmModulePaths } from '../record-modules.mjs'

const ROOT = '/work/log-book'
const REPOSITORY = fileURLToPath(new URL('../../../', import.meta.url))
const RECORD = new URL('../build/modules.json', import.meta.url)

describe('npmModulePaths', () => {
  it('keeps the modules under node_modules, by their path from the repository root, and leaves out the rest', () => {
    // Act
    const paths = npmModulePaths(
      [
        `${ROOT}/node_modules/.pnpm/zod@4.6.5/node_modules/zod/v4/core/core.js`,
        `${ROOT}/apps/web/src/pages/index.astro`,
        `${ROOT}/packages/warehouse/dist/store.js`,
        '\0virtual:astro:middleware',
        'virtual:astro:routes',
      ],
      ROOT
    )

    // Assert
    expect(paths).toStrictEqual(['node_modules/.pnpm/zod@4.6.5/node_modules/zod/v4/core/core.js'])
  })

  it('cuts off a query, records a path two chunks share once, and sorts the paths', () => {
    // Act
    const paths = npmModulePaths(
      [
        `${ROOT}/node_modules/.pnpm/zod@4.6.5/node_modules/zod/index.js`,
        `${ROOT}/node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/index.js?commonjs-proxy`,
        `${ROOT}/node_modules/.pnpm/zod@4.6.5/node_modules/zod/index.js`,
      ],
      ROOT
    )

    // Assert
    expect(paths).toStrictEqual([
      'node_modules/.pnpm/debug@4.4.3/node_modules/debug/src/index.js',
      'node_modules/.pnpm/zod@4.6.5/node_modules/zod/index.js',
    ])
  })
})

describe('the record of the build the tests run on', () => {
  it("lists Astro's and the Node adapter's modules, each an existing path from the repository root", async () => {
    // Act
    const record = JSON.parse(await readFile(RECORD, 'utf8')) as { server: string[]; client: string[] }

    // Assert
    const paths = [...record.server, ...record.client]
    expect({
      keys: Object.keys(record),
      hasAstro: record.server.some((path) => path.includes('/node_modules/astro/')),
      hasNodeAdapter: record.server.some((path) => path.includes('/node_modules/@astrojs/node/')),
      outside: paths.filter(
        (path) => !path.startsWith('node_modules/') || path.includes('..') || !existsSync(`${REPOSITORY}${path}`)
      ),
    }).toStrictEqual({ keys: ['server', 'client'], hasAstro: true, hasNodeAdapter: true, outside: [] })
  })
})
