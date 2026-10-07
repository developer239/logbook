import {
  DEFAULT_LABEL_MODEL,
  LABEL_TASK_NAMES,
  REPORT_NAMES,
  REPORT_NAMES_ALL,
  REPORT_TOPICS,
  SESSION_GOALS,
  SESSION_ORIGINS,
  SESSION_OUTCOMES,
} from '@log-book/engine'
import { RULES_LABELLER, SCHEMA_DESCRIPTION } from '@log-book/warehouse'
import type { ExitCodeName } from './exit-codes.js'

// integer: a whole number in min..max; day: a calendar day as YYYY-MM-DD; choice: one of `values`; model: the
// engine's model id rule; text: any value.
export type OptionKind = 'flag' | 'integer' | 'text' | 'day' | 'choice' | 'model'

export interface IOptionSpec {
  name: string
  // As the synopsis shows it, such as `<n>`; null for a flag.
  placeholder: string | null
  kind: OptionKind
  default: string | number | boolean | null
  min: number | null
  max: number | null
  values: readonly string[] | null
  isRequired: boolean
  // A value the parser refuses with its own line.
  forbidden: { value: string; line: string } | null
  help: string
}

export interface IPositionalSpec {
  name: string
  isRequired: boolean
  isRepeated: boolean
  // The values the parser accepts; null for any.
  values: readonly string[] | null
}

export interface ICommandSpec {
  words: readonly string[]
  synopsis: string
  // One line, for `logbook --help`.
  summary: string
  // For `logbook <command> --help`.
  description: string
  positionals: readonly IPositionalSpec[]
  options: readonly IOptionSpec[]
  isWriting: boolean
  exitCodes: readonly ExitCodeName[]
  // Two forms of which exactly one is given: the positionals, or this option.
  forms: { option: string; both: string; neither: string } | null
}

const NO_LIMITS = { min: null, max: null, values: null, isRequired: false, forbidden: null } as const

const flag = (name: string, help: string): IOptionSpec => ({
  name,
  placeholder: null,
  kind: 'flag',
  default: false,
  ...NO_LIMITS,
  help,
})

interface IIntegerRange {
  min: number
  max: number | null
  default: number | null
}

const integer = (name: string, placeholder: string, range: IIntegerRange, help: string): IOptionSpec => ({
  name,
  placeholder,
  kind: 'integer',
  ...NO_LIMITS,
  ...range,
  help,
})

const text = (name: string, placeholder: string, help: string, isRequired = false): IOptionSpec => ({
  name,
  placeholder,
  kind: 'text',
  default: null,
  ...NO_LIMITS,
  isRequired,
  help,
})

const choice = (name: string, values: readonly string[], help: string, isRequired = false): IOptionSpec => ({
  name,
  placeholder: `<${name}>`,
  kind: 'choice',
  default: null,
  ...NO_LIMITS,
  values,
  isRequired,
  help,
})

const positional = (name: string, isRequired = true, values: readonly string[] | null = null): IPositionalSpec => ({
  name,
  isRequired,
  isRepeated: false,
  values,
})

const LIMIT = integer('limit', '<n>', { min: 1, max: null, default: 30 }, 'At most this many')
const MAX_ROWS = integer('max-rows', '<n>', { min: 1, max: null, default: 200 }, 'At most this many rows per table')
const TASK = choice('task', LABEL_TASK_NAMES, 'The label task', true)
const MODEL: IOptionSpec = {
  name: 'model',
  placeholder: '<model>',
  kind: 'model',
  default: DEFAULT_LABEL_MODEL,
  ...NO_LIMITS,
  help:
    `Claude model id for every task of this run (default ${DEFAULT_LABEL_MODEL}; pass a full id, not an alias). ` +
    'On a fixed 100-prompt sample Haiku agreed with Sonnet on 62% of prompt acts and of reaction sets and missed ' +
    'most redirects and praise.',
}
const LABELLER_HELP = `A labeller: ${RULES_LABELLER}, or a model id`
const RULES_DROPPED = "The rules-based labels are rebuilt on every sync; only a model's labels can be dropped."

const SESSION_NOTE = 'A <session> is a warehouse id (claude-code:<uuid>) or the id the harness shows.'
const ONE_SHOT: readonly ExitCodeName[] = ['success', 'failure', 'usage error', 'interrupted']
const READS: readonly ExitCodeName[] = [...ONE_SHOT, 'newer warehouse']
const WRITES: readonly ExitCodeName[] = [...READS, 'already running', 'updated while running']

