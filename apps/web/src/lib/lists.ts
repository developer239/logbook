export const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)

export const sumBy = <TItem>(items: readonly TItem[], of: (item: TItem) => number): number => sum(items.map(of))

export const countBy = <TItem, TKey>(items: readonly TItem[], keyOf: (item: TItem) => TKey): Map<TKey, number> =>
  new Map([...Map.groupBy(items, keyOf)].map(([key, group]) => [key, group.length]))

export const partition = <TItem>(items: readonly TItem[], is: (item: TItem) => boolean): [TItem[], TItem[]] => [
  items.filter(is),
  items.filter((item) => !is(item)),
]
