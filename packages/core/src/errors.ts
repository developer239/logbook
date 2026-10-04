// The codes core itself raises. Other packages declare their own codes beside the code that raises them,
// so this list never grows with another package's errors.
export const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  EXTERNAL_API_ERROR: 'EXTERNAL_API_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  TIMEOUT: 'TIMEOUT',
  ABORTED: 'ABORTED',
} as const

// Narrow a caught Node system error (fs, child_process, process.kill) to a
// specific errno code without `any`.
export const isErrnoCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code

export class LogBookError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public override readonly cause?: unknown
  ) {
    super(message)
    this.name = 'LogBookError'
  }
}
