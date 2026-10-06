import { describe, expect, it } from 'vitest'
import type { ILabellingState, LabellingStateName } from '../queries/labelling'
import { labelControlOf } from './label-control'

const NOW = Date.UTC(2026, 9, 5, 12)
const MINUTE = 60_000
const LABEL_TITLE =
  'See what labelling would send, then start it. Labelling runs your own Claude Code and uses your Claude plan.'
const VIEW = { word: 'View', title: 'Show labelling progress.' }
const LABEL = { word: 'Label', title: LABEL_TITLE }
const PROGRESS = {
  model: 'claude-haiku-4-5',
  startedAt: NOW - 4 * MINUTE,
  tasks: [{ task: 'shell', done: 1240, planned: 2214 }],
  done: 1240,
  planned: 2214,
  percent: 56,
}

const state = (name: LabellingStateName, rest: Partial<ILabellingState> = {}): ILabellingState => ({
  name,
  tone: 'slow',
  at: null,
  detail: null,
  operation: null,
  progress: null,
  ...rest,
})

describe('the Label control', () => {
  it.each([
    ['never', state('never'), 'Not labelled yet', null, LABEL],
    ['starting', state('starting'), 'Starting labelling…', null, VIEW],
    [
      'running-here',
      state('running-here', { at: NOW - 4 * MINUTE, progress: PROGRESS }),
      'Labelling: 1,240 of 2,214 records, since 4 min',
      null,
      VIEW,
    ],
    ['stopping', state('stopping'), 'Stopping labelling…', null, VIEW],
    [
      'running-elsewhere',
      state('running-elsewhere', { at: NOW - 4 * MINUTE, progress: PROGRESS }),
      'Labelling in a terminal since 4 min: 1,240 of 2,214 records. Stop it there with Ctrl+C.',
      null,
      VIEW,
    ],
    [
      'running-elsewhere without a record',
      state('running-elsewhere', { at: NOW - 4 * MINUTE }),
      'Labelling in a terminal since 4 min. Stop it there with Ctrl+C.',
      null,
      VIEW,
    ],
    [
      'maintenance by compact',
      state('maintenance', { at: NOW - 2 * MINUTE, operation: 'compact' }),
      'Labelling waits: logbook compact is rewriting the warehouse (since 2 min).',
      null,
      null,
    ],
    [
      'maintenance by forget',
      state('maintenance', { at: NOW - 2 * MINUTE, operation: 'forget' }),
      'Labelling waits: logbook forget is removing sessions (since 2 min).',
      null,
      null,
    ],
    ['finished', state('finished', { at: NOW - 12 * MINUTE }), 'Labelled 12 min ago', null, LABEL],
    [
      'stopped',
      state('stopped', { at: NOW - 3 * MINUTE }),
      'Labelling stopped 3 min ago. Label continues where it stopped.',
      null,
      LABEL,
    ],
    [
      'interrupted',
      state('interrupted', { at: NOW - 2 * 60 * MINUTE }),
      'Labelling was interrupted 2 h ago. Label continues where it stopped.',
      null,
      LABEL,
    ],
    [
      'limit',
      state('limit', { at: NOW - 20 * MINUTE }),
      'Stopped at your Claude usage limit 20 min ago. Label again once it resets; finished batches are kept.',
      null,
      LABEL,
    ],
    [
      'unreachable',
      state('unreachable', { at: NOW - 6 * MINUTE }),
      'Labelling stopped 6 min ago: Claude Code could not reach its API. Label again when you are online.',
      null,
      LABEL,
    ],
    [
      'failed',
      state('failed', { at: NOW - 5 * MINUTE, detail: 'the disk is full' }),
      'Labelling failed 5 min ago',
      'the disk is full',
      { word: 'Label again', title: LABEL_TITLE },
    ],
    [
      'updated',
      state('updated'),
      'Log Book was updated while running. Press Ctrl+C and start logbook again.',
      null,
      null,
    ],
    [
      'needs-claude',
      state('needs-claude', {
        detail: 'needs Claude Code: install it (https://claude.com/claude-code) or set CLAUDE_BIN',
      }),
      'needs Claude Code: install it (https://claude.com/claude-code) or set CLAUDE_BIN',
      null,
      LABEL,
    ],
  ] as const)('reads %s in 07 words', (_name, shown, text, title, link) => {
    // Act
    const control = labelControlOf(shown, NOW)

    // Assert
    expect(control).toStrictEqual({ text, title, link, tone: shown.tone })
  })

  it('refuses a state that lacks a part its text names', () => {
    // Act
    let refusal: unknown = null
    try {
      labelControlOf(state('maintenance', { at: NOW }), NOW)
    } catch (error) {
      refusal = error
    }

    // Assert
    expect(refusal).toStrictEqual(new Error('The labelling state maintenance carries no operation'))
  })
})
