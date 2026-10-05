import { RULES_LABELLER, type ILabelRecord } from '@log-book/warehouse'
import type { ToolFailureCause } from '../vocabularies.js'

// Rule labels are rebuilt on every sync at no cost, so their version is a constant here, not a task version.
const TOOL_FAILURE_RULES_VERSION = 2

// The causes an error's opening settles, first match wins. Harnesses and common tools word their errors the same way
// every time, so what is left is rare and goes to a model. The patterns match text, never a harness id, so a new
// harness is labelled without an engine change.
const TOOL_FAILURE_RULES: readonly (readonly [ToolFailureCause, RegExp])[] = [
  [
    'rejected',
    /doesn't want to proceed|permission\.rejected|Permission denied|requested permissions to|rule which prevents you|requires approval|expansion obfuscation|cannot prove|read-only transaction|is isolated in the worktree/iu,
  ],
  ['aborted', /Tool execution aborted|tool\.interrupted|was interrupted|Task cancelled/iu],
  ['rate limited', /rate limit/iu],
  [
    'auth',
    /token is invalid or expired|\(401\)|Unauthorized|security token included in the request is (?:expired|invalid)|missing_scope|token not configured/iu,
  ],
  ['service unreachable', /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|connection timeout|Unable to connect/iu],
  [
    'output too large',
    /exceeds maximum allowed tokens|exceeds maximum allowed size|exceeded \d+ bytes|response for \S+ exceeded/iu,
  ],
  [
    'edit mismatch',
    /Could not find oldString|Failed to find expected lines|modified since read|String to replace not found|Found \d+ matches of the string to replace|has not been read yet|Failed to find context/iu,
  ],
  ['environment', /Executable doesn't exist|command not found|is not installed/iu],
  [
    'invalid call',
    /InputValidationError|SchemaError|invalid arguments|"code": "invalid_type"|regex parse error|unavailable tool|No such tool available|is required when|Invalid pull request title|API error \(400\)|failed \(400\)|not available inside a forked worker|syntax error at or near|invalid input value|No changes to make|is out of range for this file/iu,
  ],
  [
    'missing target',
    /File not found|File does not exist|does not exist|not found in \w+$|No such file|ENOENT|Cluster not found|parameter "[^"]+" not found|EISDIR|ENOTDIR|resource not found|Failed to read file to update|\(404 /imu,
  ],
  [
    'tool fault',
    /is not a function|ripgrep execution failed|mime image\/heic|Unexpected end of JSON input|Cannot read properties of undefined|Cannot read binary file/iu,
  ],
]

export interface IFailedCall {
  id: string
  // The opening of the call's result.
  error: string
}

// The cause the rules give an error text, or null when they leave it to a model.
export const toolFailureRuleCause = (error: string): ToolFailureCause | null =>
  TOOL_FAILURE_RULES.find(([, pattern]) => pattern.test(error))?.[0] ?? null

// One cause label per failed call the rules settle; labelledAt is the caller's.
export const toolFailureRuleLabels = (calls: readonly IFailedCall[], labelledAt: number): ILabelRecord[] =>
  calls.flatMap((call) => {
    const cause = toolFailureRuleCause(call.error)
    return cause === null
      ? []
      : [
          {
            recordType: 'tool_call',
            recordId: call.id,
            labeller: RULES_LABELLER,
            version: TOOL_FAILURE_RULES_VERSION,
            name: 'cause',
            value: cause,
            labelledAt,
          },
        ]
  })
