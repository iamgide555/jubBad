/**
 * The one-swap variety step (2026-11-06): with players sitting out, the ones
 * who sat all walked off the same court and would otherwise go back on
 * together as a block. A games-queued selection may trade one natural player
 * for one same-games sitter when that scores strictly better on the mode's own
 * objective. See docs/overview.md, "Sit-out selection".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completeCourt, generateRound, pairKey, type MatchHistory, type PlayerId } from './pairing.ts';
import type { PairRule } from './pair-rules.ts';

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const TRIO = ['a', 'b', 'c'];
const FINISHERS = ['d', 'e', 'f', 'g'];
const POOL = [...TRIO, ...FINISHERS];

/**
 * The sticky trio: a, b and c sat out together (wait began at 1000) while d–g
 * just walked off (2000). Everyone is on two games. The trio has partnered each
 * other, so any four holding all three must repeat a partner pair.
 */
function stickyTrio(overrides: Partial<MatchHistory> = {}): MatchHistory {
  const partnerCounts = new Map<string, number>([
    [pairKey('a', 'b'), 1],
    [pairKey('a', 'c'), 1],
    [pairKey('b', 'c'), 1],
  ]);
  const opponentCounts = new Map<string, number>([
    [pairKey('a', 'b'), 3],
    [pairKey('a', 'c'), 2],
    [pairKey('b', 'c'), 2],
  ]);
  return {
    partnerCounts,
    opponentCounts,
    gamesPlayedThisSession: new Map(POOL.map((p) => [p, 2])),
    waitingSince: new Map(POOL.map((p) => [p, TRIO.includes(p) ? 1000 : 2000])),
    ...overrides,
  };
}

function playersOf(court: { teamA: PlayerId[]; teamB: PlayerId[] }): PlayerId[] {
  return [...court.teamA, ...court.teamB];
}

function trioOnCourt(court: { teamA: PlayerId[]; teamB: PlayerId[] }): number {
  return playersOf(court).filter((p) => TRIO.includes(p)).length;
}

test('swap: a sticky trio is split up when a same-games finisher is available', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const { courts, sittingOut } = generateRound(POOL, 1, stickyTrio(), seeded(seed));
    assert.equal(trioOnCourt(courts[0]), 2, `seed ${seed}`);
    assert.equal(sittingOut.length, 3);
    assert.deepEqual(
      [...playersOf(courts[0]), ...sittingOut].sort(),
      [...POOL].sort(),
      'sittingOut is exactly the free players not chosen'
    );
  }
});

test('swap: with no history the natural selection stands', () => {
  const history = stickyTrio({ partnerCounts: new Map(), opponentCounts: new Map() });
  for (let seed = 1; seed <= 20; seed++) {
    const { courts } = generateRound(POOL, 1, history, seeded(seed));
    assert.equal(trioOnCourt(courts[0]), 3, `seed ${seed}`);
  }
});

test('swap: never seats a player with more games than the one passed over', () => {
  const games = new Map(POOL.map((p) => [p, TRIO.includes(p) ? 2 : 3]));
  for (let seed = 1; seed <= 20; seed++) {
    const { courts } = generateRound(POOL, 1, stickyTrio({ gamesPlayedThisSession: games }), seeded(seed));
    assert.equal(trioOnCourt(courts[0]), 3, `seed ${seed}`);
  }
});

test('swap: the single longest waiter always plays', () => {
  // a waited longest, and every four with a scores worse than one without.
  const partnerCounts = new Map<string, number>();
  const opponentCounts = new Map<string, number>();
  for (const other of POOL) {
    if (other === 'a') continue;
    partnerCounts.set(pairKey('a', other), 1);
    opponentCounts.set(pairKey('a', other), 3);
  }
  const waitingSince = new Map(POOL.map((p) => [p, p === 'a' ? 500 : TRIO.includes(p) ? 1000 : 2000]));
  for (let seed = 1; seed <= 20; seed++) {
    const { courts } = generateRound(
      POOL,
      1,
      stickyTrio({ partnerCounts, opponentCounts, waitingSince }),
      seeded(seed)
    );
    assert.ok(playersOf(courts[0]).includes('a'), `seed ${seed}`);
  }
});

test('swap: a player who needs rest is never swapped in ahead of the queue', () => {
  const history = stickyTrio({ needsRest: new Set(FINISHERS) });
  for (let seed = 1; seed <= 20; seed++) {
    const { courts } = generateRound(POOL, 1, history, seeded(seed));
    assert.equal(trioOnCourt(courts[0]), 3, `seed ${seed}`);
  }
});

