import { pairKey, type MatchHistory } from '../../../engines/pairing.ts';

/** A team is 1 player (singles) or 2 (doubles); both teams on a court agree. */
export interface ConfirmedPairing {
  teamA: string[];
  teamB: string[];
}

/**
 * The two scopes are deliberately different: partner and opponent counts are
 * all-time across the group's sessions, so variety is spread over the group's
 * whole life; games-played is this session only, so sit-out rotation is fair
 * within tonight and not carried over from weeks ago.
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
