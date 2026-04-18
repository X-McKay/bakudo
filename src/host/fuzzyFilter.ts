/**
 * Fuzzy-filter helper for the command palette and session picker overlays.
 *
 * Subsequence match on lower-cased input: every character in `query` must
 * appear in the candidate string in order (not necessarily contiguous). Case
 * is ignored. An empty `query` matches everything.
 *
 * The match is deliberately simple — the palette/picker lists are small
 * (tens of entries at most) and the UX benefits from predictability over
 * clever scoring. Order is preserved from the input; callers that want
 * newest-first or alphabetical ordering do the sort themselves.
 */

export const matchesFuzzy = (candidate: string, query: string): boolean => {
  if (query.length === 0) {
    return true;
  }
  const haystack = candidate.toLowerCase();
  const needle = query.toLowerCase();
  let cursor = 0;
  for (const char of needle) {
    const next = haystack.indexOf(char, cursor);
    if (next === -1) {
      return false;
    }
    cursor = next + 1;
  }
  return true;
};

export const fuzzyFilter = <T>(
  items: ReadonlyArray<T>,
  query: string,
  pick: (item: T) => string,
): T[] => {
  if (query.length === 0) {
    return [...items];
  }
  return items.filter((item) => matchesFuzzy(pick(item), query));
};
