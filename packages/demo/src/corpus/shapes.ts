import type { PromptAct, SessionGoal } from '@log-book/engine'
import type { CommandName } from './commands.js'
import type { ClosingKind } from './replies.js'
import type { ProjectToolName, SharedToolName, SkillName } from './tools.js'

type SubagentTaskName = 'find-tests' | 'check-discount' | 'review-form' | 'check-fix'

// A tool call of tools.ts, a skill load, the start of a session this one starts, or the `claude -p` shell call that
// starts the scripted session this one runs.
export type UseName =
  | ProjectToolName
  | SharedToolName
  | `skill:${SkillName}`
  | `spawn:${SubagentTaskName}`
  | 'run-scripted'

export interface ITurnShape {
  // The act of the prompt that opens the turn.
  act: PromptAct
  // Opens the turn in place of the prompt where the writer records the command.
  command?: { name: CommandName; arguments: string }
  // A built-in command typed before the prompt where the writer records typed commands, with the session's model as
  // its argument.
  builtIn?: string
  // A tools-offered event at the turn's start where the writer records one.
  offersTools?: boolean
  // In order, each after a reply of the agent.
  uses: readonly UseName[]
  closing: ClosingKind
}

interface ISessionShape {
  // The goals of the work items it fits.
  goals: readonly SessionGoal[]
  // The coverage matrix rows it exercises.
  rows: readonly number[]
  // The first turns; a session with more takes the follow-up turn for the rest. A session has at least two turns, three
  // when it starts another session in its second, so a shape keeps what its rows need within those.
  turns: readonly ITurnShape[]
}

// What a started session is asked to do: its first prompt, its calls, and the result its last reply hands back.
export interface ISubagentTask {
  agentType: string
  act: PromptAct
  prompt: string
  uses: readonly UseName[]
  result: string
}

export type ShapeName =
  | 'feature through a subagent'
  | 'feature that runs a question'
  | 'review through a subagent'
  | 'refactor in steps'
  | 'quick question'
  | 'tracked bug fix'
  | 'feature with tests'
  | 'plan a flow'
  | 'bug fix with tests'
  | 'debug through a subagent'
  | 'fix through a subagent'
  | 'debug with a helper'
  | 'release with a command'

export interface IShapeCorpus {
  shapes: Readonly<Record<ShapeName, ISessionShape>>
  followUp: ITurnShape
  subagents: Readonly<Record<SubagentTaskName, ISubagentTask>>
}

