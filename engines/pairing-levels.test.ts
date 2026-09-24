import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectSittingOut,
  generateRound,
  groupKey,
  type MatchHistory,
} from './pairing.ts';
import type { Level } from './levels.ts';

function empty(): MatchHistory {
  return {
    partnerCounts: new Map(),
    opponentCounts: new Map(),
    gamesPlayedThisSession: new Map(),
  };
}

function makeSeededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function levelsOf(record: Record<string, Level>): Map<string, Level> {
  return new Map(Object.entries(record));
}

/** Max pairwise level-index gap on a court, ignoring unknown (null) levels. -1 if nobody has a known level. */
function courtLevelSpread(players: string[], levels: Map<string, Level>): number {
  const LEVELS = ['BG', 'N', 'S', 'P-', 'P', 'P+', 'C', 'B'];
  const indices = players
    .map((p) => levels.get(p))
    .filter((l): l is Level => l !== undefined)
    .map((l) => LEVELS.indexOf(l));
  if (indices.length === 0) return -1;
  return Math.max(...indices) - Math.min(...indices);
}

test('band off: a levels map has no effect on the round', () => {
  const roster = ['n1', 'n2', 'n3', 'n4', 'p1', 'p2', 'p3', 'p4'];
  const levels = levelsOf({
    n1: 'N', n2: 'N', n3: 'N', n4: 'N', p1: 'P+', p2: 'P+', p3: 'P+', p4: 'P+',
  });
  const withLevels = generateRound(roster, 2, empty(), makeSeededRandom(7), undefined, undefined, levels, false);
  const withoutLevels = generateRound(roster, 2, empty(), makeSeededRandom(7), undefined, undefined, undefined, false);
  assert.deepEqual(withLevels, withoutLevels);
});

test('band on, 4N + 4P+ on 2 courts: the exhaustive search never mixes them', () => {
  const roster = ['n1', 'n2', 'n3', 'n4', 'p1', 'p2', 'p3', 'p4'];
  const levels = levelsOf({
    n1: 'N', n2: 'N', n3: 'N', n4: 'N', p1: 'P+', p2: 'P+', p3: 'P+', p4: 'P+',
  });
  for (let seed = 1; seed <= 20; seed++) {
    const { courts } = generateRound(roster, 2, empty(), makeSeededRandom(seed), undefined, undefined, levels, true);
    for (const court of courts) {
      const players = [...court.teamA, ...court.teamB];
      assert.equal(courtLevelSpread(players, levels), 0, `seed ${seed}: court mixed N and P+`);
    }
  }
});

test('band on, 3 P+ + 5 N on 2 courts: exactly one court breaks the band', () => {
  const roster = ['p1', 'p2', 'p3', 'n1', 'n2', 'n3', 'n4', 'n5'];
  const levels = levelsOf({
    p1: 'P+', p2: 'P+', p3: 'P+', n1: 'N', n2: 'N', n3: 'N', n4: 'N', n5: 'N',
  });
  const { courts } = generateRound(roster, 2, empty(), makeSeededRandom(3), undefined, undefined, levels, true);
  const breaking = courts.filter(
    (c) => courtLevelSpread([...c.teamA, ...c.teamB], levels) > 1
  );
  assert.equal(breaking.length, 1);
});

test('band on: selection prefers an all-in-band court over rotation order alone', () => {
  // 4 N players and 2 P+ players, one court of 4. The most-deserving player
  // (fewest games) is an N, so with the band on, the court fills entirely
  // from the other N's rather than pulling in a more-deserving P+.
  const roster = ['n1', 'n2', 'n3', 'n4', 'p1', 'p2'];
  const levels = levelsOf({ n1: 'N', n2: 'N', n3: 'N', n4: 'N', p1: 'P+', p2: 'P+' });
  const gamesPlayedThisSession = new Map([
    ['n1', 0], ['n2', 2], ['n3', 2], ['n4', 3], ['p1', 1], ['p2', 1],
  ]);

  const withoutBand = selectSittingOut(roster, 1, gamesPlayedThisSession, makeSeededRandom(1));
  // Fewest games first: n1(0), p1(1), p2(1), then one of n2/n3 (tied at 2) —
  // either way, both P+ players make the cut ahead of n4, so it's mixed.
  assert.ok(withoutBand.playing.includes('p1') && withoutBand.playing.includes('p2'));

  const withBand = selectSittingOut(
    roster, 1, gamesPlayedThisSession, makeSeededRandom(1), undefined, null, levels, true
  );
  assert.deepEqual([...withBand.playing].sort(), ['n1', 'n2', 'n3', 'n4']);
  assert.deepEqual([...withBand.sittingOut].sort(), ['p1', 'p2']);
});

