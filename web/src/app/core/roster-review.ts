import { matchName, type NameMatch, type Player } from '../../../../fuzzy-match.ts';

export interface NameReview {
  inputName: string;
  match: NameMatch;
  decision: 'accept' | 'reject-new';
}

export function buildReviews(names: string[], players: Player[]): NameReview[] {
  return names.map((inputName) => ({
    inputName,
    match: matchName(inputName, players),
    decision: 'accept',
  }));
}
