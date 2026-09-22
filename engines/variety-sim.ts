/**
 * Pure harness measuring whether the real pairing engine delivers more
 * partner variety over a season than two naive baselines. No schema change,
 * no server dependency — see docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md,
 * section C14.
 */

import { pairKey, shuffle, type PlayerId } from './pairing.ts';

export function makeSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export interface SimScenario {
  playerCount: number;
  minAttend: number;
  maxAttend: number;
  courts: number;
  matchesPerCourt: number;
  nights: number;
  minDurationMin: number;
  maxDurationMin: number;
}

export const DEFAULT_SCENARIO: SimScenario = {
  playerCount: 16,
  minAttend: 12,
  maxAttend: 14,
  courts: 3,
  matchesPerCourt: 8,
  nights: 12,
  minDurationMin: 12,
  maxDurationMin: 18,
};

export function playerIdsFor(scenario: SimScenario): PlayerId[] {
  return Array.from({ length: scenario.playerCount }, (_, i) => `p${i}`);
}

export function generateAttendance(scenario: SimScenario, random: () => number): PlayerId[][] {
  const players = playerIdsFor(scenario);
  const span = scenario.maxAttend - scenario.minAttend;
  const nights: PlayerId[][] = [];
  for (let n = 0; n < scenario.nights; n++) {
    const count = scenario.minAttend + Math.min(span, Math.floor(random() * (span + 1)));
    nights.push(shuffle(players, random).slice(0, count));
  }
  return nights;
}

export function coAttendanceCounts(attendance: PlayerId[][]): Map<string, number> {
  const co = new Map<string, number>();
  for (const night of attendance) {
    for (let i = 0; i < night.length; i++) {
      for (let j = i + 1; j < night.length; j++) {
        const key = pairKey(night[i], night[j]);
        co.set(key, (co.get(key) ?? 0) + 1);
      }
    }
  }
  return co;
}

type Four = [PlayerId, PlayerId, PlayerId, PlayerId];
export type Split = { teamA: [PlayerId, PlayerId]; teamB: [PlayerId, PlayerId] };

/** The three ways to split four players into two teams of two — same table
 *  `pairing-quality.test.ts` uses for its own exhaustive checks. */
const SPLIT_PATTERNS: [number, number, number, number][] = [
  [0, 1, 2, 3],
  [0, 2, 1, 3],
  [0, 3, 1, 2],
];

function splitFromPattern(four: Four, pattern: [number, number, number, number]): Split {
  const [a, b, c, d] = pattern;
  return { teamA: [four[a], four[b]], teamB: [four[c], four[d]] };
}

export function pickRandomSplit(four: Four, random: () => number): Split {
  const pattern = SPLIT_PATTERNS[Math.min(2, Math.floor(random() * 3))];
  return splitFromPattern(four, pattern);
}

/** The baseline PaQueueKa and Doubles Team Maker advertise: never reunite a
 *  player with the partner from their immediately preceding match, unless
 *  every split would. */
export function pickNoBackToBackSplit(
  four: Four,
  lastPartner: Map<PlayerId, PlayerId>,
  random: () => number
): Split {
  const clean = SPLIT_PATTERNS.filter((pattern) => {
    const { teamA, teamB } = splitFromPattern(four, pattern);
    return lastPartner.get(teamA[0]) !== teamA[1] && lastPartner.get(teamB[0]) !== teamB[1];
  });
  const pool = clean.length > 0 ? clean : SPLIT_PATTERNS;
  const pattern = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
  return splitFromPattern(four, pattern);
}
