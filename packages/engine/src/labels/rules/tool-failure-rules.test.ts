import { describe, expect, it } from 'vitest'
import { toolFailureRuleCause } from './tool-failure-rules.js'

describe('toolFailureRuleCause', () => {
  it.each([
    ['tool.execution: File not found: /home/example/work/shop/src/a.ts', 'missing target'],
    ['query failed: Error: column "status" does not exist', 'missing target'],
    ['Error: ENOENT: no such file or directory, open notes.md', 'missing target'],
    ['Resource not found in staging', 'missing target'],
    ['<tool_use_error>String to replace not found in file. String: foo</tool_use_error>', 'edit mismatch'],
    ['<tool_use_error>File has been modified since read, either by the user or by a linter.', 'edit mismatch'],
    ['The todowrite tool was called with invalid arguments: SchemaError(Expected array)', 'invalid call'],
    ['tool.execution: Offset 650 is out of range for this file (421 lines)', 'invalid call'],
    ['The tracker token is invalid or expired. Please check it.', 'auth'],
    ['query failed: Error: connect ECONNREFUSED 127.0.0.1:56280', 'service unreachable'],
    ['list_users failed: rate limited. Retry after 30 seconds.', 'rate limited'],
    ["The user doesn't want to proceed with this tool use. The tool use was rejected", 'rejected'],
    ['permission.rejected: the user refused this call', 'rejected'],
    ['tool.execution: Tool execution aborted', 'aborted'],
    ['File content (25812 tokens) exceeds maximum allowed tokens (25000).', 'output too large'],
    ["launch: Executable doesn't exist at /home/example/.cache/browsers", 'environment'],
    ['link_issues failed: Error linking issues: Unexpected end of JSON input', 'tool fault'],
    ['render failed: the design service returned HTTP 500 for 15 nodes', null],
  ])('gives %j the cause %s', (error, cause) => {
    // Act
    const given = toolFailureRuleCause(error)

    // Assert
    expect(given).toBe(cause)
  })

  it.each([
    ['AUTH_MISSING: no credential for the tracker'],
    ['AUTH_EXPIRED: the session ended'],
    ['STOP - do not look for the credential yourself'],
    ['No AWS SSO configuration found for the profile'],
    ['Unknown async run id run_example01'],
    ['The reaction is not on Slack message 1700000000.000100'],
    ['Vision subprocess exited with code 1'],
    ['Unknown connection example-db'],
    ['SSH tunnel failed for example-host'],
    ['The database example-db is in error state'],
    ['INVALID_INPUT: the query is empty'],
    ['Secret db-password not found in dev (check the name)'],
    ['Secret db-password not found in stg (check the name)'],
    ['Secret db-password not found in prod (check the name)'],
  ])('gives no cause for the removed pattern in %j', (error) => {
    // Act
    const given = toolFailureRuleCause(error)

    // Assert
    expect(given).toBeNull()
  })
})
