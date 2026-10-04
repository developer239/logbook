import { readFileSync } from 'node:fs'

export class PromptLoaderService {
  public static readonly load = (promptUrl: URL): string => readFileSync(promptUrl, 'utf-8')

  public static readonly build = (template: string, vars: Record<string, string>): string => {
    let result = template
    for (const [key, value] of Object.entries(vars)) {
      result = result.replaceAll(`{{${key}}}`, value)
    }
    return result
  }
}
