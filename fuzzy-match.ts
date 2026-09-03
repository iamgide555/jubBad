/**
 * Matches parsed roster/waitlist names against known Player records for a
 * group. Exact match (post-normalize) auto-links; fuzzy match only ever
 * surfaces as a suggestion — never auto-links. See PROJECT.md §6.2.
 */

const TRAILING_PAREN_NOTE_RE = /\s*\([^)]*\)\s*$/;

export function normalizeName(name: string): string {
  return name.replace(TRAILING_PAREN_NOTE_RE, '').trim().normalize('NFC');
}
