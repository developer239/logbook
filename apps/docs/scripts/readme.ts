const HEADING = /^#{1,6}\s/u

// The README's first line: the sentence npm shows as the CLI's description, which the site's description repeats.
export const firstLineOf = (readme: string): string => {
  const [first = ''] = readme.split('\n')
  if (first.trim() === '' || HEADING.test(first)) {
    throw new Error('README.md must start with the one-sentence description, not an empty line or a heading')
  }
  return first
}
