import type { ISqliteDb } from '@log-book/core'
import { createTestWarehouse, type ITestWarehouse } from '@log-book/warehouse/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { failureLabel, literal, purposeLabel, retryLoop, titleOf, toolIs } from './sql'
import { insert } from './testing/warehouse'

type TRow = Record<string, unknown>

let warehouse: ITestWarehouse
let db: ISqliteDb

beforeEach(async () => {
  warehouse = await createTestWarehouse({ isInMemory: true })
  ;({ db } = warehouse)
})

afterEach(async () => {
  await warehouse.remove()
})

const call = (id: string, name: string, extra: Record<string, string | number> = {}): void => {
  insert(db, 'tool_call', {
    id,
    session_id: 's1',
    message_id: 'm1',
    name,
    bare_name: name,
    family: 'file',
    input_json: '{}',
    status: 'completed',
    ...extra,
  })
}

const label = (recordId: string, labeller: string, name: string, value: string): void => {
  insert(db, 'label', {
    record_type: 'tool_call',
    record_id: recordId,
    labeller,
    version: 1,
    name,
    value,
    labelled_at: 1,
  })
}

const isMatched = (text: string, said: string): boolean =>
  (db.prepare(`SELECT ? LIKE '%' || ${literal('?')} || '%' ESCAPE '\\' AS hit`).get(text, said) as TRow | undefined)?.[
    'hit'
  ] === 1

const toolsNamed = (name: string): string[] =>
  db
    .prepare(`SELECT tc.name FROM tool_call tc WHERE ${toolIs('tc')} ORDER BY tc.name`)
    .all(name)
    .map((row) => String((row as TRow)['name']))

const loopNames = (): string[] =>
  db
    .prepare(
      `SELECT tc.name FROM tool_call tc GROUP BY tc.session_id, tc.name, tc.input_json
       HAVING ${retryLoop('tc')} ORDER BY tc.name`
    )
    .all()
    .map((row) => String((row as TRow)['name']))

const failureOf = (id: string): string | null =>
  ((
    db.prepare(`SELECT ${failureLabel('tc')} AS label FROM tool_call tc WHERE tc.id = ?`).get(id) as TRow | undefined
  )?.['label'] ?? null) as string | null

const addSession = (id: string, title: string | null): void => {
  insert(db, 'session', { id, harness: 'claude-code', source_id: id, origin: 'interactive', is_scripted: 0, title })
}

const addPrompt = (sessionId: string, seq: number, text: string, actor = 'user'): void => {
  insert(db, 'message', {
    id: `${sessionId}-${String(seq)}`,
    session_id: sessionId,
    seq,
    actor,
    source_role: actor,
    created_at: seq,
  })
  insert(db, 'part', { message_id: `${sessionId}-${String(seq)}`, session_id: sessionId, idx: 0, kind: 'text', text })
}

const titleFor = (sessionId: string): string | null =>
  ((db.prepare(`SELECT ${titleOf(`'${sessionId}'`)} AS title`).get() as TRow | undefined)?.['title'] ?? null) as
    | string
    | null

describe('literal', () => {
  it('should match text as written, not as a pattern', () => {
    expect(isMatched('a_c', '_')).toBe(true)
    expect(isMatched('abc', '_')).toBe(false)
    expect(isMatched('50% off', '%')).toBe(true)
    expect(isMatched('abc', '%')).toBe(false)
  })

  it('should match a backslash as a backslash', () => {
    expect(isMatched('dir\\file', '\\')).toBe(true)
    expect(isMatched('dirfile', '\\')).toBe(false)
  })
})

describe('toolIs', () => {
  it('should match a tool by its name without its server, in any case and under any server', () => {
    call('c1', 'Read')
    call('c2', 'read')
    call('c3', 'mcp__opencode__read', { bare_name: 'read', server: 'opencode' })
    call('c4', 'mcp__claude_ai_Docs__READ', { bare_name: 'READ', server: 'claude_ai_Docs' })
    call('c5', 'Reader')
    call('c6', 'mcp__opencode__reader', { bare_name: 'reader', server: 'opencode' })
    call('c7', 'unread')

    expect(toolsNamed('read')).toEqual(['Read', 'mcp__claude_ai_Docs__READ', 'mcp__opencode__read', 'read'])
  })

  it('should match an underscore in the name as an underscore', () => {
    call('c1', 'mcp__opencode__oc_run', { bare_name: 'oc_run', server: 'opencode' })
    call('c2', 'mcp__opencode__ocXrun', { bare_name: 'ocXrun', server: 'opencode' })

    expect(toolsNamed('oc_run')).toEqual(['mcp__opencode__oc_run'])
  })
})

