/** Where `query` is in `text`, as [start, end) offsets, matched like the list search. */
export function findMatches(text: string, query: string): [number, number][] {
  const term = query.trim().toLowerCase();
  if (!term || term.includes("\n")) return [];
  let lower = text.toLowerCase();
  // Each index of `lower` to the bounds of the character in `text` it came
  // from, so a match inside a character that lower-cases to several still
  // covers it.
  let at: [number, number][] | null = null;
  if (lower.length !== text.length) {
    lower = "";
    at = [];
    for (let i = 0; i < text.length; ) {
      const char = String.fromCodePoint(text.codePointAt(i) as number);
      const lowerChar = char.toLowerCase();
      lower += lowerChar;
      for (let k = 0; k < lowerChar.length; k++) at.push([i, i + char.length]);
      i += char.length;
    }
  }
  const matches: [number, number][] = [];
  for (
    let i = lower.indexOf(term);
    i !== -1;
    i = lower.indexOf(term, i + term.length)
  ) {
    matches.push(
      at ? [at[i][0], at[i + term.length - 1][1]] : [i, i + term.length],
    );
  }
  return matches;
}
