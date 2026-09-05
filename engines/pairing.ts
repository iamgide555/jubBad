/**
 * Pairing/rotation engine: given a confirmed roster, court count, and
 * cross-session partner/opponent history, produces one round's court
 * assignments. See docs/overview.md, "How the engines think — Pairing".
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

/**
 * Repeat-partner avoidance is the primary goal; opponent balancing is only a
 * secondary soft signal. The 10:1 ratio is what enforces that: no arrangement
 * can ever trade away a partner-repeat to save on opponent-repeats, so the
 * opponent term only decides between arrangements already tied on partners.
 * Making opponents a hard constraint too would risk leaving a group with a lot
 * of history unsolvable — the namespace is small and dense.
 */
const PARTNER_WEIGHT = 10;
const OPPONENT_WEIGHT = 1;
/**
 * Far above any achievable real score, so avoiding an immediate repeat of the
 * previous split always wins. Needed because with exactly 4 players available
 * there are only 3 possible splits, and with no history they all score 0 —
 * without this, reshuffle could hand back the same pairing it just rejected.
 */
const AVOID_SPLIT_PENALTY = 1000;

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

export function buildRandomArrangement(
  playing: PlayerId[],
  usableCourts: number,
  random: () => number
): CourtAssignment[] {
  const shuffled = shuffle(playing, random);
  const courts: CourtAssignment[] = [];
  for (let i = 0; i < usableCourts; i++) {
    const group = shuffled.slice(i * 4, i * 4 + 4);
    courts.push({
      court: i + 1,
      teamA: [group[0], group[1]],
      teamB: [group[2], group[3]],
    });
  }
  return courts;
}

export interface MatchHistory {
  /** All-time across sessions — variety over the group's whole life. */
  partnerCounts: Map<string, number>;
  /** All-time across sessions. */
  opponentCounts: Map<string, number>;
  /** This session only — resets each session for fair rotation today. */
  gamesPlayedThisSession: Map<PlayerId, number>;
}

export interface RoundResult {
  courts: CourtAssignment[];
  sittingOut: PlayerId[];
}

/**
 * Randomized search, not exhaustive enumeration: real groups run 10-20+
 * players, where scoring every possible arrangement is combinatorially
 * infeasible. Shuffle, greedily build one candidate, score it, repeat, keep
 * the best — "good enough and fair", not "provably optimal". A real min-cost
 * matching optimizer would be overkill for a casual group.
 */
const SEARCH_TRIALS = 200;

export function generateRound(
  roster: PlayerId[],
  courtCount: number,
  history: MatchHistory,
  random: () => number = Math.random,
  avoidSplit?: { teamA: [PlayerId, PlayerId]; teamB: [PlayerId, PlayerId] }
): RoundResult {
  const { playing, sittingOut } = selectSittingOut(
    roster,
    courtCount,
    history.gamesPlayedThisSession,
    random
  );

  const usableCourts = Math.min(courtCount, Math.floor(playing.length / 4));

  if (usableCourts === 0) {
    return { courts: [], sittingOut };
  }

  const avoidKeys =
    avoidSplit && usableCourts === 1
      ? new Set([
          pairKey(avoidSplit.teamA[0], avoidSplit.teamA[1]),
          pairKey(avoidSplit.teamB[0], avoidSplit.teamB[1]),
        ])
      : null;

  let best: CourtAssignment[] | null = null;
  let bestScore = Infinity;

  for (let trial = 0; trial < SEARCH_TRIALS; trial++) {
    const candidate = buildRandomArrangement(playing, usableCourts, random);
    let score = scoreArrangement(candidate, history.partnerCounts, history.opponentCounts);

    if (avoidKeys) {
      const [c] = candidate;
      const candidateKeys = new Set([
        pairKey(c.teamA[0], c.teamA[1]),
        pairKey(c.teamB[0], c.teamB[1]),
      ]);
      const isSameSplit =
        candidateKeys.size === avoidKeys.size &&
        [...candidateKeys].every((k) => avoidKeys.has(k));
      if (isSameSplit) score += AVOID_SPLIT_PENALTY;
    }

    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return { courts: best as CourtAssignment[], sittingOut };
}
