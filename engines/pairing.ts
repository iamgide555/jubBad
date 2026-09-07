/**
 * Pairing/rotation engine: given a confirmed roster, court count, and
 * cross-session partner/opponent history, produces one round's court
 * assignments. See docs/overview.md, "How the engines think — Pairing".
 */

import { ratingGap } from './elo.ts';

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
 * secondary soft signal. The 10:1 ratio is what enforces that: one repeat
 * partner costs more than all four opponent pairings of a court combined, so
 * the opponent term only ever separates arrangements already close on
 * partners. Making opponents a hard constraint too would risk leaving a group
 * with a lot of history unsolvable — the namespace is small and dense.
 *
 * Both terms scale with how many times a pair has actually met, not whether
 * they ever have. A yes/no test looks equivalent and is not: every pair in a
 * 12-player group has partnered at least once by the second session, after
 * which a binary term scores every possible arrangement identically and stops
 * steering anything. Measured over ten sessions that left some pairs together
 * three times as often as others, which is exactly the "I always play with the
 * same person" complaint. Counting keeps the spread near one game.
 */
const PARTNER_WEIGHT = 10;
const OPPONENT_WEIGHT = 1;
/**
 * How much one rating point of imbalance costs, in balanced mode only. At 2, a
 * repeat partnership (10) is worth five rating points — so the engine will
 * accept playing with the same partner again to make a match five points
 * fairer. Balance leads, which is the whole reason for choosing this mode,
 * while variety still separates arrangements that are level on skill.
 *
 * Tuned by measurement, not taste. Over 40 sessions the previous weight left
 * an average gap of 212 when the search could reach 0 on the same players;
 * this brings it to about 90 with no measurable cost to partner variety, and
 * a four-player group — where only one split is balanced — still rotates
 * across splits rather than pinning to it.
 */
const BALANCE_WEIGHT = 2;

export interface HistoryFloors {
  partner: number;
  opponent: number;
}

/**
 * The least any pair among these players has partnered, and likewise faced
 * each other. Scoring the excess over that floor rather than the raw count is
 * what keeps the scale stable: a group where everyone has partnered everyone
 * forty times is perfectly varied, and should score the same as one on its
 * first night, not four hundred times worse. Without it every other constant
 * here quietly loses its meaning as a group accumulates history.
 */
export function historyFloors(
  players: PlayerId[],
  partnerCounts: Map<string, number>,
  opponentCounts: Map<string, number>
): HistoryFloors {
  let partner = Infinity;
  let opponent = Infinity;
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const key = pairKey(players[i], players[j]);
      partner = Math.min(partner, partnerCounts.get(key) ?? 0);
      opponent = Math.min(opponent, opponentCounts.get(key) ?? 0);
    }
  }
  return {
    partner: Number.isFinite(partner) ? partner : 0,
    opponent: Number.isFinite(opponent) ? opponent : 0,
  };
}

export function scoreArrangement(
  courts: { teamA: [PlayerId, PlayerId]; teamB: [PlayerId, PlayerId] }[],
  partnerCounts: Map<string, number>,
  opponentCounts: Map<string, number>,
  ratings?: Map<PlayerId, number>,
  floors: HistoryFloors = { partner: 0, opponent: 0 }
): number {
  let score = 0;

  for (const { teamA, teamB } of courts) {
    const partnerPairs = [pairKey(teamA[0], teamA[1]), pairKey(teamB[0], teamB[1])];
    for (const key of partnerPairs) {
      score += PARTNER_WEIGHT * Math.max(0, (partnerCounts.get(key) ?? 0) - floors.partner);
    }

    const opponentPairs = [
      pairKey(teamA[0], teamB[0]),
      pairKey(teamA[0], teamB[1]),
      pairKey(teamA[1], teamB[0]),
      pairKey(teamA[1], teamB[1]),
    ];
    for (const key of opponentPairs) {
      score += OPPONENT_WEIGHT * Math.max(0, (opponentCounts.get(key) ?? 0) - floors.opponent);
    }

    // Only in balanced mode. Without ratings the term vanishes entirely, so
    // variety mode scores exactly as it always did.
    if (ratings) {
      score += ratingGap(teamA, teamB, ratings) * BALANCE_WEIGHT;
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
  avoidSplit?: { teamA: [PlayerId, PlayerId]; teamB: [PlayerId, PlayerId] },
  /** Supplied only in balanced mode; omitted, behaviour is unchanged. */
  ratings?: Map<PlayerId, number>
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

  // Applies to the first court, which is the one a reshuffle commits — and
  // regardless of how many courts are being planned. Gating it on a single
  // court silently lost the guard as soon as a second court sat idle.
  const avoidKeys = avoidSplit
    ? new Set([
        pairKey(avoidSplit.teamA[0], avoidSplit.teamA[1]),
        pairKey(avoidSplit.teamB[0], avoidSplit.teamB[1]),
      ])
    : null;

  const floors = historyFloors(playing, history.partnerCounts, history.opponentCounts);

  let best: CourtAssignment[] | null = null;
  let bestScore = Infinity;
  // Kept only for the case where every trial reproduces the split, which means
  // no alternative exists. Handing back a repeat beats handing back nothing.
  let fallback: CourtAssignment[] | null = null;
  let fallbackScore = Infinity;

  for (let trial = 0; trial < SEARCH_TRIALS; trial++) {
    const candidate = buildRandomArrangement(playing, usableCourts, random);
    const score = scoreArrangement(
      candidate,
      history.partnerCounts,
      history.opponentCounts,
      ratings,
      floors
    );

    // An exclusion rather than a penalty. A penalty has to be a number larger
    // than any real score difference, and no fixed number stays larger as a
    // group accumulates history — the old 1000 was already being outweighed
    // after about thirty sessions of eight-player play.
    if (avoidKeys) {
      const [c] = candidate;
      const candidateKeys = new Set([
        pairKey(c.teamA[0], c.teamA[1]),
        pairKey(c.teamB[0], c.teamB[1]),
      ]);
      const isSameSplit =
        candidateKeys.size === avoidKeys.size &&
        [...candidateKeys].every((k) => avoidKeys.has(k));
      if (isSameSplit) {
        if (score < fallbackScore) {
          fallbackScore = score;
          fallback = candidate;
        }
        continue;
      }
    }

    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return { courts: (best ?? fallback) as CourtAssignment[], sittingOut };
}
