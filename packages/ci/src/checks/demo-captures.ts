import { COMMITTED_CAPTURES_FILE } from '../rules/capture-rules.js'
import { listIn } from './captures.js'

const isFields = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// The arguments of `pnpm demo:scan` for one demo entry, its text capture and the build it was captured from, or
// undefined when it lacks one of them.
const scanArgumentsOf = (entry: Record<string, unknown>): string | undefined => {
  const { size, seed } = isFields(entry.build) ? entry.build : {}
  return typeof entry.text === 'string' && typeof size === 'string' && typeof seed === 'number'
    ? `${entry.text} --size ${size} --seed ${String(seed)}`
    : undefined
}

// Rule M6's input: one line of `pnpm demo:scan` arguments per demo entry of the committed capture manifest, in its
// order, or one finding naming the manifest when it cannot be read or a demo entry lacks what the scan takes. The
// manifest is read as a file; packages/ci never imports the demo package, so the demo job runs the scan itself.
export const demoCaptureArguments = async (root: string): Promise<string[] | string> => {
  const captures = await listIn(root, COMMITTED_CAPTURES_FILE, 'captures')
  if (typeof captures === 'string') {
    return captures
  }
  const demo = captures.flatMap((entry, index) =>
    isFields(entry) && entry.source === 'demo' ? [{ place: index + 1, line: scanArgumentsOf(entry) }] : []
  )
  const incomplete = demo.filter(({ line }) => line === undefined).map(({ place }) => String(place))
  if (incomplete.length > 0) {
    return `${COMMITTED_CAPTURES_FILE}: entries ${incomplete.join(', ')} lack text, build.size or build.seed`
  }
  return demo.flatMap(({ line }) => (line === undefined ? [] : [line]))
}