describe('retryLoop', () => {
  it('should be a tool called with the same input three times, failing at least twice', () => {
    call('a1', 'Edit', { status: 'error' })
    call('a2', 'Edit', { status: 'error' })
    call('a3', 'Edit')
    call('b1', 'Read', { status: 'error' })
    call('b2', 'Read')
    call('b3', 'Read')
    call('c1', 'Bash', { status: 'error' })
    call('c2', 'Bash', { status: 'error' })

    expect(loopNames()).toEqual(['Edit'])
  })

  it('should count calls of one input only', () => {
    call('a1', 'Edit', { status: 'error' })
    call('a2', 'Edit', { status: 'error' })
    call('a3', 'Edit', { status: 'error', input_json: '{"other":1}' })

    expect(loopNames()).toEqual([])
  })
})

describe('failureLabel', () => {
  it('should have no label for a call that did not fail', () => {
    call('c1', 'Edit')
    label('c1', 'haiku', 'cause', 'invalid call')

    expect(failureOf('c1')).toBeNull()
  })

  it('should read a failed shell call from the model, whatever the rules said', () => {
    call('c1', 'Bash', { family: 'shell', status: 'error' })
    label('c1', 'rules', 'failure', 'real result')
    label('c1', 'haiku', 'failure', 'command mistake')

    expect(failureOf('c1')).toBe('command mistake')
  })

  it('should read any other failed call from the rules before the model', () => {
    call('c1', 'Edit', { status: 'error' })
    call('c2', 'Edit', { status: 'error' })
    label('c1', 'haiku', 'cause', 'other')
    label('c1', 'rules', 'cause', 'edit mismatch')
    label('c2', 'haiku', 'cause', 'invalid call')

    expect(failureOf('c1')).toBe('edit mismatch')
    expect(failureOf('c2')).toBe('invalid call')
  })

  it('should have no label for a failed call nothing labelled', () => {
    call('c1', 'Edit', { status: 'error' })

    expect(failureOf('c1')).toBeNull()
  })
})

describe('purposeLabel', () => {
  it('should be what a shell call was for, and nothing for another call', () => {
    call('c1', 'Bash', { family: 'shell' })
    call('c2', 'Edit')
    label('c1', 'haiku', 'purpose', 'read files')
    label('c2', 'haiku', 'purpose', 'read files')

    const purposes = db.prepare(`SELECT tc.id, ${purposeLabel('tc')} AS purpose FROM tool_call tc ORDER BY tc.id`).all()

    expect(purposes.map((row) => (row as TRow)['purpose'])).toEqual(['read files', null])
  })
})

describe('titleOf', () => {
  it('should be the conversation own title', () => {
    addSession('s1', 'Fix the widget')
    addPrompt('s1', 1, 'something else')

    expect(titleFor('s1')).toBe('Fix the widget')
  })

  it('should be the opening of the first typed prompt where the title is empty or missing', () => {
    addSession('s1', '')
    addSession('s2', null)
    addPrompt('s1', 1, 'Fix the widget')
    addPrompt('s2', 1, 'Fix the gadget')

    expect(titleFor('s1')).toBe('Fix the widget')
    expect(titleFor('s2')).toBe('Fix the gadget')
  })

  it('should pass over what the harness wrote in the human name, by its actor', () => {
    addSession('s1', null)
    addPrompt('s1', 1, '<local-command-stdout>ok</local-command-stdout>', 'harness')
    addPrompt('s1', 2, '[note] release please')

    expect(titleFor('s1')).toBe('[note] release please')
  })

  it('should take a message from the human whatever its text starts with', () => {
    addSession('s1', null)
    addPrompt('s1', 1, 'Caveat: the release waits for the review')

    expect(titleFor('s1')).toBe('Caveat: the release waits for the review')
  })

  it('should pass over a reply, and keep to the first 90 characters', () => {
    addSession('s1', null)
    addPrompt('s1', 1, 'a reply', 'assistant')
    addPrompt('s1', 2, 'x'.repeat(120))

    expect(titleFor('s1')).toBe('x'.repeat(90))
  })

  it('should be nothing for a conversation with no message from the human', () => {
    addSession('s1', null)
    addPrompt('s1', 1, '[Request interrupted by user]', 'harness')

    expect(titleFor('s1')).toBeNull()
  })
})
