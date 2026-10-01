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
  DEFAULT_LEVEL_LADDER,
  validateLevelSpecs,
  centeredLevelSpecs,
  type Level,
  type LevelSpec,
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


describe('configurable ladders (host feedback F)', () => {
  const three: LevelSpec[] = [
    { name: 'BG', startingElo: 1100 },
    { name: 'N', startingElo: 1200 },
    { name: 'S', startingElo: 1300 },
  ];

  it('the default ladder mirrors LEVELS with 900..1600 seeds, so every helper is unchanged', () => {
    assert.deepEqual(DEFAULT_LEVEL_LADDER.map((l) => l.name), [...LEVELS]);
    assert.equal(seedFor('BG'), 900);
    assert.equal(seedFor('P'), 1300);
    assert.equal(seedFor('B'), 1600);
    assert.equal(seedFor(null), 1200);
    assert.equal(seedFor('P', DEFAULT_LEVEL_LADDER), 1300);
    assert.equal(levelIndex('B', DEFAULT_LEVEL_LADDER), 7);
  });

  it('indexes, seeds and bands follow the ladder it is given', () => {
    assert.equal(levelIndex('S', three), 2);
    assert.equal(seedFor('N', three), 1200);
    assert.equal(seedFor(null, three), 1200);
    assert.ok(isLevel('N', three));
    assert.equal(isLevel('P', three), false, 'a default name is not a level of another ladder');
    assert.equal(asLevel('S', three), 'S');
    assert.equal(asLevel('P', three), null);
    assert.ok(withinBand('BG', 'N', three));
    assert.ok(withinBand('N', 'S', three));
    assert.equal(withinBand('BG', 'S', three), false, 'bottom versus top is out of band');
    assert.ok(withinBand(null, 'S', three));
  });

  it('a one-level ladder has index 0 and never -1', () => {
    const one: LevelSpec[] = [{ name: 'ทั่วไป', startingElo: 1200 }];
    assert.equal(levelIndex('ทั่วไป', one), 0);
    assert.ok(withinBand('ทั่วไป', 'ทั่วไป', one));
    assert.equal(isFarBelow('a', new Map([['a', 'ทั่วไป']]), one), true, 'alone, fewer than four in band');
  });

  it('an unknown level handed to indexing, banding or carry throws instead of returning -1', () => {
    assert.throws(() => levelIndex('P', three), /unknown level/i);
    assert.throws(() => seedFor('P', three), /unknown level/i);
    assert.throws(() => withinBand('P', 'N', three), /unknown level/i);
    assert.throws(() => isFarBelow('a', new Map([['a', 'P'], ['b', 'N']]), three), /unknown level/i);
  });

  it('carry on a custom ladder: a lone low player qualifies, an untagged one does not', () => {
    const levels = new Map<string, Level | null>([['low', 'BG'], ['mid', 'S'], ['hi', 'S'], ['none', null]]);
    assert.equal(isFarBelow('low', levels, three), true);
    assert.equal(isFarBelow('none', levels, three), false);
    assert.equal(isFarBelow('hi', levels, three), false);
  });

  it('centeredLevelSpecs spaces seeds 100 apart around 1200', () => {
    assert.deepEqual(centeredLevelSpecs(['BG']).map((l) => l.startingElo), [1200]);
    assert.deepEqual(centeredLevelSpecs(['BG', 'N', 'S']).map((l) => l.startingElo), [1100, 1200, 1300]);
    assert.deepEqual(centeredLevelSpecs(['a', 'b']).map((l) => l.startingElo), [1150, 1250]);
    assert.deepEqual(centeredLevelSpecs(['a', 'b', 'c', 'd']).map((l) => l.startingElo), [1050, 1150, 1250, 1350]);
    const sixteen = centeredLevelSpecs(Array.from({ length: 16 }, (_, i) => `L${i}`));
    assert.doesNotThrow(() => validateLevelSpecs(sixteen));
    assert.ok(sixteen.every((l) => Number.isInteger(l.startingElo) && l.startingElo >= 0));
  });

  describe('validateLevelSpecs', () => {
    const bad = (levels: LevelSpec[], message: RegExp) => assert.throws(() => validateLevelSpecs(levels), message);
    it('accepts Thai and Latin names and 1 to 16 levels', () => {
      assert.doesNotThrow(() => validateLevelSpecs([{ name: 'มือใหม่', startingElo: 1000 }, { name: 'Pro', startingElo: 1500 }]));
      assert.doesNotThrow(() => validateLevelSpecs(three));
      assert.doesNotThrow(() => validateLevelSpecs(DEFAULT_LEVEL_LADDER));
    });
    it('rejects zero and seventeen levels', () => {
      bad([], /1.*16/);
      bad(Array.from({ length: 17 }, (_, i) => ({ name: `L${i}`, startingElo: 1000 + i })), /1.*16/);
    });
    it('rejects blank, untrimmed, overlong, control-character and case-duplicate names', () => {
      bad([{ name: '', startingElo: 1000 }], /name/);
      bad([{ name: '   ', startingElo: 1000 }], /name/);
      bad([{ name: ' BG', startingElo: 1000 }], /name/);
      bad([{ name: 'x'.repeat(17), startingElo: 1000 }], /16/);
      bad([{ name: 'a\u0007b', startingElo: 1000 }], /control/i);
      bad([{ name: 'bg', startingElo: 1000 }, { name: 'BG', startingElo: 1100 }], /unique|duplicate/i);
    });
    it('counts code points, not UTF-16 units', () => {
      assert.doesNotThrow(() => validateLevelSpecs([{ name: '😀'.repeat(16), startingElo: 1000 }]));
      bad([{ name: '😀'.repeat(17), startingElo: 1000 }], /16/);
    });
    it('rejects fractional, negative, unsafe and non-increasing seeds', () => {
      bad([{ name: 'a', startingElo: 1000.5 }], /integer|seed|elo/i);
      bad([{ name: 'a', startingElo: -1 }], /integer|seed|elo/i);
      bad([{ name: 'a', startingElo: 2 ** 31 }], /integer|seed|elo/i);
      bad([{ name: 'a', startingElo: 1000 }, { name: 'b', startingElo: 1000 }], /higher than/i);
      bad([{ name: 'a', startingElo: 1100 }, { name: 'b', startingElo: 1000 }], /higher than/i);
    });
  });
});
