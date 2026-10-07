export const EXIT_CODE_NAMES = [
  'success',
  'failure',
  'usage error',
  'already running',
  'port in use',
  'unsupported environment',
  'newer warehouse',
  'missing prerequisite',
  'usage limit',
  'updated while running',
  'partial failure',
  'interrupted',
] as const
export type ExitCodeName = (typeof EXIT_CODE_NAMES)[number]

export interface IExitCode {
  code: number
  name: ExitCodeName
  meaning: string
  raisedBy: string
}

// A fixed public contract: once released, a number keeps its meaning.
export const EXIT_CODES: readonly IExitCode[] = [
  {
    code: 0,
    name: 'success',
    meaning: 'Success. Also: the host stopped on Ctrl+C or SIGTERM; a second host found one already running',
    raisedBy: 'all',
  },
  {
    code: 1,
    name: 'failure',
    meaning:
      'The command failed, for example a SQL error, a full disk, or a labelling run that could not reach its API',
    raisedBy: 'all',
  },
  { code: 2, name: 'usage error', meaning: 'Unknown command or option, bad value', raisedBy: 'all' },
  {
    code: 3,
    name: 'already running',
    meaning: 'Another command holds a warehouse lock this one needs',
    raisedBy: 'sync, forget, compact, labels update, labels run, labels drop',
  },
  {
    code: 4,
    name: 'port in use',
    meaning: 'The port is in use by another program or another Log Book',
    raisedBy: 'start',
  },
  {
    code: 5,
    name: 'unsupported environment',
    meaning: 'Node older than the floor, or a platform other than macOS and Linux',
    raisedBy: 'the shim',
  },
  {
    code: 6,
    name: 'newer warehouse',
    meaning: "The warehouse's schema is newer than this build reads",
    raisedBy: 'every command that opens the warehouse',
  },
  {
    code: 7,
    name: 'missing prerequisite',
    meaning: 'Claude Code is missing, too old, or not signed in',
    raisedBy: 'labels update, labels run, labels plan',
  },
  {
    code: 8,
    name: 'usage limit',
    meaning: 'Labelling stopped at your Claude usage limit; every finished batch is kept',
    raisedBy: 'labels update, labels run',
  },
  {
    code: 9,
    name: 'updated while running',
    meaning: "This child's version differs from its host's: Log Book was updated while running",
    raisedBy: 'children of a host',
  },
  {
    code: 10,
    name: 'partial failure',
    meaning: 'The sync imported what it could, but some step failed or some files were skipped',
    raisedBy: 'sync',
  },
  {
    code: 130,
    name: 'interrupted',
    meaning: 'Stopped by Ctrl+C or SIGTERM; work already stored stays',
    raisedBy: 'one-shot commands',
  },
]
