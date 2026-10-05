import type { ICommandFile, ISessionScript, ScriptStep } from '@log-book/adapter-api/source-writer'

// Invented scripts fixture set 2.0 writes through the source writer: together they use every capability and family
// it declares except `dispatch` and `wait`, families only KNOWN_TOOLS names here, which no committed file may spell;
// the round trip builds those at test time.
const SHOP = '/home/example/work/shop'
const BILLING = '/home/example/work/billing'
const START = Date.UTC(2026, 2, 4, 9, 0, 0)

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
  endAt: at(seconds + 1),
  model: 'anthropic/claude-sonnet-5-5',
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

const CHILD: ISessionScript = {
  key: 'written-child',
  projectDir: SHOP,
  title: 'Find the coupon tests',
  agent: null,
  gitBranch: null,
  isScripted: false,
  harnessVersion: null,
  steps: [
    prompt('ch-p1', 27, 'find the coupon tests'),
    reply('ch-r1', 28, 'Looking in the test folder.', { model: 'anthropic/claude-haiku-4-5' }),
    call('ch-c1', 30, {
      family: 'read',
      intent: 'read',
      input: { path: `${SHOP}/test/checkout/discount.test.ts` },
      result: 'describe("discount")',
    }),
  ],
}

export const SCRIPTS: readonly ISessionScript[] = [
  {
    key: 'written-shop',
    projectDir: SHOP,
    title: 'Coupon validation',
    agent: 'build',
    gitBranch: null,
    isScripted: false,
    harnessVersion: null,
    steps: [
      prompt('p1', 0, 'here is the broken coupon box, fix the validation', 1),
      reply('r1', 1, 'Reading the form and its tests.', {
        endAt: at(3),
        reasoning: 'The validation lives in src/checkout/discount.ts.',
        tokens: { input: 1200, output: 80, reasoning: 30, cacheRead: 900, cacheWrite: 40 },
        cost: 0.0125,
      }),
      call('c1', 4, { family: 'shell', intent: 'run', input: { command: 'pnpm test' }, result: '24 passed' }),
      call('c2', 6, { family: 'read', intent: 'read', input: { path: `${SHOP}/src/checkout/discount.ts` } }),
      call('c3', 8, {
        family: 'edit',
        intent: 'edit',
        input: { path: `${SHOP}/src/checkout/discount.ts`, old: '0.1', new: 'rate' },
      }),
      call('c4', 10, {
        family: 'edit',
        intent: 'write',
        input: { path: `${SHOP}/src/checkout/rate.ts`, content: 'export const rate = 0.1' },
      }),
      call('c5', 12, {
        family: 'search',
        intent: 'text',
        input: { pattern: 'discount', path: `${SHOP}/src` },
        result: 'src/checkout/discount.ts',
      }),
      call('c6', 14, {
        family: 'search',
        intent: 'files',
        input: { pattern: '**/*.test.ts' },
        result: 'test/checkout/discount.test.ts',
      }),
      call('c7', 16, {
        family: 'web',
        intent: 'fetch',
        input: { url: 'https://example.com/coupons' },
        result: 'Coupons take a code.',
      }),
      call('c8', 18, {
        family: 'web',
        intent: 'search',
        input: { query: 'coupon code validation' },
        result: 'Three results.',
      }),
      call('c9', 20, {
        family: 'question',
        intent: 'ask',
        input: { question: 'Percent or fixed amount?' },
        result: 'Percent.',
      }),
      call('c10', 22, {
        family: 'other',
        tool: 'tracker_create_issue',
        input: { title: 'Coupon rounding' },
        status: 'error',
        result: 'The tracker is offline.',
      }),
      {
        kind: 'skill',
        key: 'k1',
        name: 'write-release-notes',
        text: 'Write release notes from the merged changes.',
        startAt: at(24),
        endAt: at(25),
      },
      {
        kind: 'spawn',
        key: 's1',
        agentType: 'explore',
        prompt: 'find the coupon tests',
        child: CHILD,
        result: 'In test/checkout.',
        startAt: at(26),
        endAt: at(40),
      },
      {
        kind: 'event',
        key: 'e1',
        at: at(41),
        event: { type: 'model-switch', model: 'openai/gpt-5.5', previous: 'anthropic/claude-sonnet-5-5' },
      },
      reply('r2', 42, 'Pushing the branch.', { model: 'openai/gpt-5.5' }),
      call('c11', 44, {
        family: 'shell',
        intent: 'run',
        input: { command: 'git push' },
        status: 'rejected',
        result: null,
        endAt: at(47),
      }),
      prompt('p2', 50, 'do not push until I ask'),
      reply('r3', 51, 'Understood. Planning the rest instead.', { model: 'openai/gpt-5.5' }),
      { kind: 'event', key: 'e2', at: at(53), event: { type: 'agent-switch', agent: 'plan' } },
      {
        kind: 'event',
        key: 'e3',
        at: at(54),
        event: { type: 'compaction', summary: 'The coupon validation was fixed; pushing waits.' },
      },
      {
        kind: 'event',
        key: 'e4',
        at: at(55),
        event: { type: 'failed-request', error: 'API Error: Connection dropped.' },
      },
      {
        kind: 'command',
        key: 'm1',
        at: at(60),
        name: 'review',
        arguments: 'the coupon change',
        body: 'Review the open changes of the shop and list what to fix first, most important first: $ARGUMENTS',
      },
      reply('r4', 61, 'Starting the review.', { model: 'openai/gpt-5.5' }),
      call('c12', 63, {
        family: 'shell',
        intent: 'run',
        input: { command: 'pnpm test' },
        status: 'pending',
        result: null,
        endAt: null,
      }),
      { kind: 'interrupt', key: 'i1', at: at(70) },
      { kind: 'event', key: 'e5', at: at(71), event: { type: 'idle', outcome: 'completed' } },
    ],
  },
  {
    key: 'written-billing',
    projectDir: BILLING,
    title: 'Late fee rounding',
    agent: 'build',
    gitBranch: null,
    isScripted: true,
    harnessVersion: '2.0.15',
    steps: [
      prompt('b-p1', 600, 'check the "late fee" rounding'),
      reply('b-r1', 601, 'Rounding is half up.'),
      call('b-c1', 603, {
        family: 'shell',
        intent: 'run',
        input: { command: 'pnpm test billing' },
        result: '8 passed',
      }),
      {
        kind: 'command',
        key: 'b-m1',
        at: at(610),
        name: 'release',
        arguments: 'billing',
        body: '---\ndescription: Release a project\n---\nRelease the project named in the arguments and report the version number it ships with: $ARGUMENTS\n',
      },
      reply('b-r2', 611, 'Released billing 1.4.0.'),
    ],
  },
]

// The command files the round trip writes beside the scripts: one global, one for the shop project.
export const COMMAND_FILES: readonly ICommandFile[] = [
  {
    name: 'release',
    body: '---\ndescription: Release a project\n---\nRelease the project named in the arguments and report the version number it ships with: $ARGUMENTS\n',
    projectDir: null,
  },
  {
    name: 'review',
    body: 'Review the open changes of the shop and list what to fix first, most important first: $ARGUMENTS\n',
    projectDir: SHOP,
  },
]
