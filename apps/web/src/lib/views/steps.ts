import type { IStepsQuery } from '../queries/steps'

// Said the way the dashboard card that links there says it.
const kindOfSteps = (query: IStepsQuery): string => {
  if (query.cause !== null) {
    return `Failed: ${query.cause}`
  }
  if (query.slow !== null) {
    return `Unusually slow: ${query.slow}`
  }
  if (query.real) {
    return 'Failures that were real results'
  }
  if (query.failed) {
    return 'Failed steps'
  }
  if (query.loop) {
    return 'Steps in retry loops'
  }

  return 'Steps'
}

export const stepsHeading = (query: IStepsQuery): string =>
  query.tool === null ? kindOfSteps(query) : `${kindOfSteps(query)} · ${query.tool}`
