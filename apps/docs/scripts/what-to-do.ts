// The exit code page's "what to do" column, keyed by code: written here, joined to the command table's columns.
export const WHAT_TO_DO: Readonly<Record<number, string>> = {
  0: 'Nothing.',
  1: 'Read the line the command printed. Run it again with LOGBOOK_DEBUG=1 for a stack trace, and run logbook doctor to report it.',
  2: 'Check the command and its options against logbook <command> --help.',
  3: 'Wait for the other command to finish, or stop it, then run this one again.',
  4: 'Pick another port with --port, or stop the program that holds it. If it is another Log Book, open its page instead.',
  5: 'Install a supported Node, or run Log Book on macOS or Linux.',
  6: 'Update Log Book: a newer version wrote this warehouse.',
  7: 'Install Claude Code, update it, or sign in to it, as the line says, then run the command again.',
  8: 'Run the command again once your Claude usage resets; it carries on from the last stored batch.',
  9: 'Stop Log Book and start it again, so the host and its children run the same version.',
  10: 'Read the lines about the failed step or the skipped unit, fix what they name, and sync again.',
  130: 'Nothing, unless the command should have finished: run it again.',
}
