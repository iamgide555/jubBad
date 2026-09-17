import type { NameMatch, RosterNameMatch } from '../../../../engines/fuzzy-match.ts';

export interface NameReview {
  inputName: string;
  match: NameMatch;
  decision: 'accept' | 'reject-new';
}

/**
 * Everything defaults to `accept` — the host confirms the whole list in one
 * tap — except a `duplicate` or a `fuzzy` suggestion, either of which defaults
 * to being its own new player.
 *
 * "ตั้ม (1)" / "ตั้ม (2)" is two people far more often than it is one name
 * pasted twice, and a fuzzy hit (e.g. a shortened nickname) is only ever a
 * guess, not evidence. In both cases the two mistakes are not
 * symmetric: a spurious extra player is visible and editable afterwards,
 * while two people merged into one silently share a rating and a partner
 * history that can no longer be pulled apart. So "same person" is the
 * deliberate tap, not the default — a host who confirms the list without
 * reading every row ends up with an extra player to merge later, never a
 * wrong silent merge.
 */
export function attachDecisions(reviews: RosterNameMatch[]): NameReview[] {
  return reviews.map((r) => ({
    ...r,
    decision:
      r.match.type === 'duplicate' || r.match.type === 'fuzzy'
        ? ('reject-new' as const)
        : ('accept' as const),
  }));
}
