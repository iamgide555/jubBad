import { pairKey, type MatchHistory } from '../../../engines/pairing.ts';

/** A team is 1 player (singles) or 2 (doubles); both teams on a court agree. */
export interface ConfirmedPairing {
  teamA: string[];
  teamB: string[];
}

/**
 * Partner and opponent counts come from `allTimePairings`; games-played from
 * `thisSessionPairings`. The caller picks the scope: today it passes this
 * session's pairings for both (players do not remember last week's partners),
 * and passes the group's whole history for the first argument only when the
 * cross-session option is on.
 * See docs/overview.md, "How the engines think — Pairing".
 *
 * Partner counts come from every within-team pair — none for a 1-player
 * (singles) team, since there is no partner to repeat. Opponent counts come
 * from the full team-A x team-B cross product: one pair for singles, the same
 * four as always for doubles.
 */
export function deriveHistory(
  allTimePairings: ConfirmedPairing[],
  thisSessionPairings: ConfirmedPairing[]
): MatchHistory {
  const partnerCounts = new Map<string, number>();
  const opponentCounts = new Map<string, number>();
  const gamesPlayedThisSession = new Map<string, number>();

  for (const pairing of allTimePairings) {
    for (const team of [pairing.teamA, pairing.teamB]) {
      for (let i = 0; i < team.length; i++) {
        for (let j = i + 1; j < team.length; j++) {
          const key = pairKey(team[i], team[j]);
          partnerCounts.set(key, (partnerCounts.get(key) ?? 0) + 1);
        }
      }
    }
    for (const a of pairing.teamA) {
      for (const b of pairing.teamB) {
        const key = pairKey(a, b);
        opponentCounts.set(key, (opponentCounts.get(key) ?? 0) + 1);
      }
    }
  }

  for (const pairing of thisSessionPairings) {
    for (const id of [...pairing.teamA, ...pairing.teamB]) {
      gamesPlayedThisSession.set(id, (gamesPlayedThisSession.get(id) ?? 0) + 1);
    }
  }

  return { partnerCounts, opponentCounts, gamesPlayedThisSession };
}
