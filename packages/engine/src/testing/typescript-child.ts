import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Lets a child process import the TypeScript sources: Node strips the types, and this maps an import of `./x.js` to
// `./x.ts` when no `./x.js` exists. The hooks run on the importing thread, so a child under `--permission`, which may
// start no worker, can use them too.
const REGISTER_TYPESCRIPT_HOOKS = `import { registerHooks } from 'node:module'
registerHooks({
  resolve: (specifier, context, nextResolve) => {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  },
})
`

// Writes the hooks into the directory and returns the arguments that make a Node child process use them.
export const typeScriptChildArgs = async (directory: string): Promise<string[]> => {
  const register = join(directory, 'typescript-register.mjs')
  await writeFile(register, REGISTER_TYPESCRIPT_HOOKS)
  return ['--import', register]
}
