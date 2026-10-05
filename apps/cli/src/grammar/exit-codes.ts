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
      'The command failed: an error that ended the whole sync, a SQL error in sql, a full disk (a compaction among them), a labelling run that ended unreachable or failed',
    raisedBy: 'all',
  },
  { code: 2, name: 'usage error', meaning: 'Unknown command or option, bad value', raisedBy: 'all' },
  {
    code: 3,
    name: 'already running',
    meaning:
      'A sync, a forget or a compaction holds the sync lock, or a labelling run, a labels drop, a forget or a compaction holds the labelling lock, and this command needs that lock. A forget or a compaction needs both',
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
    meaning:
      'A labelling prerequisite is missing: claude not found, too old, or not signed in, at detection or when a call is refused for authentication',
    raisedBy: 'labels update, labels run, labels plan',
  },
  {
    code: 8,
    name: 'usage limit',
    meaning: "Labelling stopped at the user's Claude usage limit; every batch finished before it is stored",
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
    meaning:
      "The sync finished, but at least one adapter's step failed or a source unit was skipped; everything else it read is imported",
    raisedBy: 'sync',
  },
  {
    code: 130,
    name: 'interrupted',
    meaning:
      'A one-shot command stopped by Ctrl+C or SIGTERM (the host exits 0). Work already committed stays; an unfinished compaction leaves the file as it was',
    raisedBy: 'one-shot commands',
  },
]