// Every command of logbook, in the order its help lists them.
export const COMMANDS: readonly ICommandSpec[] = [
  {
    words: ['start'],
    synopsis: 'logbook [start] [--port <n>] [--no-open] [--interval <minutes>] [--no-sync]',
    summary:
      'Serve the UI on 127.0.0.1, open it in the browser and sync every few minutes until Ctrl+C (the default command)',
    description:
      'Serve the UI on 127.0.0.1, open it in the browser and sync every few minutes until Ctrl+C. It is the default ' +
      'command: logbook with no command, or with only these options, starts it.',
    positionals: [],
    options: [
      integer(
        'port',
        '<n>',
        { min: 0, max: 65_535, default: 7314 },
        'TCP port on 127.0.0.1; 0 lets the system pick a free one'
      ),
      flag('no-open', 'Do not open the page in the browser (for SSH sessions, headless machines and tests)'),
      integer('interval', '<minutes>', { min: 1, max: null, default: 5 }, 'Minutes between scheduled syncs'),
      flag('no-sync', 'Serve the warehouse as it is: no first sync and no schedule; the Sync button still works'),
    ],
    isWriting: true,
    exitCodes: ['success', 'failure', 'usage error', 'port in use', 'newer warehouse'],
    forms: null,
  },
  {
    words: ['sync'],
    synopsis: 'logbook sync',
    summary: "Import what changed in your agents' history since the last sync",
    description:
      "Import every session of your agents' history that changed since the last sync, then rebuild the links " +
      'between sessions.',
    positionals: [],
    options: [],
    isWriting: true,
    exitCodes: [...WRITES, 'partial failure'],
    forms: null,
  },
  {
    words: ['sessions'],
    synopsis:
      'logbook sessions [--harness <id|alias>] [--origin <interactive|scripted|subagent>] [--project <text>]\n' +
      '                 [--goal <goal>] [--outcome <outcome>] [--since <YYYY-MM-DD>] [--limit <n>]',
    summary: 'List sessions, newest first',
    description:
      'List sessions, newest first. --goal keeps those that pursued it, as their first or second goal: ' +
      `${SESSION_GOALS.join(', ')}. --outcome keeps those that ended so: ${SESSION_OUTCOMES.join(', ')}.`,
    positionals: [],
    options: [
      text('harness', '<id|alias>', 'Only sessions of this agent: an adapter id (claude-code) or its alias (claude)'),
      choice('origin', SESSION_ORIGINS, 'Only sessions started this way'),
      text('project', '<text>', 'Only sessions of projects matching this text'),
      choice('goal', SESSION_GOALS, 'Only sessions that pursued this goal, first or second'),
      choice('outcome', SESSION_OUTCOMES, 'Only sessions that ended so'),
      {
        name: 'since',
        placeholder: '<YYYY-MM-DD>',
        kind: 'day',
        default: null,
        ...NO_LIMITS,
        help: 'Only sessions started on or after this day',
      },
      LIMIT,
    ],
    isWriting: false,
    exitCodes: READS,
    forms: null,
  },
  {
    words: ['search'],
    synopsis: 'logbook search <query> [--limit <n>]',
    summary: 'Search prompts, replies, reasoning, and tool input and output',
    description:
      'Full-text search over prompts, replies, reasoning, and tool input and output (FTS5 syntax: words, ' +
      '"phrases", prefix*, AND, OR, NOT).',
    positionals: [positional('query')],
    options: [LIMIT],
    isWriting: false,
    exitCodes: READS,
    forms: null,
  },
  {
    words: ['tree'],
    synopsis: 'logbook tree <session> [--root]',
    summary: 'Show a session and every subagent session it started',
    description: `A session and every subagent session it started. ${SESSION_NOTE}`,
    positionals: [positional('session')],
    options: [flag('root', 'Start from the session at the top of its tree')],
    isWriting: false,
    exitCodes: READS,
    forms: null,
  },
  {
    words: ['timeline'],
    synopsis: 'logbook timeline <session>',
    summary: "Show a session's prompts, replies and tool calls in order, with durations",
    description: `A session's prompts, replies and tool calls in order, with durations. ${SESSION_NOTE}`,
    positionals: [positional('session')],
    options: [],
    isWriting: false,
    exitCodes: READS,
    forms: null,
  },
  {
    words: ['report'],
    synopsis: 'logbook report [<name>] [--max-rows <n>]',
    summary: 'Print a canned report, every report of a topic, or all of them',
    description:
      `A canned report, or every report in a topic (${REPORT_TOPICS.join(', ')}); all of them without a name or ` +
      `with ${REPORT_NAMES_ALL}. Reports: ${REPORT_NAMES.join(', ')}.`,
    positionals: [positional('name', false, [...REPORT_NAMES, ...REPORT_TOPICS, REPORT_NAMES_ALL])],
    options: [MAX_ROWS],
    isWriting: false,
    exitCodes: READS,
    forms: null,
  },
  {
    words: ['sql'],
    synopsis: 'logbook sql <query> [--max-rows <n>]',
    summary: 'Run a read-only SQL query over the warehouse',
    // The schema in prose, one table a line, so a person or an agent can write a query from the help alone.
    description: `Read-only SQL over the warehouse. The tables:\n${SCHEMA_DESCRIPTION}`,
    positionals: [positional('query')],
    options: [MAX_ROWS],
    isWriting: false,
    exitCodes: READS,
    forms: null,
  },
  {
    words: ['labels', 'update'],
    synopsis: 'logbook labels update [--model <model>]',
    summary: 'Label every record no model has labelled yet, with your own Claude Code',
    description:
      "Label whatever is new with your own Claude Code: every task, one after another, leaving a session's " +
      'outcome and its last reply until the session has been quiet for an hour. A usage limit stops it; every ' +
      'batch finished before it is stored.',
    positionals: [],
    options: [MODEL],
    isWriting: true,
    exitCodes: [...WRITES, 'missing prerequisite', 'usage limit'],
    forms: null,
  },
  {
    words: ['labels', 'run'],
    synopsis: 'logbook labels run --task <task> [--model <model>] [--sample <n>] [--limit <n>]',
    summary: "Label one task's records that this model has not labelled yet",
    description:
      'Label every record of one task this model has not labelled yet, through your own Claude Code. Each batch ' +
      'is stored as it lands, so a stopped run resumes; a usage limit stops it. --sample labels a fixed sample, ' +
      'the same for every model, to compare models on.',
    positionals: [],
    options: [
      TASK,
      MODEL,
      integer(
        'sample',
        '<n>',
        { min: 1, max: null, default: null },
        'Label a fixed sample of n records, the same for every model, to compare models on'
      ),
      integer('limit', '<n>', { min: 1, max: null, default: null }, 'Label at most n records in this run'),
    ],
    isWriting: true,
    exitCodes: [...WRITES, 'missing prerequisite', 'usage limit'],
    forms: null,
  },
  {
    words: ['labels', 'plan'],
    synopsis: 'logbook labels plan [--model <model>]',
    summary: 'Print, as one JSON object, what labelling would send now, without calling a model',
    description:
      'Print, as one JSON object, what labelling would send now: each task, its records and the input they would ' +
      'take, without calling a model.',
    positionals: [],
    options: [MODEL],
    isWriting: false,
    exitCodes: [...READS, 'missing prerequisite'],
    forms: null,
  },
  {
    words: ['labels', 'preview'],
    synopsis: 'logbook labels preview --task <task> [--batches <n>]',
    summary: "Print a task's next batches exactly as labelling would send them",
    description: "Print a task's next batches exactly as labelling would send them, without calling a model.",
    positionals: [],
    options: [TASK, integer('batches', '<n>', { min: 1, max: 10, default: 1 }, 'How many batches to show')],
    isWriting: false,
    exitCodes: READS,
    forms: null,
  },
  {
    words: ['labels', 'compare'],
    synopsis: 'logbook labels compare --task <task> --first <labeller> --second <labeller>',
    summary: 'Show how often two labellers agree, field by field',
    description: 'How often two labellers (rules, or a model) agree, field by field.',
    positionals: [],
    options: [
      TASK,
      text('first', '<labeller>', LABELLER_HELP, true),
      text('second', '<labeller>', LABELLER_HELP, true),
    ],
    isWriting: false,
    exitCodes: READS,
    forms: null,
  },
  {
    words: ['labels', 'drop'],
    synopsis: 'logbook labels drop --task <task> --labeller <model>',
    summary: "Delete one model's labels of one task",
    description:
      "Delete one model's labels of one task. A report reads each record's newest model label, so after a " +
      'comparison drop the labeller you did not choose.',
    positionals: [],
    options: [
      TASK,
      {
        ...text('labeller', '<model>', 'The model whose labels to delete', true),
        forbidden: { value: RULES_LABELLER, line: RULES_DROPPED },
      },
    ],
    isWriting: true,
    exitCodes: WRITES,
    forms: null,
  },
  {
    words: ['forget'],
    synopsis: 'logbook forget <session>... | --project <dir>',
    summary: 'Remove sessions from the warehouse for good, then compact it',
    description:
      'Remove sessions from the warehouse for good, by id or every session of a project directory, then compact ' +
      `it. ${SESSION_NOTE}`,
    positionals: [{ name: 'session', isRequired: false, isRepeated: true, values: null }],
    options: [text('project', '<dir>', 'Forget every session of this project directory')],
    isWriting: true,
    exitCodes: WRITES,
    forms: {
      option: 'project',
      both: 'forget takes session ids or --project <dir>, not both.',
      neither: 'forget needs session ids or --project <dir>.',
    },
  },
  {
    words: ['compact'],
    synopsis: 'logbook compact',
    summary: 'Give back the disk space syncs leave free inside the warehouse',
    description: 'Give back the disk space syncs leave free inside the warehouse.',
    positionals: [],
    options: [],
    isWriting: true,
    exitCodes: WRITES,
    forms: null,
  },
  {
    words: ['doctor'],
    synopsis: 'logbook doctor',
    summary: 'Print what Log Book finds on this machine, to paste into a bug report',
    description:
      'Print what Log Book finds on this machine: where each agent keeps its data, the warehouse and the versions, ' +
      'to paste into a bug report.',
    positionals: [],
    options: [],
    isWriting: false,
    exitCodes: ONE_SHOT,
    forms: null,
  },
]

export const PACKAGE = {
  name: '@log-book/cli',
  binary: 'logbook',
  distTags: ['latest', 'next'],
} as const
