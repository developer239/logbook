import type { ScriptFamily } from '@log-book/adapter-api/source-writer'
import type { ShellFailure, ShellPurpose, ToolFailureCause } from '@log-book/engine'
import { PROJECTS, type ProjectName } from './projects.js'

// The labels a shell call stands for: its purpose, whether the engine's purpose rules settle it (else a model labels
// it), and how it failed.
export interface IShellLabels {
  purpose: ShellPurpose
  isRuleSettled: boolean
  failure: ShellFailure
}

// The cause a failed call outside the shell stands for, and whether the engine's cause rules settle it.
export interface IFailureLabels {
  cause: ToolFailureCause
  isRuleSettled: boolean
}

// A tool call as a script states it: a family, an intent with its neutral input keys, and a tool name only for `mcp`
// (with its server) and `other`. A failed call's result is its error text or its output's tail.
export interface IToolEntry {
  family: ScriptFamily
  intent: string | null
  tool: string | null
  server: string | null
  input: Readonly<Record<string, unknown>>
  status: 'completed' | 'error'
  result: string
  durationMs: number
  // On every shell call, and only there.
  shell: IShellLabels | null
  // On every failed call outside the shell, and only there.
  failure: IFailureLabels | null
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
  | 'git-push'
  | 'grep-code'
  | 'typecheck'
  | 'typecheck-missing'
  | 'open-pr'
  | 'wait-ci'
  | 'sed-edit'
  | 'heredoc-write'
  | 'jq-data'
  | 'run-script'
  | 'install'
  | 'install-denied'
  | 'curl-api'
  | 'curl-timeout'
  | 'open-docs'
  | 'test-typo'
  | 'tests-failing'
  | 'pytest-failing'
  | 'read-missing'
  | 'read-gone'
  | 'read-too-large'
  | 'read-secret'
  | 'edit-mismatch'
  | 'search-invalid'
  | 'search-fault'
  | 'tracker-unauthorized'
  | 'health-down'
  | 'health-up'
  | 'search-rate'
  | 'wait-cancelled'
  | 'render-missing'
  | 'fetch-empty'

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
  // The labels of the `claude -p` shell call that starts a scripted session.
  scriptedRun: IShellLabels
}

const SECOND_MS = 1000
const SEARCH_PHRASE = 'quantize skipped for zero-rated lines'

const call = (
  family: ScriptFamily,
  intent: string | null,
  input: Readonly<Record<string, unknown>>,
  result: string,
  durationMs: number
): IToolEntry => ({
  family,
  intent,
  tool: null,
  server: null,
  input,
  status: 'completed',
  result,
  durationMs,
  shell: null,
  failure: null,
})

const failed = (entry: IToolEntry, cause: ToolFailureCause, isRuleSettled: boolean, error: string): IToolEntry => ({
  ...entry,
  status: 'error',
  result: error,
  failure: { cause, isRuleSettled },
})

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

interface IShellSpec {
  command: string
  purpose: ShellPurpose
  isRuleSettled: boolean
  // `none` for a call that completed; otherwise the call failed and the result is its output's tail.
  failure: ShellFailure
  result: string
  durationMs: number
}

const shell = ({ command, purpose, isRuleSettled, failure, result, durationMs }: IShellSpec): IToolEntry => ({
  ...call('shell', 'run', { command }, result, durationMs),
  status: failure === 'none' ? 'completed' : 'error',
  shell: { purpose, isRuleSettled, failure },
})

