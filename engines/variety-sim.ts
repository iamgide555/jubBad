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
