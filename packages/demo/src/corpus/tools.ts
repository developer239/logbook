import type { ScriptFamily } from '@log-book/adapter-api/source-writer'
import { PROJECTS, type ProjectName } from './projects.js'

// A tool call as a script states it: a family, an intent with its neutral input keys, and a tool name only for `mcp`
// (with its server) and `other`.
export interface IToolEntry {
  family: ScriptFamily
  intent: string | null
  tool: string | null
  server: string | null
  input: Readonly<Record<string, unknown>>
  result: string
  durationMs: number
}

interface ILoadedTool {
  name: string
  description: string
  inputSchema: unknown
}

interface ISkillEntry {
  text: string
  durationMs: number
}

export type ProjectToolName =
  | 'read-source'
  | 'read-test'
  | 'edit-source'
  | 'write-test'
  | 'write-doc'
  | 'find-files'
  | 'search-text'
  | 'run-tests'
  | 'run-tests-slow'
  | 'git-status'
  | 'git-diff'
  | 'web-search'

export type SharedToolName =
  | 'web-fetch'
  | 'update-todos'
  | 'load-tools'
  | 'tracker-issue'
  | 'ask-human'
  | 'dispatch-check'
  | 'wait-check'
  | 'other-tool'
  | 'git-log'
  | 'git-tag'
  | 'trace-drift'

export type SkillName = 'review-checklist' | 'write-release-notes'

export interface IToolCorpus {
  project: Readonly<Record<ProjectName, Readonly<Record<ProjectToolName, IToolEntry>>>>
  shared: Readonly<Record<SharedToolName, IToolEntry>>
  // What a tool search loads, recorded as a tools-loaded event where the writer declares it.
  loaded: readonly ILoadedTool[]
  // The tools offered at the start of a session, one server failing to start.
  offered: {
    added: readonly string[]
    removed: readonly string[]
    failedServers: readonly { name: string; error: string }[]
  }
  skills: Readonly<Record<SkillName, ISkillEntry>>
  // The server a dispatch tool sits behind, for a writer that declares `mcp-server`.
  dispatchServer: string
  // Occurs in exactly one tool output of the small set.
  searchPhrase: string
}

const SECOND_MS = 1000
const SEARCH_PHRASE = 'quantize skipped for zero-rated lines'

const call = (
  family: ScriptFamily,
  intent: string | null,
  input: Readonly<Record<string, unknown>>,
  result: string,
  durationMs: number
): IToolEntry => ({ family, intent, tool: null, server: null, input, result, durationMs })

const pathIn = (project: ProjectName, path: string): string => `${PROJECTS[project].directory}/${path}`

const contentOf = (project: ProjectName, path: string): string => {
  const file = PROJECTS[project].files.find((candidate) => candidate.path === path)
  if (file === undefined) {
    throw new Error(`No file ${path} in ${project}`)
  }
  return file.content
}

const read = (project: ProjectName, path: string): IToolEntry =>
  call('read', 'read', { path: pathIn(project, path) }, contentOf(project, path), 0.4 * SECOND_MS)

const edit = (project: ProjectName, path: string, old: string, replacement: string): IToolEntry => {
  if (!contentOf(project, path).includes(old)) {
    throw new Error(`The edit of ${path} in ${project} replaces text the file does not hold`)
  }
  return call(
    'edit',
    'edit',
    { path: pathIn(project, path), old, new: replacement },
    `Edited ${path}.`,
    0.6 * SECOND_MS
  )
}

const write = (project: ProjectName, path: string, content: string): IToolEntry =>
  call('edit', 'write', { path: pathIn(project, path), content }, `Wrote ${path}.`, 0.5 * SECOND_MS)

const shell = (command: string, result: string, durationMs: number): IToolEntry =>
  call('shell', 'run', { command }, result, durationMs)

