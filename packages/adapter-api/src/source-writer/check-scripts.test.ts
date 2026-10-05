import { describe, expect, it } from 'vitest'
import { TOOL_FAMILIES } from '../tool-families.js'
import {
  checkCommandFiles,
  checkScripts,
  projectDirIn,
  SOURCE_CAPABILITIES,
  SOURCE_WRITER_ERROR_CODES,
  type ISessionScript,
  type ScriptFamily,
  type ScriptStep,
} from './index.js'

const TESTED = ['2.1']
const FAMILIES: ReadonlySet<ScriptFamily> = new Set<ScriptFamily>([
  ...TOOL_FAMILIES.filter(
    (family): family is Exclude<(typeof TOOL_FAMILIES)[number], 'subagent' | 'skill'> =>
      family !== 'subagent' && family !== 'skill'
  ),
  'mcp',
])
const EVERYTHING = { capabilities: new Set(SOURCE_CAPABILITIES), families: FAMILIES }
const TOKENS = { input: 1200, output: 80, reasoning: null, cacheRead: 900, cacheWrite: 0 }

const CHILD: ISessionScript = {
  key: 'child',
  projectDir: '/home/example/work/shop',
  title: null,
  agent: null,
  gitBranch: null,
  isScripted: false,
  harnessVersion: null,
  steps: [
    { kind: 'prompt', key: 'child-p1', at: 1_720, text: 'find where the cart total is computed', images: 0 },
    {
      kind: 'reply',
      key: 'child-r1',
      at: 1_730,
      endAt: 1_800,
      model: 'claude-haiku-4-5',
      text: 'In cart-total.ts.',
      reasoning: null,
      tokens: null,
      cost: null,
    },
  ],
}

// Every step kind and every event, valid for a writer that declares everything.
const VALID: ISessionScript = {
  key: 'shop-1',
  projectDir: '/home/example/work/shop',
  title: 'Add a discount code field',
  agent: 'build',
  gitBranch: 'feature/discount-codes',
  isScripted: true,
  harnessVersion: '2.1.286',
  steps: [
    { kind: 'prompt', key: 'p1', at: 1_000, text: 'add a discount code field to checkout', images: 1 },
    {
      kind: 'reply',
      key: 'r1',
      at: 1_100,
      endAt: 1_500,
      model: 'claude-sonnet-5-5',
      text: 'Reading the checkout form first.',
      reasoning: 'The form lives under src/checkout.',
      tokens: TOKENS,
      cost: 0.01,
    },
    {
      kind: 'call',
      key: 'c1',
      family: 'read',
      intent: 'read',
      tool: null,
      server: null,
      input: { path: '/home/example/work/shop/src/checkout/checkout-form.tsx' },
      status: 'completed',
      result: 'export const CheckoutForm = () => null',
      startAt: 1_500,
      endAt: 1_550,
    },
    {
      kind: 'call',
      key: 'c2',
      family: 'mcp',
      intent: null,
      tool: 'search_docs',
      server: 'docs',
      input: { query: 'discount codes' },
      status: 'error',
      result: 'The docs server timed out.',
      startAt: 1_550,
      endAt: 1_600,
    },
    {
      kind: 'skill',
      key: 'k1',
      name: 'testing',
      text: 'Run the tests before saying done.',
      startAt: 1_600,
      endAt: 1_610,
    },
    {
      kind: 'spawn',
      key: 's1',
      agentType: 'explore',
      prompt: 'find where the cart total is computed',
      child: CHILD,
      result: 'In cart-total.ts.',
      startAt: 1_700,
      endAt: 1_850,
    },
    { kind: 'event', key: 'e1', at: 1_900, event: { type: 'compaction', summary: 'Working on the discount field.' } },
    { kind: 'command', key: 'm1', at: 2_000, name: 'release', arguments: 'shop', body: null },
    {
      kind: 'reply',
      key: 'r2',
      at: 2_100,
      endAt: 2_200,
      model: 'claude-sonnet-5-5',
      text: null,
      reasoning: 'Pushing the release branch.',
      tokens: null,
      cost: null,
    },
    {
      kind: 'call',
      key: 'c3',
      family: 'shell',
      intent: 'run',
      tool: null,
      server: null,
      input: { command: 'git push' },
      status: 'rejected',
      result: null,
      startAt: 2_200,
      endAt: 2_300,
    },
    { kind: 'interrupt', key: 'i1', at: 2_400 },
    { kind: 'command', key: 'm2', at: 2_500, name: 'review', arguments: 'the diff', body: 'Review the diff.' },
    {
      kind: 'event',
      key: 'e2',
      at: 2_600,
      event: { type: 'model-switch', model: 'claude-opus-5-5', previous: 'claude-sonnet-5-5' },
    },
    {
      kind: 'reply',
      key: 'r3',
      at: 2_700,
      endAt: 2_800,
      model: 'claude-opus-5-5',
      text: 'Running the tests.',
      reasoning: null,
      tokens: null,
      cost: null,
    },
    {
      kind: 'call',
      key: 'c4',
      family: 'shell',
      intent: 'run',
      tool: null,
      server: null,
      input: { command: 'pnpm test' },
      status: 'pending',
      result: null,
      startAt: 2_800,
      endAt: null,
    },
    { kind: 'event', key: 'e3', at: 2_900, event: { type: 'failed-request', error: 'Connection dropped.' } },
    { kind: 'event', key: 'e4', at: 3_000, event: { type: 'agent-switch', agent: 'plan' } },
    { kind: 'event', key: 'e5', at: 3_100, event: { type: 'idle', outcome: 'done' } },
    {
      kind: 'event',
      key: 'e6',
      at: 3_200,
      event: {
        type: 'tools-offered',
        added: ['search_docs'],
        removed: [],
        failedServers: [{ name: 'tickets', error: 'refused' }],
      },
    },
    {
      kind: 'event',
      key: 'e7',
      at: 3_300,
      event: {
        type: 'tools-loaded',
        tools: [{ name: 'search_docs', description: 'Search the docs.', inputSchema: {} }],
      },
    },
  ],
}

