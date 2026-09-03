/**
 * Matches parsed roster/waitlist names against known Player records for a
 * group. Exact match (post-normalize) auto-links; fuzzy match only ever
 * surfaces as a suggestion — never auto-links. See PROJECT.md §6.2.
 */

const TRAILING_PAREN_NOTE_RE = /\s*\([^)]*\)\s*$/;

export function normalizeName(name: string): string {
  return name.replace(TRAILING_PAREN_NOTE_RE, '').trim().normalize('NFC');
}

export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}
