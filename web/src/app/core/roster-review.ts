import type { NameMatch, RosterNameMatch } from '../../../../engines/fuzzy-match.ts';

export interface NameReview {
  inputName: string;
  match: NameMatch;
  decision: 'accept' | 'reject-new';
}

export function attachDecisions(reviews: RosterNameMatch[]): NameReview[] {
  return reviews.map((r) => ({ ...r, decision: 'accept' as const }));
}