// The valid script with one step replaced by a changed copy.
const withStep = (key: string, change: (step: ScriptStep) => ScriptStep, script = VALID): ISessionScript => ({
  ...script,
  steps: script.steps.map((step) => (step.key === key ? change(step) : step)),
})

const failureOf = (act: () => void): { code: string; message: string } | null => {
  try {
    act()
    return null
  } catch (error) {
    return error instanceof Error && 'code' in error
      ? { code: String(error.code), message: error.message }
      : { code: 'plain', message: String(error) }
  }
}

// The failure's code, and whether its message names the key.
const summaryOf = (failure: { code: string; message: string } | null, name: string): unknown => ({
  code: failure?.code,
  isNamed: failure?.message.startsWith(`${name}:`),
})

describe('checkScripts', () => {
  it('passes a valid script with every step kind', () => {
    // Act
    const failure = failureOf(() => {
      checkScripts(EVERYTHING, [VALID], TESTED)
    })

    // Assert
    expect(failure).toBeNull()
  })

  it.each<[string, readonly ISessionScript[], string]>([
    [
      'rule 1: keys are unique across all scripts',
      [VALID, { ...CHILD, key: 'other', steps: [{ ...CHILD.steps[0], key: 'p1' } as ScriptStep] }],
      'p1',
    ],
    ['rule 1: steps are in time order', [withStep('r1', (step) => ({ ...step, at: 900 }) as ScriptStep)], 'r1'],
    [
      'rule 1: every endAt is at or after its start',
      [withStep('k1', (step) => ({ ...step, endAt: 1_590 }) as ScriptStep)],
      'k1',
    ],
    [
      'rule 1: a reply has text, reasoning or a call',
      [
        withStep(
          'r3',
          (step) => ({ ...step, text: null }) as ScriptStep,
          withStep('c4', () => ({ kind: 'interrupt', key: 'c4', at: 2_800 }))
        ),
      ],
      'r3',
    ],
    [
      'rule 2: a call has a reply before it',
      [{ ...VALID, steps: [VALID.steps[0], VALID.steps[2]] as ScriptStep[] }],
      'c1',
    ],
    [
      'rule 2: a call starts at or after its reply ends',
      [
        withStep(
          'c1',
          (step) => ({ ...step, startAt: 1_400 }) as ScriptStep,
          withStep('r1', (step) => ({ ...step, endAt: 1_450 }) as ScriptStep)
        ),
      ],
      'c1',
    ],
    [
      'rule 3: an interrupt is not the first step',
      [{ ...VALID, steps: [{ kind: 'interrupt', key: 'i0', at: 500 }, ...VALID.steps] }],
      'i0',
    ],
    [
      'rule 4: a pending call has no endAt',
      [withStep('c4', (step) => ({ ...step, endAt: 2_900 }) as ScriptStep)],
      'c4',
    ],
    [
      'rule 4: a rejected call has an endAt',
      [withStep('c3', (step) => ({ ...step, endAt: null }) as ScriptStep)],
      'c3',
    ],
    [
      'rule 5: an input key the intent does not list is refused',
      [withStep('c1', (step) => ({ ...step, input: { path: 'a', limit: 10 } }) as ScriptStep)],
      'c1',
    ],
    [
      'rule 5: an intent the family does not have is refused',
      [withStep('c1', (step) => ({ ...step, intent: 'write' }) as ScriptStep)],
      'c1',
    ],
    [
      'rule 5: an mcp call names its server',
      [withStep('c2', (step) => ({ ...step, server: null }) as ScriptStep)],
      'c2',
    ],
    ['rule 6: a projectDir equal to the script home is refused', [{ ...VALID, projectDir: '/home/example' }], 'shop-1'],
    ['rule 6: a projectDir outside the script home is refused', [{ ...VALID, projectDir: '/srv/work/shop' }], 'shop-1'],
    ['rule 6: a relative projectDir is refused', [{ ...VALID, projectDir: 'work/shop' }], 'shop-1'],
    [
      'rule 6: a projectDir with a .. segment is refused',
      [{ ...VALID, projectDir: '/home/example/work/../shop' }],
      'shop-1',
    ],
    [
      'rule 6: a projectDir with a trailing / is refused',
      [{ ...VALID, projectDir: '/home/example/work/shop/' }],
      'shop-1',
    ],
    [
      "rule 6: a spawned child's projectDir is checked",
      [withStep('s1', (step) => ({ ...step, child: { ...CHILD, projectDir: '/home/example/../shop' } }) as ScriptStep)],
      'child',
    ],
    ['a harness version outside the tested versions is refused', [{ ...VALID, harnessVersion: '2.2.0' }], 'shop-1'],
  ])('%s', (_rule, scripts, key) => {
    // Act
    const failure = failureOf(() => {
      checkScripts(EVERYTHING, scripts, TESTED)
    })

    // Assert
    expect(summaryOf(failure, `Script ${key}`)).toStrictEqual({
      code: SOURCE_WRITER_ERROR_CODES.WRITER_SCRIPT_INVALID,
      isNamed: true,
    })
  })

  it.each<[string, Partial<typeof EVERYTHING>, string]>([
    [
      'a capability',
      { capabilities: new Set(SOURCE_CAPABILITIES.filter((capability) => capability !== 'interrupt')) },
      'i1',
    ],
    ['a family', { families: new Set([...FAMILIES].filter((family) => family !== 'read')) }, 'c1'],
    [
      'nested subagents',
      { capabilities: new Set(SOURCE_CAPABILITIES.filter((capability) => capability !== 'session-agent')) },
      'shop-1',
    ],
  ])('refuses as unsupported a script that needs %s the writer lacks', (_lack, lacking, key) => {
    // Act
    const failure = failureOf(() => {
      checkScripts({ ...EVERYTHING, ...lacking }, [VALID], TESTED)
    })

    // Assert
    expect(summaryOf(failure, `Script ${key}`)).toStrictEqual({
      code: SOURCE_WRITER_ERROR_CODES.WRITER_SCRIPT_UNSUPPORTED,
      isNamed: true,
    })
  })
})

describe('checkCommandFiles', () => {
  it.each([
    ['the script home', '/home/example'],
    ['outside the script home', '/srv/work/shop'],
    ['relative', 'work/shop'],
    ['with a .. segment', '/home/example/work/../shop'],
  ])('refuses a command file whose projectDir is %s, naming the file', (_case, projectDir) => {
    // Act
    const failure = failureOf(() => {
      checkCommandFiles([
        { name: 'deploy', body: 'Deploy the project.', projectDir: null },
        { name: 'release', body: 'Release $ARGUMENTS.', projectDir },
      ])
    })

    // Assert
    expect(summaryOf(failure, 'Command file release')).toStrictEqual({
      code: SOURCE_WRITER_ERROR_CODES.WRITER_SCRIPT_INVALID,
      isNamed: true,
    })
  })
})

describe('projectDirIn', () => {
  it('maps a script project directory into a home', () => {
    // Act
    const mapped = projectDirIn('/tmp/rt-1', '/home/example/work/shop')

    // Assert
    expect(mapped).toBe('/tmp/rt-1/work/shop')
  })
})
