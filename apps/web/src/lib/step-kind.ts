export type StepKind = 'model' | 'fail' | 'agent' | 'untimed' | 'tool'

// A call of the steps list has no kind and starts no agent.
export type StepLike =
  | { kind: 'model' }
  | { kind?: 'tool'; cause: string | null; started?: object | null; durationMs: number | null }

export const stepKind = (step: StepLike): StepKind => {
  if (step.kind === 'model') {
    return 'model'
  }
  if (step.cause !== null) {
    return 'fail'
  }
  if ((step.started ?? null) !== null) {
    return 'agent'
  }

  return step.durationMs === null ? 'untimed' : 'tool'
}
