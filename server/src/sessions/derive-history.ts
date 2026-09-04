import { pairKey, type MatchHistory } from '../../../engines/pairing.ts';

export interface ConfirmedPairing {
  teamA: [string, string];
  teamB: [string, string];
}

export function deriveHistory(pairings: ConfirmedPairing[]): MatchHistory {
  const partnerCounts = new Map<string, number>();
  const opponentCounts = new Map<string, number>();
  const gamesPlayedThisSession = new Map<string, number>();

  for (const pairing of pairings) {
    const [a1, a2] = pairing.teamA;
    const [b1, b2] = pairing.teamB;

    for (const id of [a1, a2, b1, b2]) {
      gamesPlayedThisSession.set(id, (gamesPlayedThisSession.get(id) ?? 0) + 1);
    }
    for (const key of [pairKey(a1, a2), pairKey(b1, b2)]) {
      partnerCounts.set(key, (partnerCounts.get(key) ?? 0) + 1);
    }
    for (const key of [pairKey(a1, b1), pairKey(a1, b2), pairKey(a2, b1), pairKey(a2, b2)]) {
      opponentCounts.set(key, (opponentCounts.get(key) ?? 0) + 1);
    }
  }

  return { partnerCounts, opponentCounts, gamesPlayedThisSession };
}
