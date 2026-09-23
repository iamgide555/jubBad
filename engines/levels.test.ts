import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEVELS, isLevel, asLevel, levelIndex, seedFor, withinBand, type Level } from './levels.ts';

test('LEVELS is ordered beginner to advanced', () => {
  assert.deepEqual(LEVELS, ['BG', 'N', 'S', 'P-', 'P', 'P+', 'C', 'B']);
});

test('isLevel accepts every level and rejects everything else', () => {
  for (const l of LEVELS) assert.ok(isLevel(l));
  assert.equal(isLevel('BG+'), false);
  assert.equal(isLevel(''), false);
  assert.equal(isLevel('p'), false);
});

test('levelIndex matches array position', () => {
  assert.equal(levelIndex('BG'), 0);
  assert.equal(levelIndex('B'), 7);
});

test('seedFor spaces levels 100 apart starting at 900, unknown is 1200', () => {
  assert.equal(seedFor('BG'), 900);
  assert.equal(seedFor('N'), 1000);
  assert.equal(seedFor('P'), 1300);
  assert.equal(seedFor('B'), 1600);
  assert.equal(seedFor(null), 1200);
});

test('withinBand: null fits any level, including null', () => {
  assert.ok(withinBand(null, null));
  assert.ok(withinBand(null, 'B' as Level));
  assert.ok(withinBand('BG' as Level, null));
});

test('withinBand: adjacent levels fit, two apart does not', () => {
  assert.ok(withinBand('N', 'S'));
  assert.ok(withinBand('S', 'N'));
  assert.equal(withinBand('BG', 'S'), false);
});

test('withinBand: same level fits', () => {
  assert.ok(withinBand('P', 'P'));
});

test('asLevel parses a valid level and rejects everything else', () => {
  assert.equal(asLevel('P+'), 'P+');
  assert.equal(asLevel('bogus'), null);
  assert.equal(asLevel(null), null);
  assert.equal(asLevel(undefined), null);
});
