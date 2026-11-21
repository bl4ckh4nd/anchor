/** Where `query` is in `text`, as [start, end) offsets, matched like the list search. */
export function findMatches(text: string, query: string): [number, number][] {
  const term = query.trim().toLowerCase();
  if (!term || term.includes("\n")) return [];
  let lower = text.toLowerCase();
  // Each index of `lower` to the index in `text` it came from.
  let at: number[] | null = null;
  if (lower.length !== text.length) {
    lower = "";
    at = [];
    for (let i = 0; i < text.length; ) {
      const char = String.fromCodePoint(text.codePointAt(i) as number);
      const lowerChar = char.toLowerCase();
      lower += lowerChar;
      for (let k = 0; k < lowerChar.length; k++) at.push(i);
      i += char.length;
    }
    at.push(text.length);
  }
  const matches: [number, number][] = [];
  for (
    let i = lower.indexOf(term);
    i !== -1;
    i = lower.indexOf(term, i + term.length)
  ) {
    const [start, end] = at
      ? [at[i], at[i + term.length]]
      : [i, i + term.length];
    if (end > start) matches.push([start, end]);
  }
  return matches;
}
