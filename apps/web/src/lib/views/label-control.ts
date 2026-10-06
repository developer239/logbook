import { ago, count, elapsed } from '../format'
import { labellingProcess } from '../labelling'
import { labellingState, type ILabellingState, type LabellingStateName, type LabellingTone } from '../queries/labelling'
import { hasSomethingToLabel } from '../state'

// The top bar's Label control: one line on what labelling does now or how the last run ended, and a link to /labels.
export interface ILabelControl {
  text: string
  // The text's own title: a failure's error.
  title: string | null
  link: { word: string; title: string } | null
  tone: LabellingTone
}

const LABEL = {
  word: 'Label',
  title: 'See what labelling would send, then start it. Labelling runs your own Claude Code and uses your Claude plan.',
}
const LABEL_AGAIN = { ...LABEL, word: 'Label again' }
const VIEW = { word: 'View', title: 'Show labelling progress.' }

const HOLDERS = {
  compact: 'logbook compact is rewriting the warehouse',
  forget: 'logbook forget is removing sessions',
} as const

// A part every state that names it carries; one that does not is a bug in the state, not a text to show.
const required = <TValue>(value: TValue | null, state: ILabellingState, part: string): TValue => {
  if (value === null) {
    throw new Error(`The labelling state ${state.name} carries no ${part}`)
  }
  return value
}

const atOf = (state: ILabellingState): number => required(state.at, state, 'time')

const records = (state: ILabellingState): string =>
  state.progress === null ? '' : `${count(state.progress.done)} of ${count(state.progress.planned)} records`

type TParts = Pick<ILabelControl, 'text' | 'title' | 'link'>

const plain = (text: string, link: ILabelControl['link']): TParts => ({ text, title: null, link })

// Specification 07's words, one text per state; only the counts, the times and the parts a state names vary.
const TEXTS: Record<LabellingStateName, (state: ILabellingState, now: number) => TParts> = {
  'never': () => plain('Not labelled yet', LABEL),
  'starting': () => plain('Starting labelling…', VIEW),
  'running-here': (state, now) => plain(`Labelling: ${records(state)}, since ${elapsed(now - atOf(state))}`, VIEW),
  'stopping': () => plain('Stopping labelling…', VIEW),
  'running-elsewhere': (state, now) =>
    plain(
      `Labelling in a terminal since ${elapsed(now - atOf(state))}${state.progress === null ? '' : `: ${records(state)}`}. Stop it there with Ctrl+C.`,
      VIEW
    ),
  'maintenance': (state, now) =>
    plain(
      `Labelling waits: ${HOLDERS[required(state.operation, state, 'operation')]} (since ${elapsed(now - atOf(state))}).`,
      null
    ),
  'finished': (state, now) => plain(`Labelled ${ago(atOf(state), now)}`, LABEL),
  'stopped': (state, now) =>
    plain(`Labelling stopped ${ago(atOf(state), now)}. Label continues where it stopped.`, LABEL),
  'interrupted': (state, now) =>
    plain(`Labelling was interrupted ${ago(atOf(state), now)}. Label continues where it stopped.`, LABEL),
  'limit': (state, now) =>
    plain(
      `Stopped at your Claude usage limit ${ago(atOf(state), now)}. Label again once it resets; finished batches are kept.`,
      LABEL
    ),
  'unreachable': (state, now) =>
    plain(
      `Labelling stopped ${ago(atOf(state), now)}: Claude Code could not reach its API. Label again when you are online.`,
      LABEL
    ),
  'failed': (state, now) => ({
    text: `Labelling failed ${ago(atOf(state), now)}`,
    title: state.detail,
    link: LABEL_AGAIN,
  }),
  'updated': () => plain('Log Book was updated while running. Press Ctrl+C and start logbook again.', null),
  'needs-claude': (state) => plain(required(state.detail, state, 'prerequisite line'), LABEL),
}

export const labelControlOf = (state: ILabellingState, now: number): ILabelControl => ({
  ...TEXTS[state.name](state, now),
  tone: state.tone,
})

// Null while there is nothing to label: a warehouse the app cannot read, or one with no session yet.
export const labelControl = (now = Date.now()): ILabelControl | null =>
  hasSomethingToLabel() ? labelControlOf(labellingState(labellingProcess()), now) : null
