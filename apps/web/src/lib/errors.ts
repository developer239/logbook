// A query returns null for what is legitimately absent, and the page says so
// with a NotFoundError. It throws for a warehouse inconsistent with itself, and
// the page fails rather than show an "unknown" the reader could take for the
// truth.

export class ParamError extends Error {
  public readonly status = 400
}

export class NotFoundError extends Error {
  public readonly status = 404
}

export class WarehouseError extends Error {
  public readonly status = 503
}

// A logbook child the web app started failed; its message says how.
export class CliError extends Error {
  public readonly status = 500
}
