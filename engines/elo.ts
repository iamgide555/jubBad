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
 * Kept the same for singles: singles is a cleaner signal (no partner to carry
 * or drag a player), but raising K for it is a separate, measured decision.
 */
const K_FACTOR = 16;

/**
 * A team's size determines the match's format: 1 is singles, 2 is doubles.
 * Both teams in a match are always the same size (enforced upstream, in
 * `engines/pairing.ts`'s `validateRoundInput`).
 */
export interface FinishedMatch {
  teamA: PlayerId[];
  teamB: PlayerId[];
  winner: 'A' | 'B';
}

/**
 * Independent rating tracks, keyed by format. A player's singles rating is
 * never moved by a doubles result or vice versa — the two are different
 * skills, and mixing them would make a rating meaningless for either. Each
 * track is a plain Elo map exactly like the old single-format `computeRatings`
 * result, so nothing downstream that only ever plays one format needs to
 * change shape.
 */
export interface RatingTracks {
  singles: Map<PlayerId, number>;
  doubles: Map<PlayerId, number>;
}

function expectedScore(own: number, opponent: number): number {
  return 1 / (1 + 10 ** ((opponent - own) / 400));
}

/** Average rating of a team's members, unrated members starting at STARTING_RATING. */
export function teamRating(team: PlayerId[], ratings: Map<PlayerId, number>): number {
  let sum = 0;
  for (const id of team) sum += ratings.get(id) ?? STARTING_RATING;
  return sum / team.length;
}

/**
 * `matches` must already be in chronological order — Elo is path-dependent, so
 * replaying the same matches in a different order gives different ratings.
 *
 * Format-agnostic by itself: it moves whatever teams a match names. Singles
 * vs. doubles independence (decision: separate tracks) is a property of what
 * the *caller* replays through this, not of this function — see
 * `computeRatingTracks` below, which is the entry point every caller other
 * than a same-format-only test should use.
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

    // Every member of a team moves together: a team's outcome is a team
    // result, and there is no per-player signal to split it on. True for a
    // 1-player "team" too — the loop just runs once.
    for (const id of match.teamA) ratings.set(id, get(id) + delta);
    for (const id of match.teamB) ratings.set(id, get(id) - delta);
  }

  return ratings;
}

/**
 * Splits `matches` by format (a team of 1 is singles, 2 is doubles) and
 * replays each split chronologically through its own independent Elo track.
 * Independence is structural here, not a bookkeeping promise: a singles
 * result is never in the list `computeRatings` sees when building the
 * doubles map, and vice versa, so it cannot move it.
 *
 * A player with no history in a format starts at STARTING_RATING on that
 * track — never seeded from their rating in the other format, since that
 * would be exactly the pollution the two tracks exist to prevent. The
 * practical consequence: a group's first singles matches are all
 * 1200-vs-1200, so balanced mode on a singles court is close to random until
 * enough singles games accumulate. Worth knowing, not a bug.
 */
export function computeRatingTracks(matches: FinishedMatch[]): RatingTracks {
  const singles = matches.filter((m) => m.teamA.length === 1);
  const doubles = matches.filter((m) => m.teamA.length !== 1);
  return { singles: computeRatings(singles), doubles: computeRatings(doubles) };
}

/** Rating points between the two sides of a proposed match. */
export function ratingGap(
  teamA: PlayerId[],
  teamB: PlayerId[],
  ratings: Map<PlayerId, number>
): number {
  return Math.abs(teamRating(teamA, ratings) - teamRating(teamB, ratings));
}