export const SHAPES: IShapeCorpus = {
  shapes: {
    'feature through a subagent': {
      goals: ['build a feature'],
      rows: [3, 7, 15],
      turns: [
        { act: 'task', uses: ['update-todos', 'find-files', 'read-source', 'edit-source'], closing: 'progress' },
        { act: 'continue', uses: ['spawn:check-discount'], closing: 'done' },
      ],
    },
    'feature that runs a question': {
      goals: ['build a feature'],
      rows: [4, 5, 15],
      turns: [
        { act: 'task', uses: ['run-scripted', 'read-source'], closing: 'asks' },
        { act: 'answer', uses: ['ask-human', 'edit-source', 'git-status'], closing: 'handoff' },
      ],
    },
    'review through a subagent': {
      goals: ['review'],
      rows: [3, 9, 10],
      turns: [
        {
          act: 'task',
          command: { name: 'review', arguments: 'the checkout form' },
          uses: ['skill:review-checklist', 'git-diff', 'read-source'],
          closing: 'progress',
        },
        { act: 'continue', uses: ['spawn:review-form'], closing: 'unclear' },
      ],
    },
    'refactor in steps': {
      goals: ['refactor, migrate or clean up'],
      rows: [6, 10, 15],
      turns: [
        { act: 'task', builtIn: 'model', uses: ['read-source', 'edit-source', 'run-tests'], closing: 'progress' },
        { act: 'report', uses: ['run-tests', 'edit-source'], closing: 'partly' },
      ],
    },
    'quick question': {
      goals: ['no task'],
      rows: [2, 4, 15],
      turns: [{ act: 'question', uses: ['read-source'], closing: 'answer' }],
    },
    'tracked bug fix': {
      goals: ['fix a bug'],
      rows: [5, 7, 8, 15],
      turns: [
        {
          act: 'task',
          offersTools: true,
          uses: ['load-tools', 'tracker-issue', 'read-source', 'web-search'],
          closing: 'progress',
        },
        { act: 'other', uses: ['ask-human', 'edit-source', 'run-tests-slow'], closing: 'abandoned' },
      ],
    },
    'feature with tests': {
      goals: ['build a feature'],
      rows: [5, 7],
      turns: [
        {
          act: 'task',
          uses: ['read-source', 'write-test', 'run-tests', 'dispatch-check', 'wait-check'],
          closing: 'progress',
        },
        { act: 'continue', uses: ['web-fetch', 'other-tool', 'run-tests'], closing: 'done' },
      ],
    },
    'plan a flow': {
      goals: ['plan or specify'],
      rows: [5, 15],
      turns: [
        { act: 'task', uses: ['web-search', 'read-source', 'ask-human'], closing: 'asks' },
        { act: 'answer', uses: ['write-doc'], closing: 'done' },
      ],
    },
    'bug fix with tests': {
      goals: ['fix a bug'],
      rows: [5, 6, 15],
      turns: [
        { act: 'task', uses: ['read-source', 'search-text', 'edit-source', 'run-tests'], closing: 'progress' },
        { act: 'report', uses: ['run-tests-slow', 'git-diff'], closing: 'failed' },
      ],
    },
    'debug through a subagent': {
      goals: ['debug or diagnose'],
      rows: [3, 21],
      turns: [
        { act: 'task', uses: ['read-source', 'trace-drift'], closing: 'progress' },
        { act: 'continue', uses: ['spawn:find-tests'], closing: 'blocked' },
      ],
    },
    'fix through a subagent': {
      goals: ['fix a bug'],
      rows: [3, 7],
      turns: [
        { act: 'task', uses: ['read-source', 'edit-source'], closing: 'progress' },
        { act: 'continue', uses: ['spawn:check-fix'], closing: 'done' },
      ],
    },
    'debug with a helper': {
      goals: ['debug or diagnose'],
      rows: [5, 7, 15],
      turns: [
        { act: 'task', uses: ['search-text', 'dispatch-check', 'wait-check', 'other-tool'], closing: 'progress' },
        { act: 'other', uses: ['web-fetch', 'edit-source', 'run-tests'], closing: 'done' },
      ],
    },
    'release with a command': {
      goals: ['ship and operate'],
      rows: [9, 10, 15],
      turns: [
        {
          act: 'task',
          command: { name: 'release-notes', arguments: '2.3.0' },
          uses: ['skill:write-release-notes', 'git-log', 'write-doc'],
          closing: 'progress',
        },
        { act: 'question', uses: ['ask-human', 'git-tag'], closing: 'done' },
      ],
    },
  },
  followUp: { act: 'continue', uses: ['git-status', 'run-tests'], closing: 'progress' },
  subagents: {
    'find-tests': {
      agentType: 'explore',
      act: 'task',
      prompt: 'find the tests that cover {file}',
      uses: ['find-files', 'read-test'],
      result: 'One test file covers {file}; it checks a single case.',
    },
    'check-discount': {
      agentType: 'general',
      act: 'task',
      prompt: 'check that the discount code change keeps the cart total right',
      uses: ['read-test', 'spawn:find-tests', 'run-tests'],
      result: 'The cart total stays right with and without a code, and the tests pass.',
    },
    'review-form': {
      agentType: 'reviewer',
      act: 'task',
      prompt: 'review {file} for missing tests and unclear names',
      uses: ['read-source', 'search-text'],
      result: 'One case has no test: an empty code. The names read clearly.',
    },
    'check-fix': {
      agentType: 'general',
      act: 'task',
      prompt: 'run the invoice tests and report any failure',
      uses: ['read-test', 'run-tests'],
      result: 'Every invoice test passes.',
    },
  },
}
