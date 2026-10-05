import type { IHarnessAdapter } from '@log-book/adapter-api'
import claudeCode from '@log-book/adapter-claude-code'
import openCode from '@log-book/adapter-opencode'

// The registered adapters: the list the CLI hands the engine and the host's discovery, its one composition root.
export const ADAPTERS: readonly IHarnessAdapter[] = [claudeCode(), openCode()]
