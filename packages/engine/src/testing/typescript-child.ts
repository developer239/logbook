import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Lets a child process import the TypeScript sources: Node strips the types, and this maps an import of `./x.js` to
// `./x.ts` when no `./x.js` exists.
const RESOLVE_TYPESCRIPT_HOOK = `export const resolve = async (specifier, context, nextResolve) => {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context)
    }
    throw error
  }
}
`

// Writes the hook into the directory and returns the arguments that make a Node child process use it.
export const typeScriptChildArgs = async (directory: string): Promise<string[]> => {
  const hook = join(directory, 'typescript-hook.mjs')
  const register = join(directory, 'typescript-register.mjs')
  await writeFile(hook, RESOLVE_TYPESCRIPT_HOOK)
  await writeFile(
    register,
    `import { register } from 'node:module'\nregister(${JSON.stringify(pathToFileURL(hook).href)})\n`
  )
  return ['--import', register]
}
