import { emptyFilter, filterOf } from '../filter'
import { change, count, hours, percent, points } from '../format'
import { conversationsHref, stepsHref } from '../links'
import type { IStrip } from '../queries/strip'
import type { IRange } from '../range'

export interface IStat {
  label: string
  // None where the stat needs labels a model has not given yet.
  value: string | null
  href: string
  sub: string
  change: string | null
  isUp: boolean
  tone: 'problem' | ''
}

const wrong = (strip: IStrip): number => strip.failed - strip.realResults

// Done and went wrong are compared as shares: a busier week has more of both.
const doneShare = (strip: IStrip): number | null =>
  strip.conversations === 0 ? null : (100 * strip.done) / strip.conversations

const wrongShare = (strip: IStrip): number | null => (strip.calls === 0 ? null : (100 * wrong(strip)) / strip.calls)

const sharesOf = (
  of: (strip: IStrip) => number | null,
  current: IStrip,
  previous: IStrip | null
): { now: number | null; before: number | null } => ({
  now: of(current),
  before: previous === null ? null : of(previous),
})

const isShareUp = (share: { now: number | null; before: number | null }): boolean =>
  share.now !== null && share.before !== null && share.now >= share.before

const shareChange = (share: { now: number | null; before: number | null }, since: string): string | null =>
  share.now === null || share.before === null ? null : change(share.now, share.before, points, since)

export const stripStats = (range: IRange, current: IStrip, previous: IStrip | null, isLabelled: boolean): IStat[] => {
  const done = sharesOf(doneShare, current, previous)
  const wrongNow = sharesOf(wrongShare, current, previous)

  return [
    {
      label: 'Conversations',
      value: count(current.conversations),
      href: conversationsHref(emptyFilter(), range),
      sub: `${count(current.by.me)} by me, ${count(current.by.agent)} by agents, ${count(current.by.script)} by scripts`,
      change: previous === null ? null : change(current.conversations, previous.conversations, count, range.since),
      isUp: previous !== null && current.conversations >= previous.conversations,
      tone: '',
    },
    {
      label: 'Active hours',
      value: hours(current.activeMs),
      href: conversationsHref(emptyFilter(), range),
      sub: 'of model and tool time',
      change: previous === null ? null : change(current.activeMs, previous.activeMs, hours, range.since),
      isUp: previous !== null && current.activeMs >= previous.activeMs,
      tone: '',
    },
    {
      label: 'Finished',
      href: conversationsHref(filterOf('outcome', ['done']), range),
      // Whether a conversation finished is a model's label.
      ...(isLabelled
        ? {
            value: count(current.done),
            sub:
              done.now === null ? 'no conversations' : `${percent(done.now)} of ${count(current.conversations)} done`,
            change: shareChange(done, range.since),
            isUp: isShareUp(done),
          }
        : { value: null, sub: 'not labelled yet', change: null, isUp: false }),
      tone: '',
    },
    {
      label: 'Calls that went wrong',
      value: count(wrong(current)),
      href: stepsHref({ failed: '1' }, range),
      sub:
        wrongNow.now === null
          ? 'no calls'
          : `${percent(wrongNow.now)} of ${count(current.calls)} calls, ${count(current.realResults)} real results left out`,
      change: shareChange(wrongNow, range.since),
      isUp: isShareUp(wrongNow),
      tone: wrong(current) > 0 ? 'problem' : '',
    },
  ]
}