const RULE_TESTS = { purpose: 'run tests', isRuleSettled: true, failure: 'none' } as const
const MODEL_TESTS = { purpose: 'run tests', isRuleSettled: false, failure: 'none' } as const
const GIT_STATE = { purpose: 'inspect git state', isRuleSettled: true, failure: 'none' } as const
const GIT_CHANGE = {
  purpose: 'change git (commit, push, branch, rebase)',
  isRuleSettled: true,
  failure: 'none',
} as const

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
      'run-tests': shell({
        ...RULE_TESTS,
        command: 'pnpm test',
        result:
          ' RUN  v4.1.0\n\n ✓ test/checkout/discount.test.ts (1 test) 3ms\n\n Test Files  1 passed (1)\n      Tests  1 passed (1)',
        durationMs: 4 * SECOND_MS,
      }),
      'run-tests-slow': shell({
        ...RULE_TESTS,
        command: 'pnpm test --coverage',
        result:
          ' ✓ test/checkout/discount.test.ts (1 test) 3ms\n\n Test Files  1 passed (1)\n % Coverage report from v8\n All files | 91.4 | 88.2',
        durationMs: 78 * SECOND_MS,
      }),
      'git-status': shell({
        ...GIT_STATE,
        command: 'git status --short',
        result: ' M src/checkout/discount.ts\n?? test/checkout/discount-code.test.ts',
        durationMs: 300,
      }),
      'git-diff': shell({
        ...GIT_STATE,
        command: 'git diff --stat main',
        result:
          ' src/checkout/checkout-form.tsx | 12 +++++++++---\n src/checkout/discount.ts      |  4 ++--\n 2 files changed, 11 insertions(+), 5 deletions(-)',
        durationMs: 300,
      }),
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
      'run-tests': shell({
        ...MODEL_TESTS,
        command: 'pytest -q',
        result: '.\n1 passed in 0.12s',
        durationMs: 3 * SECOND_MS,
      }),
      'run-tests-slow': shell({
        ...MODEL_TESTS,
        command: 'pytest -q --run-integration',
        result: '..........\n10 passed in 81.40s (0:01:21)',
        durationMs: 82 * SECOND_MS,
      }),
      'git-status': shell({
        ...GIT_STATE,
        command: 'git status --short',
        result: ' M billing/late_fees.py',
        durationMs: 300,
      }),
      'git-diff': shell({
        ...GIT_STATE,
        command: 'git diff --stat main',
        result: ' billing/rounding.py | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)',
        durationMs: 300,
      }),
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
      status: 'completed',
      result: 'BILL-42: The late fee is added twice when an invoice is paid after its due date.',
      durationMs: 900,
      shell: null,
      failure: null,
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
      status: 'completed',
      result: 'Started task-1.',
      durationMs: 1.5 * SECOND_MS,
      shell: null,
      failure: null,
    },
    'wait-check': call('wait', 'output', { task: 'task-1' }, 'task-1 finished: every test passed.', 40 * SECOND_MS),
    'other-tool': {
      family: 'other',
      intent: null,
      tool: 'render_diagram',
      server: null,
      input: { source: 'graph TD; cart --> checkout --> payment' },
      status: 'completed',
      result: 'Rendered 1 diagram.',
      durationMs: 1.2 * SECOND_MS,
      shell: null,
      failure: null,
    },
    'git-log': shell({
      ...GIT_STATE,
      command: 'git log --oneline v2.2.0..HEAD',
      result: 'a1b2c3d fix: round invoice lines half up\ne4f5a6b fix: add the late fee once',
      durationMs: 300,
    }),
    'git-tag': shell({
      ...GIT_CHANGE,
      command: 'git tag v2.3.0 && git push origin v2.3.0',
      result: ' * [new tag]         v2.3.0 -> v2.3.0',
      durationMs: 2 * SECOND_MS,
    }),
    'trace-drift': shell({
      ...MODEL_TESTS,
      command: 'pytest -q -k tax -s',
      result: `tax line 1: 0.125 -> 0.13\ntax line 2: 0.135 -> 0.14\ntax line 3: ${SEARCH_PHRASE}\n.\n1 passed in 0.10s`,
      durationMs: 3 * SECOND_MS,
    }),
    'git-push': shell({
      ...GIT_CHANGE,
      command: 'git push origin HEAD',
      result: 'To example.com:shop.git\n   4f2a1c9..8d3e0b7  HEAD -> feature/discount-codes',
      durationMs: 2 * SECOND_MS,
    }),
    'grep-code': shell({
      command: 'grep -rn "applyDiscount" src',
      purpose: 'read or search code',
      isRuleSettled: true,
      failure: 'none',
      result: 'src/checkout/discount.ts:6:export const applyDiscount = (total: number, discount: IDiscount): number =>',
      durationMs: 200,
    }),
    'typecheck': shell({
      command: 'pnpm typecheck',
      purpose: 'check a change (format, lint, typecheck, build)',
      isRuleSettled: true,
      failure: 'none',
      result: '> shop@ typecheck\n> tsc --noEmit',
      durationMs: 6 * SECOND_MS,
    }),
    'typecheck-missing': shell({
      command: 'pnpm typecheck',
      purpose: 'check a change (format, lint, typecheck, build)',
      isRuleSettled: true,
      failure: 'environment',
      result: '> shop@ typecheck\n> tsc --noEmit\n\nsh: tsc: command not found\n ELIFECYCLE  Command failed.',
      durationMs: 900,
    }),
    'open-pr': shell({
      command: 'gh pr create --fill',
      purpose: 'pull request or CI',
      isRuleSettled: true,
      failure: 'none',
      result: 'https://example.com/shop/pull/12',
      durationMs: 3 * SECOND_MS,
    }),
    'wait-ci': shell({
      command: 'sleep 30 && gh pr checks',
      purpose: 'wait for something',
      isRuleSettled: true,
      failure: 'none',
      result: 'test\tpass\t1m2s\nlint\tpass\t31s',
      durationMs: 31 * SECOND_MS,
    }),
    'sed-edit': shell({
      command: "sed -i '' 's/discount.percent/discount.rate/g' src/checkout/discount.ts",
      purpose: 'edit files',
      isRuleSettled: false,
      failure: 'none',
      result: '',
      durationMs: 200,
    }),
    'heredoc-write': shell({
      command: "cat > notes/tax-drift.md <<'EOF'\nThe third tax line is never rounded, so the total drifts.\nEOF",
      purpose: 'write files',
      isRuleSettled: false,
      failure: 'none',
      result: '',
      durationMs: 200,
    }),
    'jq-data': shell({
      command: "jq '.scripts' package.json",
      purpose: 'inspect a data file (json, yaml, logs)',
      isRuleSettled: false,
      failure: 'none',
      result: '{\n  "test": "vitest run",\n  "build": "vite build"\n}',
      durationMs: 200,
    }),
    'run-script': shell({
      command: 'python -m billing.reprice --dry-run',
      purpose: 'run a script or program',
      isRuleSettled: false,
      failure: 'none',
      result: 'Would reprice 14 invoices; 2 change by one cent.',
      durationMs: 2 * SECOND_MS,
    }),
    'install': shell({
      command: 'pnpm install',
      purpose: 'install or set up',
      isRuleSettled: true,
      failure: 'none',
      result: 'Lockfile is up to date, resolution step is skipped\nAlready up to date\nDone in 1.2s',
      durationMs: 2 * SECOND_MS,
    }),
    'install-denied': shell({
      command: 'pip install -e .',
      purpose: 'install or set up',
      isRuleSettled: false,
      failure: 'permission',
      result:
        "ERROR: Could not install packages due to an OSError: [Errno 13] Permission denied: '/home/example/.local/lib/python3.12'",
      durationMs: 3 * SECOND_MS,
    }),
    'curl-api': shell({
      command: 'curl -s http://localhost:5173/api/cart',
      purpose: 'query a service (http, database, cloud, docker)',
      isRuleSettled: true,
      failure: 'none',
      result: '{"lines":2,"items":3}',
      durationMs: 300,
    }),
    'curl-timeout': shell({
      command: 'curl -s --max-time 30 http://localhost:5173/api/cart',
      purpose: 'query a service (http, database, cloud, docker)',
      isRuleSettled: true,
      failure: 'timeout',
      result: 'curl: (28) Operation timed out after 30001 milliseconds with 0 bytes received',
      durationMs: 30 * SECOND_MS,
    }),
    'open-docs': shell({
      command: 'open http://localhost:8000/docs',
      purpose: 'other',
      isRuleSettled: false,
      failure: 'none',
      result: '',
      durationMs: 300,
    }),
    'test-typo': shell({
      command: 'pnpm tset',
      purpose: 'run tests',
      isRuleSettled: false,
      failure: 'command mistake',
      result: ' ERR_PNPM_NO_SCRIPT  Missing script: tset\n\nCommand "tset" not found. Did you mean "pnpm run test"?',
      durationMs: 600,
    }),
    'tests-failing': shell({
      command: 'pnpm test',
      purpose: 'run tests',
      isRuleSettled: true,
      failure: 'real result',
      result:
        ' FAIL  test/checkout/discount-code.test.ts > caps a code at the full price\nAssertionError: expected -10 to be 0\n\n Test Files  1 failed | 1 passed (2)',
      durationMs: 4 * SECOND_MS,
    }),
    'pytest-failing': shell({
      command: 'pytest -q',
      purpose: 'run tests',
      isRuleSettled: false,
      failure: 'real result',
      result:
        "F.\nFAILED tests/test_invoice.py::test_rounds_half_up - assert Decimal('0.12') == Decimal('0.13')\n1 failed, 1 passed in 0.14s",
      durationMs: 3 * SECOND_MS,
    }),
    'read-missing': failed(
      call('read', 'read', { path: pathIn('shop', 'src/cart/cart-badge.ts') }, '', 200),
      'missing target',
      true,
      'File does not exist.'
    ),
    'read-gone': failed(
      call('read', 'read', { path: pathIn('shop', 'src/cart/cart-summary.tsx') }, '', 200),
      'missing target',
      false,
      'That path points to nothing in this checkout.'
    ),
    'read-too-large': failed(
      call('read', 'read', { path: pathIn('billing', 'tests/fixtures/invoices.json') }, '', 300),
      'output too large',
      true,
      'File content (48210 tokens) exceeds maximum allowed tokens (25000). Read part of it with an offset and a limit.'
    ),
    'read-secret': failed(
      call('read', 'read', { path: pathIn('billing', '.env') }, '', 100),
      'rejected',
      true,
      'Reading .env is blocked by a rule which prevents you from reading secret files.'
    ),
    'edit-mismatch': failed(
      call(
        'edit',
        'edit',
        {
          path: pathIn('billing', 'billing/late_fees.py'),
          old: 'return total + LATE_FEE  if days_late > 0',
          new: 'return total + LATE_FEE if days_late > 0 and not total.is_charged',
        },
        '',
        300
      ),
      'edit mismatch',
      true,
      'String to replace not found in file.'
    ),
    'search-invalid': failed(
      call('search', 'text', { pattern: 'round_cents(', path: PROJECTS.billing.directory }, '', 200),
      'invalid call',
      true,
      'regex parse error: unclosed group'
    ),
    'search-fault': failed(
      call('search', 'files', { pattern: 'src/**/*.tsx' }, '', 200),
      'tool fault',
      true,
      'ripgrep execution failed: exit status 2'
    ),
    'tracker-unauthorized': failed(
      {
        family: 'mcp',
        intent: null,
        tool: 'get_issue',
        server: 'tracker',
        input: { key: 'BILL-42' },
        status: 'completed',
        result: '',
        durationMs: 400,
        shell: null,
        failure: null,
      },
      'auth',
      true,
      'Unauthorized: the tracker token is invalid or expired.'
    ),
    'health-down': failed(
      call('web', 'fetch', { url: 'http://localhost:5173/health' }, '', 300),
      'service unreachable',
      true,
      'connect ECONNREFUSED 127.0.0.1:5173'
    ),
    'health-up': call('web', 'fetch', { url: 'http://localhost:5173/health' }, 'ok', 300),
    'search-rate': failed(
      call('web', 'search', { query: 'invoice tax rounding per line or per total' }, '', 500),
      'rate limited',
      true,
      'Rate limit reached for web search, try again in 30 seconds.'
    ),
    'wait-cancelled': failed(
      call('wait', 'output', { task: 'task-2' }, '', 5 * SECOND_MS),
      'aborted',
      true,
      'Task cancelled before it finished.'
    ),
    'render-missing': failed(
      {
        family: 'other',
        intent: null,
        tool: 'render_diagram',
        server: null,
        input: { source: 'graph TD; cart --> checkout --> payment' },
        status: 'completed',
        result: '',
        durationMs: 300,
        shell: null,
        failure: null,
      },
      'environment',
      true,
      "Executable doesn't exist at /home/example/.cache/render/bin/render"
    ),
    'fetch-empty': failed(
      call('web', 'fetch', { url: 'https://example.com/tax/rates-2026' }, '', 900),
      'other',
      false,
      'The page answered with an empty body.'
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
  scriptedRun: { purpose: 'run a script or program', isRuleSettled: false, failure: 'none' },
}
