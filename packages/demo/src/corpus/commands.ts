import type { SourceCapability } from '@log-book/adapter-api/source-writer'

export type CommandName = 'review' | 'release-notes'

interface ICommandEntry {
  // A writer gets the file when it declares one of these: a typed command runs by its name, a template command as
  // its body.
  capabilities: readonly SourceCapability[]
  commandFile: string
}

export interface ICommandCorpus {
  // All global: projectDir null.
  files: Readonly<Record<CommandName, ICommandEntry>>
  // A command the harness has built in, typed by its name with no file; recorded only by a writer with typed-command.
  builtIn: readonly string[]
}

export const COMMANDS: ICommandCorpus = {
  files: {
    'review': {
      capabilities: ['typed-command'],
      commandFile:
        '---\ndescription: Review the current branch\n---\nReview the changes on this branch against main. List missing tests, unclear names and unhandled errors, then give a verdict. Focus on $ARGUMENTS.\n',
    },
    'release-notes': {
      capabilities: ['typed-command', 'template-command'],
      commandFile:
        '---\ndescription: Draft release notes\n---\nDraft the release notes for the next version from the merged changes since the last tag, one line per change, newest first. The version is $1.\n',
    },
  },
  builtIn: ['model'],
}
