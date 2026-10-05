// A prompt file of the engine. The prompts sit in prompts/ beside this module in every layout: src/prompts in the
// sources, dist/prompts in the build, and beside the CLI's bundle, into whose single file this module is inlined.
export const promptFile = (name: string): URL => new URL(`prompts/${name}`, import.meta.url)