test('band on: a lone rare-level player still plays when most deserving, despite an unavoidable mismatch', () => {
  const roster = [
    'b1', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n10', 'n11',
  ];
  const levels = new Map<string, Level>([['b1', 'B']]);
  for (let i = 1; i <= 11; i++) levels.set(`n${i}`, 'N');
  const gamesPlayedThisSession = new Map(roster.map((p) => [p, p === 'b1' ? 0 : 1]));

  const { playing, sittingOut } = selectSittingOut(
    roster, 2, gamesPlayedThisSession, makeSeededRandom(5), undefined, null, levels, true
  );
  assert.ok(playing.includes('b1'), 'the most-deserving player must never be excluded by the band');
  assert.equal(playing.length, 8);
  assert.equal(sittingOut.length, 4);
});

test('band on: never leaves a court empty when a full court of players is offered', () => {
  const roster = ['b1', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'];
  const levels = new Map<string, Level>([['b1', 'B']]);
  for (let i = 1; i <= 7; i++) levels.set(`n${i}`, 'N');
  const { courts, sittingOut } = generateRound(
    roster, 2, empty(), makeSeededRandom(2), undefined, undefined, levels, true
  );
  assert.equal(courts.length, 2);
  assert.equal(sittingOut.length, 0);
  const seated = courts.flatMap((c) => [...c.teamA, ...c.teamB]);
  assert.deepEqual([...seated].sort(), [...roster].sort());
});

test('band on: groupRepeat still dominates the band key', () => {
  // A single idle court, one recent group would recreate. With enough
  // in-band alternatives, the band selection must not force the repeat.
  const roster = ['n1', 'n2', 'n3', 'n4', 'n5'];
  const levels = levelsOf({ n1: 'N', n2: 'N', n3: 'N', n4: 'N', n5: 'N' });
  const history: MatchHistory = {
    ...empty(),
    recentGroupKeys: new Set([groupKey(['n1', 'n2', 'n3', 'n4'])]),
  };
  const { courts } = generateRound(roster, 1, history, makeSeededRandom(4), undefined, undefined, levels, true);
  const seated = groupKey([...courts[0].teamA, ...courts[0].teamB]);
  assert.notEqual(seated, groupKey(['n1', 'n2', 'n3', 'n4']));
});

test('band on: a court never spans more than one level, even when both neighbours of the anchor are queued ahead', () => {
  // The anchor (P) is within one level of both P- and P+, but P- and P+ are
  // two apart from each other. Admitting both breaks the band on a court the
  // search cannot repair, since one idle court has nothing to swap with.
  const roster = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const levels = levelsOf({ a: 'P', b: 'P-', c: 'P+', d: 'P-', e: 'P+', f: 'P', g: 'BG' });
  const gamesPlayedThisSession = new Map([
    ['a', 0], ['b', 1], ['c', 2], ['d', 3], ['e', 4], ['f', 5], ['g', 6],
  ]);
  const { playing } = selectSittingOut(
    roster, 1, gamesPlayedThisSession, makeSeededRandom(1), undefined, null, levels, true
  );
  assert.equal(playing.length, 4);
  assert.ok(playing.includes('a'), 'the most-deserving player still anchors the court');
  assert.ok(courtLevelSpread(playing, levels) <= 1, `court spans ${courtLevelSpread(playing, levels)} levels`);
});
