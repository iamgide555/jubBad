import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairKey, shuffle, selectSittingOut } from './pairing.ts';

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
