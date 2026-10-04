// At most `max` characters, marked with an ellipsis when cut. It counts and
// cuts whole characters: a cut between the two halves of an emoji leaves a lone
// surrogate, which makes the JSON a labelling call sends invalid.
export const clipChars = (text: string, max: number): string => {
  const characters = Array.from(text)
  return characters.length > max ? `${characters.slice(0, max).join('')}…` : text
}
