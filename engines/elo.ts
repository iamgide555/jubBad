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
 * `engines/pairing.ts`'s `validateRoundInput`). `at` is the match's
 * confirmed timestamp in epoch ms, used when a level is set mid-session and
 * the player must be reset from that moment onward.
 */
export interface FinishedMatch {
  teamA: PlayerId[];
  teamB: PlayerId[];
  winner: 'A' | 'B';
  at?: number;
}

/**
 * A player's rating anchor: a level or manual seed that takes effect at a
 * specific time. `setAt === null` means the anchor starts from the first
 * match the player ever appears in. The caller is responsible for ensuring
 * the matches are chronologically ordered, as Elo always is.
 */
export interface RatingAnchor {
  rating: number;
  setAt: number | null;
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
export function computeRatings(
  matches: FinishedMatch[],
  /**
   * Back-compat seed map. When the map values are plain numbers, this keeps
   * the previous behaviour. When the caller passes a `RatingAnchor` map, the
   * player's rating resets exactly when that anchor becomes active.
   */
  seeds?: ReadonlyMap<PlayerId, number | RatingAnchor>
): Map<PlayerId, number> {
  const ratings = new Map<PlayerId, number>();
  const anchors = new Map<PlayerId, RatingAnchor>();
  const legacySeeds = new Map<PlayerId, number>();

  for (const [id, seed] of seeds ?? []) {
    if (typeof seed === 'number') {
      legacySeeds.set(id, seed);
    } else {
      anchors.set(id, seed);
    }
  }

  const appliedAnchors = new Set<PlayerId>();
  const get = (id: PlayerId) => {
    const existing = ratings.get(id);
    if (existing !== undefined) return existing;
    const anchor = anchors.get(id);
    const anchorRating = anchor?.rating ?? legacySeeds.get(id);
    return anchorRating ?? STARTING_RATING;
  };

  for (const match of matches) {
    if (match.at === undefined) {
      for (const id of [...match.teamA, ...match.teamB]) {
        const anchor = anchors.get(id);
        if (anchor && anchor.setAt !== null) {
          throw new Error(`missing match timestamp for rating anchor on player ${id}`);
        }
      }
    }

    for (const id of [...match.teamA, ...match.teamB]) {
      const anchor = anchors.get(id);
      if (anchor && anchor.setAt !== null && match.at !== undefined && match.at >= anchor.setAt) {
        if (!appliedAnchors.has(id)) {
          ratings.set(id, anchor.rating);
          appliedAnchors.add(id);
        }
      }
    }

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

  for (const [id, anchor] of anchors) {
    if (anchor.setAt !== null && !appliedAnchors.has(id) && ratings.has(id)) {
      ratings.set(id, anchor.rating);
    }
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
 * track — never seeded from their rating in the *other format*, since that
 * would be exactly the pollution the two tracks exist to prevent. The
 * practical consequence: a group's first singles matches are all
 * 1200-vs-1200, so balanced mode on a singles court is close to random until
 * enough singles games accumulate. Worth knowing, not a bug.
 *
 * `seeds` (a player's skill level, see engines/levels.ts) is a different
 * thing from a rating: it is a human judgement about the person, not a
 * rating carried over from the other track, so applying the same seed to
 * both tracks is not the pollution the paragraph above rules out.
 */
export function computeRatingTracks(
  matches: FinishedMatch[],
  seeds?: ReadonlyMap<PlayerId, number | RatingAnchor>
): RatingTracks {
  // `=== 2`, not `!== 1`: the 1-or-2 invariant is enforced upstream
  // (engines/pairing.ts's validateRoundInput, server/src/sessions/
  // pairing-teams.ts's parseTeams) but this function has no way to check it
  // itself. Bucketing everything that isn't singles into doubles would mean
  // a team of some other size — reachable only by a future caller that
  // builds a FinishedMatch directly rather than through those checks —
  // silently joins the doubles replay; teamRating then divides by that
  // length, and a size of 0 produces NaN that permanently poisons every
  // real player's rating from that match onward. Requiring exactly 2 instead
  // drops such a match from both tracks, which is a real player missing a
  // rating rather than a real player's rating turning into NaN.
  const singles = matches.filter((m) => m.teamA.length === 1);
  const doubles = matches.filter((m) => m.teamA.length === 2);
  return {
    singles: computeRatings(singles, seeds),
    doubles: computeRatings(doubles, seeds),
  };
}

/** Rating points between the two sides of a proposed match. */
export function ratingGap(
  teamA: PlayerId[],
  teamB: PlayerId[],
  ratings: Map<PlayerId, number>
): number {
  return Math.abs(teamRating(teamA, ratings) - teamRating(teamB, ratings));
}
