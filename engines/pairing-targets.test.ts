import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateRound, selectSittingOut, type MatchHistory, type CourtAssignment } from './pairing.ts';
import { splitTonight, type CourtTarget, type Level } from './levels.ts';

function empty(): MatchHistory {
  return { partnerCounts: new Map(), opponentCounts: new Map(), gamesPlayedThisSession: new Map() };
}

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

const levelsOf = (record: Record<string, Level | null>): Map<string, Level | null> =>
  new Map(Object.entries(record));

const playersOf = (c: CourtAssignment): string[] => [...c.teamA, ...c.teamB];

function round(
  roster: string[],
  courts: number,
  levels: Map<string, Level | null>,
  targets: CourtTarget[] | undefined,
  seed: number,
  extra: { rules?: Parameters<typeof generateRound>[11]; history?: MatchHistory } = {}
) {
  const targeting = targets ? { courtTargets: targets, split: splitTonight(levels, roster) } : undefined;
  return generateRound(
    roster,
    courts,
    extra.history ?? empty(),
    seeded(seed),
    undefined,
    undefined,
    levels,
    true,
    'wait',
    undefined,
    undefined,
    extra.rules,
    'requested',
    undefined,
    targeting
  );
}

const MIXED = ['n1', 'n2', 'n3', 'n4', 'p1', 'p2', 'p3', 'p4'];
const MIXED_LEVELS = levelsOf({
  n1: 'N', n2: 'N', n3: 'N', n4: 'N', p1: 'P+', p2: 'P+', p3: 'P+', p4: 'P+',
});

test('court 1 High / court 2 Low: pros on court 1, beginners on court 2, whatever the seed', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const { courts } = round(MIXED, 2, MIXED_LEVELS, ['high', 'low'], seed);
    assert.equal(courts.length, 2);
    const byCourt = new Map(courts.map((c) => [c.court, playersOf(c)]));
    assert.ok(byCourt.get(1)!.every((p) => p.startsWith('p')), `seed ${seed}: court 1 not all pros`);
    assert.ok(byCourt.get(2)!.every((p) => p.startsWith('n')), `seed ${seed}: court 2 not all beginners`);
  }
});

test('court 1 Low / court 2 High: the mirror image holds (the head player is not pinned to court 1)', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const { courts } = round(MIXED, 2, MIXED_LEVELS, ['low', 'high'], seed);
    const byCourt = new Map(courts.map((c) => [c.court, playersOf(c)]));
    assert.ok(byCourt.get(1)!.every((p) => p.startsWith('n')), `seed ${seed}`);
    assert.ok(byCourt.get(2)!.every((p) => p.startsWith('p')), `seed ${seed}`);
  }
});

test('the requested court alone, High: it takes pros even though beginners waited longer', () => {
  const history: MatchHistory = {
    ...empty(),
    waitingSince: new Map(MIXED.map((p, i) => [p, p.startsWith('n') ? 1000 + i : 5000 + i])),
  };
  for (let seed = 1; seed <= 10; seed++) {
    const { courts } = round(MIXED, 1, MIXED_LEVELS, ['high'], seed, { history });
    assert.ok(playersOf(courts[0]).every((p) => p.startsWith('p')), `seed ${seed}`);
  }
});

test('all Auto, or no targeting at all, is byte-identical to the old behaviour', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const plain = round(MIXED, 2, MIXED_LEVELS, undefined, seed);
    assert.deepEqual(round(MIXED, 2, MIXED_LEVELS, ['auto', 'auto'], seed), plain);
  }
});

test('a roster with no usable split ignores the targets entirely', () => {
  const flat = levelsOf(Object.fromEntries(MIXED.map((p) => [p, 'P' as Level])));
  for (let seed = 1; seed <= 10; seed++) {
    assert.deepEqual(round(MIXED, 2, flat, ['high', 'low'], seed), round(MIXED, 2, flat, undefined, seed));
  }
});

test('soft: too few pros leaves a High court full, never empty', () => {
  const roster = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'p1', 'p2'];
  const levels = levelsOf({
    n1: 'N', n2: 'N', n3: 'N', n4: 'N', n5: 'N', n6: 'N', p1: 'P+', p2: 'P+',
  });
  for (let seed = 1; seed <= 10; seed++) {
    const { courts } = round(roster, 2, levels, ['high', 'low'], seed);
    assert.equal(courts.length, 2);
    for (const c of courts) assert.equal(playersOf(c).length, 4);
    const high = playersOf(courts.find((c) => c.court === 1)!);
    assert.ok(high.includes('p1') && high.includes('p2'), `seed ${seed}: pros not together on the High court`);
  }
});

