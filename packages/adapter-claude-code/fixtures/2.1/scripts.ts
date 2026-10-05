import type { ICommandFile, ISessionScript, ScriptStep } from '@log-book/adapter-api/source-writer'

// Invented scripts for the units fixture set 2.1 writes through the source writer: together they use every
// capability and family it declares except `dispatch`, a family only KNOWN_TOOLS names, which no committed file may
// spell; the round trip builds that one at test time.
const SHOP = '/home/example/work/shop'
const BILLING = '/home/example/work/billing'
const START = Date.UTC(2026, 2, 3, 10, 0, 0)

const at = (seconds: number): number => START + seconds * 1000

type TCall = Extract<ScriptStep, { kind: 'call' }>

const call = (key: string, seconds: number, fields: Pick<TCall, 'family' | 'input'> & Partial<TCall>): TCall => ({
  kind: 'call',
  key,
  intent: null,
  tool: null,
  server: null,
  status: 'completed',
  result: 'done',
  startAt: at(seconds),
  endAt: at(seconds + 1),
  ...fields,
})

const reply = (
  key: string,
  seconds: number,
  text: string | null,
  fields: Partial<Extract<ScriptStep, { kind: 'reply' }>> = {}
): ScriptStep => ({
  kind: 'reply',
  key,
  at: at(seconds),
  endAt: at(seconds + 2),
  model: 'claude-sonnet-5-5',
  text,
  reasoning: null,
  tokens: null,
  cost: null,
  ...fields,
})

const prompt = (key: string, seconds: number, text: string, images = 0): ScriptStep => ({
  kind: 'prompt',
  key,
  at: at(seconds),
  text,
  images,
})

const GRANDCHILD: ISessionScript = {
  key: 'written-grandchild',
  projectDir: SHOP,
  title: null,
  agent: null,
  gitBranch: 'feature/discount-codes',
  isScripted: false,
  harnessVersion: null,
  steps: [
    prompt('gc-p1', 302, 'find the coupon tests'),
    reply('gc-r1', 303, 'In test/checkout/discount.test.ts.', { model: 'claude-haiku-4-5' }),
  ],
}

const CHILD: ISessionScript = {
  key: 'written-child',
  projectDir: SHOP,
  title: null,
  agent: null,
  gitBranch: 'feature/discount-codes',
  isScripted: false,
  harnessVersion: null,
  steps: [
    prompt('ch-p1', 300, 'review the coupon change'),
    reply('ch-r1', 300, 'Looking for its tests first.'),
    {
      kind: 'spawn',
      key: 'ch-s1',
      agentType: 'Explore',
      prompt: 'find the coupon tests',
      child: GRANDCHILD,
      result: 'In test/checkout/discount.test.ts.',
      startAt: at(302),
      endAt: at(310),
    },
    reply('ch-r2', 311, 'The change is covered by its tests.'),
  ],
}

