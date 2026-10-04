import { describe, expect, it } from 'vitest'
import { isErrnoCode, LogBookError } from './errors.js'

describe('LogBookError', () => {
  it('keeps its message, code and cause and is named LogBookError', () => {
    // Arrange
    const cause = new Error('underlying')

    // Act
    const error = new LogBookError('Session not found', 'NOT_FOUND', cause)

    // Assert
    expect({
      message: error.message,
      code: error.code,
      cause: error.cause,
      name: error.name,
      isError: error instanceof Error,
      isLogBookError: error instanceof LogBookError,
    }).toStrictEqual({
      message: 'Session not found',
      code: 'NOT_FOUND',
      cause,
      name: 'LogBookError',
      isError: true,
      isLogBookError: true,
    })
  })

  it('accepts a code another package declares', () => {
    // Arrange
    const code = 'ADAPTER_UNIT_GONE'

    // Act
    const error = new LogBookError('The unit is gone', code)

    // Assert
    expect(error.code).toBe('ADAPTER_UNIT_GONE')
  })
})

describe('isErrnoCode', () => {
  it('narrows a system error to its errno code', () => {
    // Arrange
    const systemError = Object.assign(new Error('no such file'), { code: 'ENOENT' })

    // Act
    const results = [
      isErrnoCode(systemError, 'ENOENT'),
      isErrnoCode(systemError, 'EACCES'),
      isErrnoCode(new Error('plain'), 'ENOENT'),
      isErrnoCode(null, 'ENOENT'),
      isErrnoCode('ENOENT', 'ENOENT'),
    ]

    // Assert
    expect(results).toStrictEqual([true, false, false, false, false])
  })
})
