import { pairKey, type MatchHistory } from '../../../engines/pairing.ts';

export interface ConfirmedPairing {
  teamA: [string, string];
  teamB: [string, string];
}

/**
 * The two scopes are deliberately different (PROJECT.md §6.3): partner and
 * opponent counts are all-time across the group's sessions, so variety is
 * spread over the group's whole life; games-played is this session only, so
 * sit-out rotation is fair within tonight and not carried over from weeks ago.
 */
export function deriveHistory(
  allTimePairings: ConfirmedPairing[],
  thisSessionPairings: ConfirmedPairing[]
): MatchHistory {
  const partnerCounts = new Map<string, number>();
  const opponentCounts = new Map<string, number>();
  const gamesPlayedThisSession = new Map<string, number>();

  for (const pairing of allTimePairings) {
    const [a1, a2] = pairing.teamA;
    const [b1, b2] = pairing.teamB;

    for (const key of [pairKey(a1, a2), pairKey(b1, b2)]) {
      partnerCounts.set(key, (partnerCounts.get(key) ?? 0) + 1);
    }
    for (const key of [pairKey(a1, b1), pairKey(a1, b2), pairKey(a2, b1), pairKey(a2, b2)]) {
      opponentCounts.set(key, (opponentCounts.get(key) ?? 0) + 1);
    }
  }

  for (const pairing of thisSessionPairings) {
    for (const id of [...pairing.teamA, ...pairing.teamB]) {
      gamesPlayedThisSession.set(id, (gamesPlayedThisSession.get(id) ?? 0) + 1);
    }
  }

  return { partnerCounts, opponentCounts, gamesPlayedThisSession };
}