test('untagged players fit either court', () => {
  const roster = ['n1', 'n2', 'n3', 'x1', 'p1', 'p2', 'p3', 'x2'];
  const levels = levelsOf({
    n1: 'N', n2: 'N', n3: 'N', x1: null, p1: 'P+', p2: 'P+', p3: 'P+', x2: null,
  });
  for (let seed = 1; seed <= 10; seed++) {
    const { courts } = round(roster, 2, levels, ['high', 'low'], seed);
    for (const c of courts) {
      const players = playersOf(c);
      if (c.court === 1) assert.ok(!players.some((p) => p.startsWith('n')), `seed ${seed}`);
      else assert.ok(!players.some((p) => p.startsWith('p')), `seed ${seed}`);
    }
  }
});

test('more than eight players (local search): High court of pros, Low court of beginners', () => {
  const roster = [...Array(6)].map((_, i) => `n${i}`).concat([...Array(6)].map((_, i) => `p${i}`));
  const levels = levelsOf(Object.fromEntries(roster.map((p) => [p, p.startsWith('n') ? 'N' : 'P+'])));
  for (let seed = 1; seed <= 15; seed++) {
    const { courts } = round(roster, 3, levels, ['high', 'low', 'auto'], seed);
    const byCourt = new Map(courts.map((c) => [c.court, playersOf(c)]));
    assert.ok(byCourt.get(1)!.every((p) => p.startsWith('p')), `seed ${seed}: court 1 ${byCourt.get(1)}`);
    assert.ok(byCourt.get(2)!.every((p) => p.startsWith('n')), `seed ${seed}: court 2 ${byCourt.get(2)}`);
  }
});

test('a targeted court is never given a carry game; an Auto court still can be', () => {
  const history: MatchHistory = {
    ...empty(),
    waitingSince: new Map([['b1', 1000], ['p1', 2000], ['p2', 3000], ['p3', 4000], ['p4', 5000]]),
  };
  const levels = levelsOf({ b1: 'BG', p1: 'P+', p2: 'P+', p3: 'P+', p4: 'P+' });
  const roster = ['b1', 'p1', 'p2', 'p3', 'p4'];
  const targeting = { courtTargets: ['high'] as CourtTarget[], split: splitTonight(levels, roster) };
  const run = (t: typeof targeting | undefined) =>
    generateRound(roster, 1, history, seeded(1), undefined, undefined, levels, true, 'wait',
      new Set(['b1']), new Set(), undefined, 'requested', undefined, t);
  const auto = run(undefined);
  assert.ok(playersOf(auto.courts[0]).includes('b1'), 'baseline: carry puts the beginner on court 1');
  const high = run(targeting);
  assert.ok(!playersOf(high.courts[0]).includes('b1'), 'High court must not take the carry beginner');
});

test('pair rules path: a never-same-court rule still honours targets', () => {
  const rules = [{ id: 'r1', playerAId: 'p1', playerBId: 'p2', kind: 'never-same-court' as const }];
  for (let seed = 1; seed <= 10; seed++) {
    const { courts } = round(MIXED, 2, MIXED_LEVELS, ['high', 'low'], seed, { rules });
    const high = playersOf(courts.find((c) => c.court === 1)!);
    const low = playersOf(courts.find((c) => c.court === 2)!);
    // p1 and p2 cannot share a court, so the High court takes one of them
    // plus three others; the point is the rule holds and nothing throws.
    assert.ok(!(high.includes('p1') && high.includes('p2')), `seed ${seed}`);
    assert.ok(!(low.includes('p1') && low.includes('p2')), `seed ${seed}`);
    assert.ok(high.some((p) => p.startsWith('p')), `seed ${seed}`);
  }
});

test('selectSittingOut: a targeted court draws its players from its own half first', () => {
  const split = splitTonight(MIXED_LEVELS, MIXED);
  const waiting = new Map(MIXED.map((p, i) => [p, p.startsWith('n') ? 100 + i : 900 + i]));
  // Only four seats, beginners waited longest, but the one court is High.
  const { playing } = selectSittingOut(
    MIXED, 1, new Map(), seeded(3), waiting, null, MIXED_LEVELS, true, 'wait', undefined, undefined,
    { courtTargets: ['high'], split }
  );
  assert.ok(playing.every((p) => p.startsWith('p')));
});
