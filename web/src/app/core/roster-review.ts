import {
  matchName,
  confirmExistingPlayerAlias,
  createNewPlayer,
  type NameMatch,
  type Player,
} from '../../../../fuzzy-match.ts';

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

export function resolveReviews(
  reviews: NameReview[],
  players: Player[]
): { playerIds: string[]; players: Player[] } {
  let updatedPlayers = players;

  const playerIds = reviews.map((review) => {
    if (review.match.type === 'exact') {
      return review.match.playerId;
    }
    if (review.match.type === 'fuzzy' && review.decision === 'accept') {
      updatedPlayers = confirmExistingPlayerAlias(
        updatedPlayers,
        review.match.playerId,
        review.inputName
      );
      return review.match.playerId;
    }
    const newId = crypto.randomUUID();
    updatedPlayers = createNewPlayer(updatedPlayers, newId, review.inputName);
    return newId;
  });

  return { playerIds, players: updatedPlayers };
}
