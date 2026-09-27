import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEVELS,
  isLevel,
  asLevel,
  levelIndex,
  seedFor,
  withinBand,
  isFarBelow,
  type Level,
} from './levels.ts';

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

describe('isFarBelow', () => {
  it('is false for an untagged player', () => {
    const levels = new Map<string, Level | null>([
      ['a', null],
      ['b', 'P'],
    ]);
    assert.equal(isFarBelow('a', levels), false);
  });

  it('is true for a lone BG in an all-P group', () => {
    const levels = new Map<string, Level | null>([
      ['bg', 'BG'],
      ['p1', 'P'],
      ['p2', 'P'],
      ['p3', 'P'],
    ]);
    assert.equal(isFarBelow('bg', levels), true);
  });

  it('is true for both of two BGs in an all-P group', () => {
    const levels = new Map<string, Level | null>([
      ['bg1', 'BG'],
      ['bg2', 'BG'],
      ['p1', 'P'],
      ['p2', 'P'],
    ]);
    assert.equal(isFarBelow('bg1', levels), true);
    assert.equal(isFarBelow('bg2', levels), true);
  });

  it('is false for the lone top outlier (B in an N group)', () => {
    const levels = new Map<string, Level | null>([
      ['b', 'B'],
      ['n1', 'N'],
      ['n2', 'N'],
      ['n3', 'N'],
    ]);
    assert.equal(isFarBelow('b', levels), false);
  });

  it('is false for a middle outlier when someone below them exists', () => {
    const levels = new Map<string, Level | null>([
      ['bg', 'BG'],
      ['s', 'S'],
      ['p1', 'P'],
      ['p2', 'P'],
      ['p3', 'P'],
    ]);
    assert.equal(isFarBelow('s', levels), false);
    assert.equal(isFarBelow('bg', levels), true);
  });

  it('is false once four or more players share the band', () => {
    const levels = new Map<string, Level | null>([
      ['bg', 'BG'],
      ['n1', 'N'],
      ['n2', 'N'],
      ['n3', 'N'],
      ['p1', 'P'],
    ]);
    // bg is N's neighbour band (BG..N is within 1), so with 4 N's/BG already
    // sharing the band (bg + n1 + n2 + n3), it does not qualify.
    assert.equal(isFarBelow('bg', levels), false);
  });
});