export const SCRIPTS: readonly ISessionScript[] = [
  {
    key: 'written-shop',
    projectDir: SHOP,
    title: 'Coupon validation',
    agent: null,
    gitBranch: 'feature/discount-codes',
    isScripted: false,
    harnessVersion: null,
    steps: [
      prompt('p1', 0, 'here is the broken coupon box, fix the validation', 1),
      {
        kind: 'event',
        key: 'e1',
        at: at(1),
        event: {
          type: 'tools-offered',
          added: ['create_issue', 'search_docs'],
          removed: [],
          failedServers: [{ name: 'wiki', error: 'connection refused' }],
        },
      },
      reply('r1', 2, 'Reading the form and its tests.', {
        reasoning: 'The validation lives in src/checkout/discount.ts.',
        tokens: { input: 1200, output: 80, reasoning: 30, cacheRead: 900, cacheWrite: 40 },
      }),
      call('c1', 4, {
        family: 'read',
        intent: 'read',
        input: { path: `${SHOP}/src/checkout/discount.ts` },
        result: 'export const discount = 0.1',
      }),
      call('c2', 6, {
        family: 'search',
        intent: 'text',
        input: { pattern: 'discount', path: `${SHOP}/src` },
        result: 'src/checkout/discount.ts',
      }),
      call('c3', 8, {
        family: 'search',
        intent: 'files',
        input: { pattern: '**/*.test.ts' },
        result: 'test/checkout/discount.test.ts',
      }),
      call('c4', 10, {
        family: 'edit',
        intent: 'edit',
        input: { path: `${SHOP}/src/checkout/discount.ts`, old: '0.1', new: 'rate' },
        result: 'The file was updated.',
      }),
      call('c5', 12, {
        family: 'edit',
        intent: 'write',
        input: { path: `${SHOP}/src/checkout/rate.ts`, content: 'export const rate = 0.1' },
        result: 'File created.',
      }),
      call('c6', 14, {
        family: 'shell',
        intent: 'run',
        input: { command: 'pnpm test' },
        result: 'All 24 tests passed.',
      }),
      call('c7', 16, {
        family: 'mcp',
        tool: 'create_issue',
        server: 'tracker',
        input: { title: 'Coupon rounding' },
        result: 'Created issue 12.',
      }),
      {
        kind: 'skill',
        key: 'k1',
        name: 'write-release-notes',
        text: 'Write release notes from the merged changes, newest first.',
        startAt: at(18),
        endAt: at(19),
      },
      reply('r2', 20, 'Pushing the branch.'),
      call('c8', 22, {
        family: 'shell',
        intent: 'run',
        input: { command: 'git push' },
        status: 'rejected',
        result: null,
        endAt: at(25),
      }),
      prompt('p2', 30, 'do not push until I ask'),
      reply('r3', 31, 'Understood. Checking the docs instead.'),
      call('c9', 33, {
        family: 'web',
        intent: 'fetch',
        input: { url: 'https://example.com/coupons' },
        result: 'Coupons take a code.',
      }),
      call('c10', 35, {
        family: 'web',
        intent: 'search',
        input: { query: 'coupon code validation' },
        result: 'Three results.',
      }),
      call('c11', 37, {
        family: 'todo',
        intent: 'update',
        input: { items: [{ content: 'validate codes', status: 'in_progress' }] },
        result: 'Todos updated.',
      }),
      call('c12', 39, {
        family: 'question',
        intent: 'ask',
        input: { question: 'Percent or fixed amount?' },
        result: 'Percent.',
      }),
      call('c13', 41, {
        family: 'tool-search',
        intent: 'load',
        input: { query: 'select:search_docs' },
        result: 'Loaded search_docs.',
      }),
      call('c14', 43, { family: 'wait', intent: 'output', input: { task: 'bash_1' }, result: 'build finished' }),
      call('c15', 45, {
        family: 'other',
        tool: 'ExitPlanMode',
        input: { plan: 'Validate, then test.' },
        status: 'error',
        result: 'Plan mode is not active.',
      }),
      {
        kind: 'event',
        key: 'e2',
        at: at(47),
        event: {
          type: 'tools-loaded',
          tools: [{ name: 'search_docs', description: 'Search the docs.', inputSchema: { type: 'object' } }],
        },
      },
      { kind: 'command', key: 'm1', at: at(50), name: 'review', arguments: 'the coupon change', body: null },
      reply('r4', 51, 'Starting a review.'),
      {
        kind: 'spawn',
        key: 's1',
        agentType: 'general-purpose',
        prompt: 'review the coupon change',
        child: CHILD,
        result: 'The change is covered by its tests.',
        startAt: at(53),
        endAt: at(320),
      },
      {
        kind: 'event',
        key: 'e3',
        at: at(330),
        event: { type: 'compaction', summary: 'The coupon validation was fixed and reviewed.' },
      },
      {
        kind: 'event',
        key: 'e4',
        at: at(331),
        event: { type: 'failed-request', error: 'API Error: Connection dropped.' },
      },
      reply('r5', 332, 'Running the tests once more.'),
      call('c16', 334, {
        family: 'shell',
        intent: 'run',
        input: { command: 'pnpm test' },
        status: 'pending',
        result: null,
        endAt: null,
      }),
      { kind: 'interrupt', key: 'i1', at: at(340) },
    ],
  },
  {
    key: 'written-billing',
    projectDir: BILLING,
    title: null,
    agent: null,
    gitBranch: 'fix/invoice-rounding',
    isScripted: true,
    harnessVersion: '2.1.300',
    steps: [
      prompt('b-p1', 600, 'summarise the open invoice bugs'),
      reply('b-r1', 601, 'Listing them.'),
      call('b-c1', 603, {
        family: 'shell',
        intent: 'run',
        input: { command: 'gh issue list' },
        result: 'rounding, late fee',
      }),
      { kind: 'command', key: 'b-m1', at: at(610), name: 'deploy', arguments: 'staging', body: null },
    ],
  },
]

// The command files the round trip writes beside the scripts: one global, one for the shop project.
export const COMMAND_FILES: readonly ICommandFile[] = [
  {
    name: 'review',
    body: 'Review the open changes and list what to fix first, most important first.',
    projectDir: null,
  },
  {
    name: 'deploy',
    body: 'Deploy the shop to the staging environment and report the release number: $ARGUMENTS',
    projectDir: SHOP,
  },
]