export const TOOLS: IToolCorpus = {
  project: {
    shop: {
      'read-source': read('shop', 'src/checkout/discount.ts'),
      'read-test': read('shop', 'test/checkout/discount.test.ts'),
      'edit-source': edit(
        'shop',
        'src/checkout/discount.ts',
        'Math.round(total * (100 - discount.percent)) / 100',
        'Math.round(total * (100 - Math.min(discount.percent, 100))) / 100'
      ),
      'write-test': write(
        'shop',
        'test/checkout/discount-code.test.ts',
        "import { expect, it } from 'vitest'\nimport { applyDiscount } from '../../src/checkout/discount'\n\nit('caps a code at the full price', () => {\n  expect(applyDiscount(50, { code: 'ALL', percent: 120 })).toBe(0)\n})\n"
      ),
      'write-doc': write(
        'shop',
        'docs/gift-card-flow.md',
        '# Gift cards\n\n1. The buyer picks an amount.\n2. The code is sent by email.\n3. Checkout takes the code like a discount code.\n'
      ),
      'find-files': call('search', 'files', { pattern: 'test/**/*.test.ts' }, 'test/checkout/discount.test.ts', 300),
      'search-text': call(
        'search',
        'text',
        { pattern: 'applyDiscount', path: PROJECTS.shop.directory },
        "src/checkout/discount.ts:6:export const applyDiscount = (total: number, discount: IDiscount): number =>\ntest/checkout/discount.test.ts:2:import { applyDiscount } from '../../src/checkout/discount'",
        400
      ),
      'run-tests': shell(
        'pnpm test',
        ' RUN  v4.1.0\n\n ✓ test/checkout/discount.test.ts (1 test) 3ms\n\n Test Files  1 passed (1)\n      Tests  1 passed (1)',
        4 * SECOND_MS
      ),
      'run-tests-slow': shell(
        'pnpm test --coverage',
        ' ✓ test/checkout/discount.test.ts (1 test) 3ms\n\n Test Files  1 passed (1)\n % Coverage report from v8\n All files | 91.4 | 88.2',
        78 * SECOND_MS
      ),
      'git-status': shell(
        'git status --short',
        ' M src/checkout/discount.ts\n?? test/checkout/discount-code.test.ts',
        300
      ),
      'git-diff': shell(
        'git diff --stat main',
        ' src/checkout/checkout-form.tsx | 12 +++++++++---\n src/checkout/discount.ts      |  4 ++--\n 2 files changed, 11 insertions(+), 5 deletions(-)',
        300
      ),
      'web-search': call(
        'web',
        'search',
        { query: 'accessible discount code field in a checkout form' },
        '1. Form fields that explain their errors - https://example.com/forms/errors\n2. Discount codes at checkout - https://example.org/checkout/codes',
        2 * SECOND_MS
      ),
    },
    billing: {
      'read-source': read('billing', 'billing/rounding.py'),
      'read-test': read('billing', 'tests/test_invoice.py'),
      'edit-source': edit(
        'billing',
        'billing/late_fees.py',
        'return total + LATE_FEE if days_late > 0 else total',
        'return total if days_late <= 0 or total.has_late_fee else total + LATE_FEE'
      ),
      'write-test': write(
        'billing',
        'tests/test_late_fees.py',
        'from decimal import Decimal\n\nfrom billing.late_fees import with_late_fee\n\n\ndef test_adds_the_fee_once():\n    assert with_late_fee(Decimal("10.00"), 3) == Decimal("15.00")\n'
      ),
      'write-doc': write(
        'billing',
        'CHANGELOG.md',
        '## 2.3.0\n\n- Invoice totals round half up on every line.\n- The late fee is added once.\n'
      ),
      'find-files': call('search', 'files', { pattern: 'tests/test_*.py' }, 'tests/test_invoice.py', 300),
      'search-text': call(
        'search',
        'text',
        { pattern: 'round_cents', path: PROJECTS.billing.directory },
        'billing/invoice.py:3:from billing.rounding import round_cents\nbilling/rounding.py:4:def round_cents(amount: Decimal) -> Decimal:',
        400
      ),
      'run-tests': shell('pytest -q', '.\n1 passed in 0.12s', 3 * SECOND_MS),
      'run-tests-slow': shell(
        'pytest -q --run-integration',
        '..........\n10 passed in 81.40s (0:01:21)',
        82 * SECOND_MS
      ),
      'git-status': shell('git status --short', ' M billing/late_fees.py', 300),
      'git-diff': shell(
        'git diff --stat main',
        ' billing/rounding.py | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)',
        300
      ),
      'web-search': call(
        'web',
        'search',
        { query: 'python decimal quantize round half up cents' },
        '1. Rounding money with decimal - https://example.com/python/decimal-rounding\n2. Half up or half even - https://example.org/money/rounding',
        2 * SECOND_MS
      ),
    },
  },
  shared: {
    'web-fetch': call(
      'web',
      'fetch',
      { url: 'https://example.com/python/decimal-rounding' },
      'Rounding money with decimal. Quantize to two places with ROUND_HALF_UP to match most invoices.',
      2 * SECOND_MS
    ),
    'update-todos': call(
      'todo',
      'update',
      {
        items: [
          { content: 'Add the discount code field', status: 'in_progress' },
          { content: 'Cover the field with a test', status: 'pending' },
        ],
      },
      'Todos updated.',
      100
    ),
    'load-tools': call('tool-search', 'load', { query: 'tracker issue' }, 'Loaded get_issue.', 500),
    'tracker-issue': {
      family: 'mcp',
      intent: null,
      tool: 'get_issue',
      server: 'tracker',
      input: { key: 'BILL-42' },
      result: 'BILL-42: The late fee is added twice when an invoice is paid after its due date.',
      durationMs: 900,
    },
    'ask-human': call(
      'question',
      'ask',
      { question: 'Should the old behaviour stay behind a flag, or go?' },
      'Replace it, no flag.',
      48 * SECOND_MS
    ),
    'dispatch-check': {
      family: 'dispatch',
      intent: null,
      tool: null,
      server: null,
      input: { prompt: 'run the full test suite on a clean checkout and report any failure' },
      result: 'Started task-1.',
      durationMs: 1.5 * SECOND_MS,
    },
    'wait-check': call('wait', 'output', { task: 'task-1' }, 'task-1 finished: every test passed.', 40 * SECOND_MS),
    'other-tool': {
      family: 'other',
      intent: null,
      tool: 'render_diagram',
      server: null,
      input: { source: 'graph TD; cart --> checkout --> payment' },
      result: 'Rendered 1 diagram.',
      durationMs: 1.2 * SECOND_MS,
    },
    'git-log': shell(
      'git log --oneline v2.2.0..HEAD',
      'a1b2c3d fix: round invoice lines half up\ne4f5a6b fix: add the late fee once',
      300
    ),
    'git-tag': shell(
      'git tag v2.3.0 && git push origin v2.3.0',
      ' * [new tag]         v2.3.0 -> v2.3.0',
      2 * SECOND_MS
    ),
    'trace-drift': shell(
      'pytest -q -k tax -s',
      `tax line 1: 0.125 -> 0.13\ntax line 2: 0.135 -> 0.14\ntax line 3: ${SEARCH_PHRASE}\n.\n1 passed in 0.10s`,
      3 * SECOND_MS
    ),
  },
  loaded: [
    {
      name: 'get_issue',
      description: 'Read one tracker issue by its key.',
      inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    },
  ],
  offered: {
    added: ['get_issue', 'list_issues', 'create_issue'],
    removed: [],
    failedServers: [{ name: 'calendar', error: 'connection refused' }],
  },
  skills: {
    'review-checklist': {
      text: 'Check each change for a test, clear names and handled errors before approving it.',
      durationMs: 800,
    },
    'write-release-notes': {
      text: 'Write release notes from the merged changes, newest first, one line per change.',
      durationMs: 800,
    },
  },
  dispatchServer: 'helpers',
  searchPhrase: SEARCH_PHRASE,
}
