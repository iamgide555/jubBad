import { describe, expect, it } from 'vitest';
import type { Level } from '../../../engines/levels.ts';
import { carryOutcomesForConfirm, InvalidCarryOutcomesError, parseCarryOutcomes } from './carry-outcomes.js';

const levels = (entries: [string, Level | null][]) => new Map<string, Level | null>(entries);

describe('carryOutcomesForConfirm (linked carry)', () => {
  const pros = levels([
    ['bg', 'BG'],
    ['mate', 'P'],
    ['p2', 'P'],
    ['p3', 'P'],
  ]);
  const active = ['bg', 'mate', 'p2', 'p3'];

  it('linked carry: records the strictly higher teammate of a far-below linked player', () => {
    expect(
      carryOutcomesForConfirm({ teamA: ['bg', 'mate'], teamB: ['p2', 'p3'] }, new Set(['bg', 'mate']), pros, active)
    ).toEqual([
      { playerId: 'bg', partnerId: 'mate' },
      { playerId: 'mate', partnerId: null },
    ]);
  });

  it('linked carry: an unsuitable (not higher) teammate records null', () => {
    const lv = levels([
      ['bg', 'BG'],
      ['mate', 'BG'],
      ['p2', 'P'],
      ['p3', 'P'],
    ]);
    const out = carryOutcomesForConfirm({ teamA: ['bg', 'mate'], teamB: ['p2', 'p3'] }, new Set(['bg']), lv, active);
    expect(out).toEqual([{ playerId: 'bg', partnerId: null }]);
  });

  it('linked carry: a tagged linked player who is not far-below right now records null', () => {
    const lv = levels([
      ['bg', 'BG'],
      ['mate', 'N'],
      ['p2', 'BG'],
      ['p3', 'N'],
    ]);
    const out = carryOutcomesForConfirm({ teamA: ['bg', 'mate'], teamB: ['p2', 'p3'] }, new Set(['bg']), lv, active);
    expect(out).toEqual([{ playerId: 'bg', partnerId: null }]);
  });

  it('linked carry: counts another higher teammate while the required partner is away', () => {
    const out = carryOutcomesForConfirm(
      { teamA: ['bg', 'p2'], teamB: ['p3', 'x'] },
      new Set(['bg', 'away']),
      levels([
        ['bg', 'BG'],
        ['p2', 'P'],
        ['p3', 'P'],
        ['x', 'P'],
      ]),
      ['bg', 'p2', 'p3', 'x']
    );
    expect(out).toEqual([{ playerId: 'bg', partnerId: 'p2' }]);
  });

  it('linked carry: untagged linked players, singles, and opponents never count', () => {
    const lv = levels([
      ['bg', 'BG'],
      ['u', null],
      ['p2', 'P'],
      ['p3', 'P'],
    ]);
    expect(carryOutcomesForConfirm({ teamA: ['u'], teamB: ['p2'] }, new Set(['u']), lv, ['bg', 'u', 'p2', 'p3'])).toEqual(
      []
    );
    expect(carryOutcomesForConfirm({ teamA: ['bg'], teamB: ['p2'] }, new Set(['bg']), lv, ['bg', 'u', 'p2', 'p3'])).toEqual([
      { playerId: 'bg', partnerId: null },
    ]);
  });
});

describe('parseCarryOutcomes (linked carry)', () => {
  it('linked carry: parses a legacy empty list and a valid list', () => {
    expect(parseCarryOutcomes('[]')).toEqual([]);
    expect(parseCarryOutcomes('[{"playerId":"a","partnerId":null},{"playerId":"b","partnerId":"c"}]')).toEqual([
      { playerId: 'a', partnerId: null },
      { playerId: 'b', partnerId: 'c' },
    ]);
  });

  it('linked carry: malformed outcome JSON fails visibly', () => {
    for (const raw of ['nope', '{}', '[{"playerId":""}]', '[{"playerId":"a"}]', '[{"playerId":"a","partnerId":3}]']) {
      expect(() => parseCarryOutcomes(raw)).toThrow(InvalidCarryOutcomesError);
    }
  });
});
