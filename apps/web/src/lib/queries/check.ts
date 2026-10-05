import { countBy } from '../lists'
import type { IRange } from '../range'
import { REACTIONS } from '../sql'
import { all } from '../warehouse'

export const CHECK_SIZE = 50

export interface ICheckItem {
  reactionId: string
  sessionId: string
  messageId: string
  reaction: string
  target: string | null
  reach: string | null
  quote: string | null
  rule: string | null
  prompt: string
  // The agent's last reply before the prompt; null at the start of a session.
  reply: string | null
}

export interface IAgreement {
  reaction: string
  right: number
  wrong: number
}

export interface ISpotCheck {
  items: ICheckItem[]
  // Reactions in the range not judged yet, sample included.
  unjudged: number
  agreement: IAgreement[]
}

interface IJudgedReaction {
  reactionId: string
  reaction: string
  verdict: string | null
}

const UINT32 = 2 ** 32

// The bitwise XOR of two unsigned 32-bit integers, worked out one bit at a time.
const xor = (left: number, right: number): number => {
  let result = 0
  let leftRest = left
  let rightRest = right

  for (let place = 1; place < UINT32; place *= 2) {
    if (leftRest % 2 !== rightRest % 2) {
      result += place
    }

    leftRest = Math.floor(leftRest / 2)
    rightRest = Math.floor(rightRest / 2)
  }

  return result
}

// FNV-1a: a fixed order that looks random, so the sample stays the same from one visit to the next and a
// judged reaction makes room for the next one in line.
const scramble = (text: string): number => {
  let hash = 0x81_1c_9d_c5

  for (const char of text) {
    const product = Math.imul(xor(hash, char.codePointAt(0) ?? 0), 0x01_00_01_93)
    hash = product < 0 ? product + UINT32 : product
  }

  return hash
}

const textOf = (message: string): string =>
  `(SELECT group_concat(p.text, char(10)) FROM part p WHERE p.message_id = ${message} AND p.kind = 'text')`

// A verdict counts while the labelling it judged is the one shown: another labelling numbers a prompt's
// reactions afresh.
export const spotCheck = (range: IRange): ISpotCheck => {
  const reactions = all<IJudgedReaction>(
    `SELECT r.reaction_id AS reactionId, r.reaction,
       CASE WHEN o.value = r.labeller || ' v' || r.version THEN v.value END AS verdict
     FROM ${REACTIONS} r
     JOIN message m ON m.id = r.message_id
     LEFT JOIN label v ON v.record_type = 'reaction' AND v.record_id = r.reaction_id AND v.labeller = 'human'
       AND v.version = 1 AND v.name = 'verdict'
     LEFT JOIN label o ON o.record_type = 'reaction' AND o.record_id = r.reaction_id AND o.labeller = 'human'
       AND o.version = 1 AND o.name = 'verdictOn'
     WHERE r.reaction IS NOT NULL AND m.created_at >= ? AND m.created_at < ?`,
    range.from,
    range.to
  )
  const unjudged = reactions.filter((reaction) => reaction.verdict === null)
  const chosen = unjudged
    .map((reaction) => reaction.reactionId)
    .toSorted((left, right) => {
      const byScramble = scramble(left) - scramble(right)

      return byScramble === 0 ? left.localeCompare(right) : byScramble
    })
    .slice(0, CHECK_SIZE)
  const judged = Map.groupBy(
    reactions.filter((reaction) => reaction.verdict !== null),
    (reaction) => reaction.reaction
  )

  return {
    items:
      chosen.length === 0
        ? []
        : all<ICheckItem>(
            `SELECT r.reaction_id AS reactionId, r.session_id AS sessionId, r.message_id AS messageId, r.reaction,
               r.target, r.reach, r.quote, r.rule, COALESCE(${textOf('m.id')}, '') AS prompt,
               ${textOf(`(SELECT b.id FROM message b WHERE b.session_id = m.session_id AND b.seq < m.seq
                 AND b.actor = 'assistant' AND EXISTS (SELECT 1 FROM part bp WHERE bp.message_id = b.id AND bp.kind = 'text')
                 ORDER BY b.seq DESC LIMIT 1)`)} AS reply
             FROM ${REACTIONS} r JOIN message m ON m.id = r.message_id
             WHERE r.reaction_id IN (${chosen.map(() => '?').join(', ')})`,
            ...chosen
          ).toSorted((left, right) => chosen.indexOf(left.reactionId) - chosen.indexOf(right.reactionId)),
    unjudged: unjudged.length,
    agreement: [...judged]
      .map(([reaction, ofKind]) => {
        const verdicts = countBy(ofKind, (row) => row.verdict)
        return { reaction, right: verdicts.get('right') ?? 0, wrong: verdicts.get('wrong') ?? 0 }
      })
      .toSorted((left, right) => {
        const byVolume = right.right + right.wrong - (left.right + left.wrong)

        return byVolume === 0 ? left.reaction.localeCompare(right.reaction) : byVolume
      }),
  }
}
