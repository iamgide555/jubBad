/**
 * Search-quality benchmark for the pairing engine.
 *
 * The engine is a heuristic search, so "it returns four players per court" is
 * not enough to know it still works: it can silently get worse while every
 * behavioural test keeps passing. That is exactly what the 2026-09-07 audit
 * found — a fixed 200-candidate random sample never once found the best
 * twelve-player round out of 100 seeded attempts, scoring 41% above optimum.
 *
 * These tests compare the engine against exhaustive enumeration of every
 * possible arrangement, so the target is a real optimum rather than a
 * previous run's output. Baseline of the search this replaced:
 *
 * | Players / courts | Optimum | Old mean | Old optimal runs |
 * |---|---:|---:|---:|
 * | 8 / 2            | 57      | 57.37    | 90/100           |
 * | 12 / 3           | 77      | 108.52   | 0/100            |
 *
 * See docs/2026-09-07-project-audit-and-matchmaking-gaps.md, finding 29.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRandomArrangement,
  generateRound,
  historyFloors,
  pairKey,
  scoreArrangement,
  type CourtAssignment,
  type PlayerId,
} from './pairing.ts';
import type { Level } from './levels.ts';

/**
 * The audit's generator, reproduced exactly so the numbers in the document
 * remain checkable: unsigned 32-bit linear congruential state.
 */
function makeSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function countsFromRounds(rounds: CourtAssignment[][]) {
  const partnerCounts = new Map<string, number>();
  const opponentCounts = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

  for (const round of rounds) {
    for (const { teamA, teamB } of round) {
      bump(partnerCounts, pairKey(teamA[0], teamA[1]));
      bump(partnerCounts, pairKey(teamB[0], teamB[1]));
      for (const a of teamA) for (const b of teamB) bump(opponentCounts, pairKey(a, b));
    }
  }
  return { partnerCounts, opponentCounts };
}

const SPLITS: [number, number, number, number][] = [
  [0, 1, 2, 3],
  [0, 2, 1, 3],
  [0, 3, 1, 2],
];

/**
 * The best score any arrangement of these players can reach. Court scores are
 * independent, so each group of four contributes its own best split and the
 * enumeration only has to cover the ways to partition the players.
 */
function exhaustiveOptimum(
  players: PlayerId[],
  partnerCounts: Map<string, number>,
  opponentCounts: Map<string, number>,
  floors: { partner: number; opponent: number }
): number {
  const bestForGroup = (group: PlayerId[]): number => {
    let best = Infinity;
    for (const [a, b, c, d] of SPLITS) {
      const score = scoreArrangement(
        [{ teamA: [group[a], group[b]], teamB: [group[c], group[d]] }],
        partnerCounts,
        opponentCounts,
        undefined,
        floors
      );
      if (score < best) best = score;
    }
    return best;
  };

  const search = (remaining: PlayerId[]): number => {
    if (remaining.length === 0) return 0;
    const [head, ...rest] = remaining;
    let best = Infinity;
    for (let a = 0; a < rest.length; a++)
      for (let b = a + 1; b < rest.length; b++)
        for (let c = b + 1; c < rest.length; c++) {
          const group = [head, rest[a], rest[b], rest[c]];
          const tail = rest.filter((_, i) => i !== a && i !== b && i !== c);
          const total = bestForGroup(group) + search(tail);
          if (total < best) best = total;
        }
    return best;
  };

  return search(players);
}

function measure(players: PlayerId[], courtCount: number, seeds: number) {
  const historyStream = makeSeededRandom(42);
  const rounds: CourtAssignment[][] = [];
  for (let i = 0; i < 30; i++) {
    rounds.push(buildRandomArrangement(players, courtCount, historyStream));
  }

  const { partnerCounts, opponentCounts } = countsFromRounds(rounds);
  const floors = historyFloors(players, partnerCounts, opponentCounts);
  const optimum = exhaustiveOptimum(players, partnerCounts, opponentCounts, floors);

  let total = 0;
  let worst = -Infinity;
  let optimal = 0;

  for (let seed = 1; seed <= seeds; seed++) {
    const { courts } = generateRound(
      players,
      courtCount,
      { partnerCounts, opponentCounts, gamesPlayedThisSession: new Map() },
      makeSeededRandom(seed)
    );
    const score = scoreArrangement(courts, partnerCounts, opponentCounts, undefined, floors);
    total += score;
    if (score > worst) worst = score;
    if (score === optimum) optimal++;
  }

  return { optimum, mean: total / seeds, worst, optimal, seeds };
}

