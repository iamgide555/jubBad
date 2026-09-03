import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairKey, shuffle } from './pairing.ts';

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
