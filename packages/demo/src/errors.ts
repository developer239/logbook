export const DEMO_ERROR_CODES = {
  // A plan the engine's tasks could not have written: the error names the record key and the field.
  DEMO_PLAN_INVALID: 'DEMO_PLAN_INVALID',
  // The import found no built CLI to run.
  DEMO_CLI_MISSING: 'DEMO_CLI_MISSING',
  // logbook doctor showed an adapter that would not read exactly what the writers wrote: the error names its line.
  DEMO_PREFLIGHT_FAILED: 'DEMO_PREFLIGHT_FAILED',
  // logbook sync exited with anything but 0: the error names the exit code and its last stderr line.
  DEMO_SYNC_FAILED: 'DEMO_SYNC_FAILED',
  // An imported record differs from the writers' expected one: the error names the record and the field.
  DEMO_IMPORT_MISMATCH: 'DEMO_IMPORT_MISMATCH',
  // A build started in a time zone other than UTC, where the writers would format times differently.
  DEMO_TZ_NOT_UTC: 'DEMO_TZ_NOT_UTC',
  // The out directory holds something other than a previous demo build: the error names the directory.
  DEMO_OUT_NOT_DEMO: 'DEMO_OUT_NOT_DEMO',
  // The check of a finished build found something other than what the build wrote: the error names the rule and where.
  DEMO_CHECK_FAILED: 'DEMO_CHECK_FAILED',
} as const
