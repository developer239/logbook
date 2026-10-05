import { brief, clip } from './format'

const MAIN_FIELDS = [
  'command',
  'cmd',
  'file_path',
  'filePath',
  'path',
  'pattern',
  'query',
  'url',
  'prompt',
  'description',
] as const

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

export const mainInput = (inputJson: string, max = 80): string => {
  let input: unknown

  try {
    input = JSON.parse(inputJson)
  } catch {
    return clip(inputJson, max)
  }

  if (typeof input === 'object' && input !== null) {
    const fields = input as Record<string, unknown>
    const text = [...MAIN_FIELDS.map((field) => fields[field]), ...Object.values(fields)].find(isText)

    if (text !== undefined) {
      return brief(text, max)
    }
  }

  return clip(JSON.stringify(input), max)
}

export const prettyInput = (inputJson: string): string => {
  try {
    return JSON.stringify(JSON.parse(inputJson), null, 2)
  } catch {
    return inputJson
  }
}
