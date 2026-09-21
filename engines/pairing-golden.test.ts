/**
 * Golden fixture for today's doubles-only behaviour, recorded from
 * `generateRound` before the per-court-size generalization (see
 * docs/archive/plans/2026-09-05-review-and-v2-backlog.md and the singles/doubles design
 * work). Every entry here is committed output, not a re-derived expectation —
 * the refactor that follows must reproduce it exactly, byte for byte.
 *
 * This file is deliberately never touched by that refactor. If a change to
 * `engines/pairing.ts` needs an edit here, that is the signal to stop and
 * check whether doubles behaviour actually moved — which the plan promised it
 * would not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateRound, type MatchHistory } from './pairing.ts';

function makeSeededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function roster(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `p${i + 1}`);
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

function emptyHistory(overrides: Partial<MatchHistory> = {}): MatchHistory {
  return {
    partnerCounts: new Map(),
    opponentCounts: new Map(),
    gamesPlayedThisSession: new Map(),
    ...overrides,
  };
}

test('golden: plain rounds across roster/court-count combinations', () => {
  const cases: { roster: number; courts: number; seed: number }[] = [
    { roster: 4, courts: 1, seed: 1 },
    { roster: 8, courts: 2, seed: 2 },
    { roster: 8, courts: 1, seed: 3 },
    { roster: 12, courts: 3, seed: 4 },
    { roster: 12, courts: 2, seed: 5 },
    { roster: 13, courts: 3, seed: 6 },
    { roster: 16, courts: 4, seed: 7 },
    { roster: 24, courts: 6, seed: 8 },
    { roster: 6, courts: 3, seed: 9 },
  ];

  const expected = [
    {
      courts: [{ court: 1, teamA: ['p2', 'p4'], teamB: ['p1', 'p3'] }],
      sittingOut: [],
    },
    {
      courts: [
        { court: 1, teamA: ['p8', 'p3'], teamB: ['p4', 'p6'] },
        { court: 2, teamA: ['p7', 'p2'], teamB: ['p5', 'p1'] },
      ],
      sittingOut: [],
    },
    {
      courts: [{ court: 1, teamA: ['p8', 'p2'], teamB: ['p5', 'p6'] }],
      sittingOut: ['p4', 'p3', 'p1', 'p7'],
    },
    {
      courts: [
        { court: 1, teamA: ['p8', 'p2'], teamB: ['p11', 'p12'] },
        { court: 2, teamA: ['p5', 'p7'], teamB: ['p4', 'p3'] },
        { court: 3, teamA: ['p10', 'p6'], teamB: ['p9', 'p1'] },
      ],
      sittingOut: [],
    },
    {
      courts: [
        { court: 1, teamA: ['p11', 'p12'], teamB: ['p1', 'p6'] },
        { court: 2, teamA: ['p10', 'p3'], teamB: ['p9', 'p7'] },
      ],
      sittingOut: ['p4', 'p5', 'p8', 'p2'],
    },
    {
      courts: [
        { court: 1, teamA: ['p9', 'p5'], teamB: ['p3', 'p7'] },
        { court: 2, teamA: ['p12', 'p13'], teamB: ['p1', 'p4'] },
        { court: 3, teamA: ['p2', 'p10'], teamB: ['p6', 'p8'] },
      ],
      sittingOut: ['p11'],
    },
    {
      courts: [
        { court: 1, teamA: ['p11', 'p3'], teamB: ['p15', 'p4'] },
        { court: 2, teamA: ['p14', 'p2'], teamB: ['p7', 'p1'] },
        { court: 3, teamA: ['p16', 'p12'], teamB: ['p6', 'p9'] },
        { court: 4, teamA: ['p13', 'p8'], teamB: ['p5', 'p10'] },
      ],
      sittingOut: [],
    },
    {
      courts: [
        { court: 1, teamA: ['p20', 'p10'], teamB: ['p17', 'p8'] },
        { court: 2, teamA: ['p16', 'p12'], teamB: ['p5', 'p11'] },
        { court: 3, teamA: ['p23', 'p2'], teamB: ['p24', 'p21'] },
        { court: 4, teamA: ['p18', 'p22'], teamB: ['p15', 'p14'] },
        { court: 5, teamA: ['p7', 'p13'], teamB: ['p9', 'p4'] },
        { court: 6, teamA: ['p1', 'p6'], teamB: ['p19', 'p3'] },
      ],
      sittingOut: [],
    },
    {
      courts: [{ court: 1, teamA: ['p4', 'p1'], teamB: ['p5', 'p2'] }],
      sittingOut: ['p3', 'p6'],
    },
  ];

  cases.forEach((c, i) => {
    const result = generateRound(roster(c.roster), c.courts, emptyHistory(), makeSeededRandom(c.seed));
    assert.deepEqual(result, expected[i], `case ${i}: roster=${c.roster} courts=${c.courts} seed=${c.seed}`);
  });
});

test('golden: partner/opponent history and games-played steer the round', () => {
  const partnerCounts = new Map([[pairKey('p1', 'p2'), 3], [pairKey('p3', 'p4'), 1]]);
  const opponentCounts = new Map([[pairKey('p1', 'p5'), 2]]);
  const gamesPlayedThisSession = new Map([['p1', 2], ['p2', 1]]);
  const result = generateRound(
    roster(12),
    3,
    emptyHistory({ partnerCounts, opponentCounts, gamesPlayedThisSession }),
    makeSeededRandom(11)
  );
  assert.deepEqual(result, {
    courts: [
      { court: 1, teamA: ['p6', 'p2'], teamB: ['p10', 'p1'] },
      { court: 2, teamA: ['p12', 'p7'], teamB: ['p11', 'p4'] },
      { court: 3, teamA: ['p3', 'p9'], teamB: ['p5', 'p8'] },
    ],
    sittingOut: [],
  });
});

test('golden: avoidSplit excludes the named doubles split', () => {
  const avoidSplit = { teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] };
  const result = generateRound(roster(8), 2, emptyHistory(), makeSeededRandom(12), avoidSplit);
  assert.deepEqual(result, {
    courts: [
      { court: 1, teamA: ['p3', 'p1'], teamB: ['p8', 'p6'] },
      { court: 2, teamA: ['p5', 'p4'], teamB: ['p7', 'p2'] },
    ],
    sittingOut: [],
  });
});

test('golden: recentGroupKeys steers a single-court round away from a repeat quartet', () => {
  const recentGroupKeys = new Set([['p1', 'p2', 'p3', 'p4'].sort().join('|')]);
  const result = generateRound(roster(4), 1, emptyHistory({ recentGroupKeys }), makeSeededRandom(13));
  assert.deepEqual(result, {
    courts: [{ court: 1, teamA: ['p4', 'p1'], teamB: ['p2', 'p3'] }],
    sittingOut: [],
  });
});

test('golden: balanced mode with ratings', () => {
  const ratings = new Map([
    ['p1', 1300],
    ['p2', 1250],
    ['p3', 1100],
    ['p4', 1150],
    ['p5', 1400],
    ['p6', 1000],
    ['p7', 1200],
    ['p8', 1200],
  ]);
  const result = generateRound(roster(8), 2, emptyHistory(), makeSeededRandom(14), undefined, ratings);
  assert.deepEqual(result, {
    courts: [
      { court: 1, teamA: ['p1', 'p3'], teamB: ['p8', 'p7'] },
      { court: 2, teamA: ['p5', 'p6'], teamB: ['p4', 'p2'] },
    ],
    sittingOut: [],
  });
});

test('golden: waitingSince breaks games-played ties for who sits', () => {
  const gamesPlayedThisSession = new Map([
    ['p1', 1],
    ['p2', 1],
    ['p3', 1],
    ['p4', 1],
    ['p5', 1],
    ['p6', 1],
  ]);
  const waitingSince = new Map([
    ['p1', 100],
    ['p2', 200],
    ['p3', 300],
    ['p4', 400],
    ['p5', 500],
    ['p6', 600],
  ]);
  const result = generateRound(
    roster(6),
    1,
    emptyHistory({ gamesPlayedThisSession, waitingSince }),
    makeSeededRandom(15)
  );
  assert.deepEqual(result, {
    courts: [{ court: 1, teamA: ['p3', 'p1'], teamB: ['p4', 'p2'] }],
    sittingOut: ['p6', 'p5'],
  });
});
