/**
 * Win/loss Elo over a group's match history.
 *
 * Deliberately ignores scores. They are optional (see docs/overview.md), so a
 * rating that depended on them would be sparse and biased toward whichever
 * hosts bother typing numbers in. `winner` is one tap and is recorded on
 * essentially every finished match, which makes it the honest signal.
 *
 * Ratings are always recomputed by replaying history in order rather than
 * stored, so there is no second source of truth to drift: change the constants
 * below and every rating changes with them.
 */

export type PlayerId = string;

export const STARTING_RATING = 1200;

/**
 * Deliberately low. A casual group plays a handful of matches a week, doubles
 * outcomes are noisy, and a rating that swings hard on one unlucky game would
 * make "balanced" mode feel arbitrary. Slow and stable beats responsive here.
 */
const K_FACTOR = 16;

export interface FinishedMatch {
  teamA: [PlayerId, PlayerId];
  teamB: [PlayerId, PlayerId];
  winner: 'A' | 'B';
}

function expectedScore(own: number, opponent: number): number {
  return 1 / (1 + 10 ** ((opponent - own) / 400));
}

export function teamRating(
  team: [PlayerId, PlayerId],
  ratings: Map<PlayerId, number>
): number {
  return (
    ((ratings.get(team[0]) ?? STARTING_RATING) + (ratings.get(team[1]) ?? STARTING_RATING)) / 2
  );
}

/**
 * `matches` must already be in chronological order — Elo is path-dependent, so
 * replaying the same matches in a different order gives different ratings.
 */
export function computeRatings(matches: FinishedMatch[]): Map<PlayerId, number> {
  const ratings = new Map<PlayerId, number>();
  const get = (id: PlayerId) => ratings.get(id) ?? STARTING_RATING;

  for (const match of matches) {
    const ratingA = teamRating(match.teamA, ratings);
    const ratingB = teamRating(match.teamB, ratings);
    const expectedA = expectedScore(ratingA, ratingB);
    const actualA = match.winner === 'A' ? 1 : 0;
    const delta = K_FACTOR * (actualA - expectedA);

    // Both members of a team move together: doubles outcomes are a team
    // result, and there is no per-player signal to split them on.
    for (const id of match.teamA) ratings.set(id, get(id) + delta);
    for (const id of match.teamB) ratings.set(id, get(id) - delta);
  }

  return ratings;
}

/** Rating points between the two sides of a proposed match. */
export function ratingGap(
  teamA: [PlayerId, PlayerId],
  teamB: [PlayerId, PlayerId],
  ratings: Map<PlayerId, number>
): number {
  return Math.abs(teamRating(teamA, ratings) - teamRating(teamB, ratings));
}
