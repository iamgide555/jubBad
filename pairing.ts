/**
 * Pairing/rotation engine: given a confirmed roster, court count, and
 * cross-session partner/opponent history, produces one round's court
 * assignments. See PROJECT.md §6.3.
 */

export type PlayerId = string;

export function pairKey(a: PlayerId, b: PlayerId): string {
  return [a, b].sort().join('|');
}

export function shuffle<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function selectSittingOut(
  roster: PlayerId[],
  courtCount: number,
  gamesPlayedThisSession: Map<PlayerId, number>,
  random: () => number
): { playing: PlayerId[]; sittingOut: PlayerId[] } {
  const usableCourts = Math.min(courtCount, Math.floor(roster.length / 4));
  const sitOutCount = roster.length - usableCourts * 4;

  if (sitOutCount <= 0) {
    return { playing: [...roster], sittingOut: [] };
  }

  const shuffled = shuffle(roster, random);
  const sorted = [...shuffled].sort(
    (a, b) => (gamesPlayedThisSession.get(b) ?? 0) - (gamesPlayedThisSession.get(a) ?? 0)
  );

  const sittingOut = sorted.slice(0, sitOutCount);
  const sittingOutSet = new Set(sittingOut);
  const playing = roster.filter((p) => !sittingOutSet.has(p));

  return { playing, sittingOut };
}

export interface CourtAssignment {
  court: number;
  teamA: [PlayerId, PlayerId];
  teamB: [PlayerId, PlayerId];
}

const PARTNER_WEIGHT = 10;
const OPPONENT_WEIGHT = 1;

export function scoreArrangement(
  courts: { teamA: [PlayerId, PlayerId]; teamB: [PlayerId, PlayerId] }[],
  partnerCounts: Map<string, number>,
  opponentCounts: Map<string, number>
): number {
  let score = 0;

  for (const { teamA, teamB } of courts) {
    const partnerPairs = [pairKey(teamA[0], teamA[1]), pairKey(teamB[0], teamB[1])];
    for (const key of partnerPairs) {
      if ((partnerCounts.get(key) ?? 0) > 0) score += PARTNER_WEIGHT;
    }

    const opponentPairs = [
      pairKey(teamA[0], teamB[0]),
      pairKey(teamA[0], teamB[1]),
      pairKey(teamA[1], teamB[0]),
      pairKey(teamA[1], teamB[1]),
    ];
    for (const key of opponentPairs) {
      if ((opponentCounts.get(key) ?? 0) > 0) score += OPPONENT_WEIGHT;
    }
  }

  return score;
}
