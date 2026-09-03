import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairKey, shuffle, selectSittingOut, scoreArrangement, buildRandomArrangement } from './pairing.ts';

function makeSeededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

test('pairKey is order-independent', () => {
  assert.equal(pairKey('a', 'b'), pairKey('b', 'a'));
});

test('pairKey produces a stable, distinct key per pair', () => {
  assert.equal(pairKey('a', 'b'), 'a|b');
  assert.notEqual(pairKey('a', 'b'), pairKey('a', 'c'));
});

test('shuffle is deterministic for a given random source', () => {
  const result = shuffle(['a', 'b', 'c', 'd', 'e'], makeSeededRandom(42));
  assert.deepEqual(result, ['a', 'b', 'd', 'e', 'c']);
});

test('shuffle does not mutate the input array', () => {
  const input = ['a', 'b', 'c'];
  shuffle(input, makeSeededRandom(1));
  assert.deepEqual(input, ['a', 'b', 'c']);
});

test('shuffle preserves all elements', () => {
  const result = shuffle(['a', 'b', 'c', 'd'], makeSeededRandom(5));
  assert.deepEqual([...result].sort(), ['a', 'b', 'c', 'd']);
});

test('selectSittingOut: roster not a multiple of 4 leaves a remainder sitting out even when courtCount is not exceeded', () => {
  const roster = Array.from({ length: 10 }, (_, i) => `p${i + 1}`);
  const gamesPlayed = new Map([
    ['p1', 3],
    ['p2', 2],
    ['p3', 1],
  ]);
  const result = selectSittingOut(roster, 3, gamesPlayed, makeSeededRandom(7));
  assert.deepEqual(result.sittingOut, ['p1', 'p2']);
  assert.deepEqual(result.playing, ['p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10']);
});

test('selectSittingOut: exact fit means nobody sits out', () => {
  const roster = Array.from({ length: 8 }, (_, i) => `p${i + 1}`);
  const result = selectSittingOut(roster, 2, new Map(), makeSeededRandom(1));
  assert.deepEqual(result.sittingOut, []);
  assert.deepEqual(result.playing, roster);
});

test('selectSittingOut: fewer than 4 players means everyone sits out', () => {
  const result = selectSittingOut(['a', 'b', 'c'], 1, new Map(), makeSeededRandom(1));
  assert.deepEqual(result.playing, []);
  assert.deepEqual(result.sittingOut, ['c', 'a', 'b']);
});

test('scoreArrangement matches the PROJECT.md §6.3 worked example', () => {
  const partnerCounts = new Map([[pairKey('tam', 'base'), 2]]);
  const opponentCounts = new Map([[pairKey('pom', 'mai'), 3]]);

  const repeatsPartner = [{ teamA: ['tam', 'base'] as [string, string], teamB: ['pom', 'mai'] as [string, string] }];
  const tiedA = [{ teamA: ['tam', 'pom'] as [string, string], teamB: ['base', 'mai'] as [string, string] }];
  const tiedB = [{ teamA: ['tam', 'mai'] as [string, string], teamB: ['base', 'pom'] as [string, string] }];

  assert.equal(scoreArrangement(repeatsPartner, partnerCounts, opponentCounts), 10);
  assert.equal(scoreArrangement(tiedA, partnerCounts, opponentCounts), 1);
  assert.equal(scoreArrangement(tiedB, partnerCounts, opponentCounts), 1);
});

test('scoreArrangement is 0 when nothing in the arrangement has met before', () => {
  const arrangement = [{ teamA: ['a', 'b'] as [string, string], teamB: ['c', 'd'] as [string, string] }];
  assert.equal(scoreArrangement(arrangement, new Map(), new Map()), 0);
});

test('scoreArrangement sums across multiple courts', () => {
  const partnerCounts = new Map([[pairKey('a', 'b'), 1]]);
  const arrangement = [
    { teamA: ['a', 'b'] as [string, string], teamB: ['c', 'd'] as [string, string] },
    { teamA: ['e', 'f'] as [string, string], teamB: ['g', 'h'] as [string, string] },
  ];
  assert.equal(scoreArrangement(arrangement, partnerCounts, new Map()), 10);
});

test('buildRandomArrangement groups players into the requested number of 4-player courts', () => {
  const playing = Array.from({ length: 8 }, (_, i) => `p${i + 1}`);
  const result = buildRandomArrangement(playing, 2, makeSeededRandom(3));
  assert.deepEqual(result, [
    { court: 1, teamA: ['p4', 'p3'], teamB: ['p1', 'p7'] },
    { court: 2, teamA: ['p6', 'p8'], teamB: ['p2', 'p5'] },
  ]);
});

test('buildRandomArrangement includes every playing player exactly once', () => {
  const playing = Array.from({ length: 8 }, (_, i) => `p${i + 1}`);
  const result = buildRandomArrangement(playing, 2, makeSeededRandom(11));
  const allAssigned = result.flatMap((c) => [...c.teamA, ...c.teamB]);
  assert.deepEqual([...allAssigned].sort(), [...playing].sort());
});