test('swap: needsRest does not stop a player the queue already seats', () => {
  // The natural fourth seat goes to one finisher; needing rest only blocks a
  // swap, so the trio still breaks up via the other (rested) finishers.
  const history = stickyTrio({ needsRest: new Set(['d', 'e']) });
  for (let seed = 1; seed <= 20; seed++) {
    const { courts } = generateRound(POOL, 1, history, seeded(seed));
    const on = playersOf(courts[0]);
    assert.equal(trioOnCourt(courts[0]), 2, `seed ${seed}`);
    assert.ok(on.includes('f') || on.includes('g'), `seed ${seed}: a rested finisher was swapped in`);
  }
});

test('swap: the level queue (wait order) is left strict', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const { courts } = generateRound(
      POOL,
      1,
      stickyTrio(),
      seeded(seed),
      undefined,
      undefined,
      new Map(POOL.map((p) => [p, null])),
      true,
      'wait'
    );
    assert.equal(trioOnCourt(courts[0]), 3, `seed ${seed}`);
  }
});

test('swap: a reshuffle keeps the same players and only re-splits', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const first = generateRound(POOL, 1, stickyTrio({ partnerCounts: new Map() }), seeded(seed)).courts[0];
    const again = generateRound(POOL, 1, stickyTrio(), seeded(seed + 100), {
      teamA: first.teamA,
      teamB: first.teamB,
    }).courts[0];
    assert.equal(trioOnCourt(again), 3, `seed ${seed}`);
  }
});

test('swap: balanced mode also splits the trio when ratings are level', () => {
  const ratings = new Map(POOL.map((p) => [p, 1200]));
  for (let seed = 1; seed <= 20; seed++) {
    const { courts } = generateRound(POOL, 1, stickyTrio(), seeded(seed), undefined, ratings);
    assert.equal(trioOnCourt(courts[0]), 2, `seed ${seed}`);
  }
});

test('swap: across two idle courts the trio is still split, games fairness kept', () => {
  // 11 players, two courts idle at once, three sit. h–k sat out with the trio's
  // wait but one more game, so they must not displace anyone with fewer games.
  const roster = [...POOL, 'h', 'i', 'j', 'k'];
  const history = stickyTrio({
    gamesPlayedThisSession: new Map(roster.map((p) => [p, 2])),
    waitingSince: new Map(roster.map((p) => [p, TRIO.includes(p) ? 1000 : 2000])),
  });
  for (let seed = 1; seed <= 10; seed++) {
    const { courts, sittingOut } = generateRound(roster, 2, history, seeded(seed));
    assert.equal(courts.length, 2);
    assert.equal(sittingOut.length, 3);
    const onCourts = courts.flatMap(playersOf);
    // All three trio players can still play — but never all on one court.
    for (const court of courts) assert.ok(trioOnCourt(court) <= 2, `seed ${seed}`);
    assert.equal(new Set([...onCourts, ...sittingOut]).size, roster.length);
  }
});

test('swap: a must-pair duo is never split and the trio still breaks up', () => {
  const rules: PairRule[] = [{ id: 'r1', playerAId: 'd', playerBId: 'e', kind: 'must-pair' }];
  for (let seed = 1; seed <= 20; seed++) {
    const { courts } = generateRound(
      POOL,
      1,
      stickyTrio(),
      seeded(seed),
      undefined,
      undefined,
      undefined,
      false,
      'games',
      undefined,
      undefined,
      rules
    );
    const on = playersOf(courts[0]);
    assert.equal(on.includes('d'), on.includes('e'), `seed ${seed}: duo split`);
    assert.equal(trioOnCourt(courts[0]), 2, `seed ${seed}`);
  }
});

test('swap: custom fill of an empty court splits the trio too', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const filled = completeCourt(
      { teamA: [null, null], teamB: [null, null] },
      POOL,
      stickyTrio(),
      seeded(seed)
    );
    assert.ok(filled);
    assert.equal(trioOnCourt(filled), 2, `seed ${seed}`);
  }
});

test('swap: custom fill never moves a host-seated player and respects games', () => {
  const games = new Map(POOL.map((p) => [p, TRIO.includes(p) ? 2 : 3]));
  for (let seed = 1; seed <= 20; seed++) {
    const filled = completeCourt(
      { teamA: ['a', null], teamB: [null, null] },
      POOL.filter((p) => p !== 'a'),
      stickyTrio({ gamesPlayedThisSession: games }),
      seeded(seed)
    );
    assert.ok(filled);
    assert.equal(filled.teamA[0], 'a');
    assert.equal(trioOnCourt(filled), 3, `seed ${seed}: b and c have fewer games and must play`);
  }
});