test('eight players over two courts are paired optimally, every time', () => {
  // 315 arrangements: small enough that the engine enumerates them outright,
  // so this is a guarantee rather than a statistical expectation.
  const players = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const result = measure(players, 2, 100);

  assert.equal(result.optimal, result.seeds, 'every seeded round must hit the exact optimum');
  assert.equal(result.worst, result.optimum);
});

test('twelve players over three courts stay within one point of the optimum', () => {
  // 155,925 arrangements — searched, not enumerated. The old search averaged
  // 108.52 against an optimum of 77 and never once reached it.
  const players = Array.from({ length: 12 }, (_, i) => `p${i}`);
  const result = measure(players, 3, 50);

  assert.ok(
    result.mean <= result.optimum + 0.5,
    `mean ${result.mean} must stay within half a point of optimum ${result.optimum}`
  );
  assert.ok(
    result.worst <= result.optimum + 1,
    `worst ${result.worst} must stay within one point of optimum ${result.optimum}`
  );
  assert.ok(
    result.optimal >= result.seeds * 0.9,
    `${result.optimal}/${result.seeds} runs reached the optimum, expected at least 90%`
  );
});

test('a full twenty-four player, six-court roster is paired without stalling', () => {
  // The largest roster this app realistically sees, and the worst case for a
  // search that grows with the square of the court count. The ceiling is
  // deliberately loose — this catches a complexity regression, not a slow
  // machine. Measured at roughly 170ms when written.
  const players = Array.from({ length: 24 }, (_, i) => `b${i}`);
  const historyStream = makeSeededRandom(7);
  const rounds: CourtAssignment[][] = [];
  for (let i = 0; i < 60; i++) rounds.push(buildRandomArrangement(players, 6, historyStream));
  const { partnerCounts, opponentCounts } = countsFromRounds(rounds);

  const started = performance.now();
  const { courts } = generateRound(
    players,
    6,
    { partnerCounts, opponentCounts, gamesPlayedThisSession: new Map() },
    makeSeededRandom(3)
  );
  const elapsed = performance.now() - started;

  assert.equal(courts.length, 6);
  assert.ok(elapsed < 2000, `pairing took ${elapsed.toFixed(0)}ms, expected well under 2000ms`);
});

/**
 * Mixed-format optimality, checked independently of the doubles-only helpers
 * above (`SPLITS`, `bestForGroup`, `exhaustiveOptimum`) rather than by
 * generalizing them — those exist specifically to be the fixed, trusted
 * oracle for the all-doubles numbers quoted at the top of this file, and
 * must stay exactly as they are for that guarantee to mean anything.
 */
function exhaustiveOptimumMixed(
  players: PlayerId[],
  sizes: number[],
  partnerCounts: Map<string, number>,
  opponentCounts: Map<string, number>,
  floors: { partner: number; opponent: number }
): number {
  const splitsFor = (size: number): number[][][] => {
    // Every way to split a group of `size` into two equal halves, index 0
    // fixed to the first half to avoid double-counting A/B vs B/A.
    const half = size / 2;
    const rest = Array.from({ length: size - 1 }, (_, i) => i + 1);
    const patterns: number[][][] = [];
    const combo: number[] = [];
    const choose = (start: number): void => {
      if (combo.length === half - 1) {
        const aSet = new Set([0, ...combo]);
        const a = [0, ...combo];
        const b = Array.from({ length: size }, (_, i) => i).filter((i) => !aSet.has(i));
        patterns.push([a, b]);
        return;
      }
      for (let i = start; i < rest.length; i++) {
        combo.push(rest[i]);
        choose(i + 1);
        combo.pop();
      }
    };
    choose(0);
    return patterns;
  };

  const bestForGroup = (group: PlayerId[]): number => {
    let best = Infinity;
    for (const [a, b] of splitsFor(group.length)) {
      const score = scoreArrangement(
        [{ teamA: a.map((i) => group[i]), teamB: b.map((i) => group[i]) }],
        partnerCounts,
        opponentCounts,
        undefined,
        floors
      );
      if (score < best) best = score;
    }
    return best;
  };

  // Enumerate every way to partition `players` into groups matching `sizes`
  // in order (position matters no more than it does for the engine itself —
  // the sum over courts is order-independent, so any assignment of groups to
  // positions with the right sizes reaches the same total).
  const search = (remaining: PlayerId[], position: number): number => {
    if (position === sizes.length) return 0;
    const size = sizes[position];
    let best = Infinity;
    const combo: number[] = [];
    const choose = (start: number): void => {
      if (combo.length === size) {
        const comboSet = new Set(combo);
        const group = combo.map((i) => remaining[i]);
        const rest = remaining.filter((_, i) => !comboSet.has(i));
        const total = bestForGroup(group) + search(rest, position + 1);
        if (total < best) best = total;
        return;
      }
      for (let i = start; i < remaining.length; i++) {
        combo.push(i);
        choose(i + 1);
        combo.pop();
      }
    };
    choose(0);
    return best;
  };

  return search(players, 0);
}

function countsFromMixedRounds(rounds: CourtAssignment[][]) {
  const partnerCounts = new Map<string, number>();
  const opponentCounts = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

  for (const round of rounds) {
    for (const { teamA, teamB } of round) {
      for (const team of [teamA, teamB]) {
        for (let i = 0; i < team.length; i++) {
          for (let j = i + 1; j < team.length; j++) bump(partnerCounts, pairKey(team[i], team[j]));
        }
      }
      for (const a of teamA) for (const b of teamB) bump(opponentCounts, pairKey(a, b));
    }
  }
  return { partnerCounts, opponentCounts };
}

test('a mixed singles/doubles round is paired optimally, every time', () => {
  const players = ['a', 'b', 'c', 'd', 'e', 'f'];
  const sizes = [4, 2];
  const historyStream = makeSeededRandom(21);
  const rounds: CourtAssignment[][] = [];
  for (let i = 0; i < 30; i++) {
    rounds.push(generateRound(players, sizes, { partnerCounts: new Map(), opponentCounts: new Map(), gamesPlayedThisSession: new Map() }, historyStream).courts);
  }
  const { partnerCounts, opponentCounts } = countsFromMixedRounds(rounds);
  const floors = historyFloors(players, partnerCounts, opponentCounts);
  const optimum = exhaustiveOptimumMixed(players, sizes, partnerCounts, opponentCounts, floors);

  for (let seed = 1; seed <= 40; seed++) {
    const { courts } = generateRound(
      players,
      sizes,
      { partnerCounts, opponentCounts, gamesPlayedThisSession: new Map() },
      makeSeededRandom(seed)
    );
    const score = scoreArrangement(courts, partnerCounts, opponentCounts, undefined, floors);
    assert.equal(score, optimum, `seed ${seed}: score ${score} must equal optimum ${optimum}`);
  }
});

test('band on: the local search (12 players, above exact-enumeration size) still finds a perfect level partition when one exists', () => {
  // 4 BG + 4 N + 4 P players over 3 courts: a clean per-level partition
  // exists (BG|N|P), so bandBreaks should reach 0 every time, exactly like
  // the unbanded optimum tests above guard the local search against
  // silently regressing on partner/opponent quality.
  const players = [
    ...Array.from({ length: 4 }, (_, i) => `bg${i}`),
    ...Array.from({ length: 4 }, (_, i) => `n${i}`),
    ...Array.from({ length: 4 }, (_, i) => `p${i}`),
  ];
  const levels = new Map<string, Level>([
    ...players.slice(0, 4).map((id): [string, Level] => [id, 'BG']),
    ...players.slice(4, 8).map((id): [string, Level] => [id, 'N']),
    ...players.slice(8, 12).map((id): [string, Level] => [id, 'P']),
  ]);
  const LEVELS = ['BG', 'N', 'S', 'P-', 'P', 'P+', 'C', 'B'];
  const breaksBand = (group: PlayerId[]): boolean => {
    const indices = group.map((id) => LEVELS.indexOf(levels.get(id)!));
    return Math.max(...indices) - Math.min(...indices) > 1;
  };

  for (let seed = 1; seed <= 30; seed++) {
    const { courts } = generateRound(
      players,
      3,
      { partnerCounts: new Map(), opponentCounts: new Map(), gamesPlayedThisSession: new Map() },
      makeSeededRandom(seed),
      undefined,
      undefined,
      levels,
      true
    );
    for (const { teamA, teamB } of courts) {
      assert.equal(breaksBand([...teamA, ...teamB]), false, `seed ${seed}: a court broke the band`);
    }
  }
});

test('the same seed always produces the same round', () => {
  // Reproducibility is what makes every measurement above meaningful, and what
  // lets a reported bad round be replayed.
  const players = Array.from({ length: 12 }, (_, i) => `p${i}`);
  const historyStream = makeSeededRandom(42);
  const rounds: CourtAssignment[][] = [];
  for (let i = 0; i < 30; i++) rounds.push(buildRandomArrangement(players, 3, historyStream));
  const { partnerCounts, opponentCounts } = countsFromRounds(rounds);

  const run = () =>
    generateRound(
      players,
      3,
      { partnerCounts, opponentCounts, gamesPlayedThisSession: new Map() },
      makeSeededRandom(99)
    ).courts;

  assert.deepEqual(run(), run());
});
