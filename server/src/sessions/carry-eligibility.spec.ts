import { describe, expect, it } from 'vitest';
import { computeCarryEligibility } from './carry-eligibility.js';

describe('computeCarryEligibility', () => {
  it('marks a far-below player eligible when never played tonight', () => {
    const { carryEligible } = computeCarryEligibility({
      activeRosterIds: ['bg', 'p1', 'p2', 'p3'],
      levels: new Map([
        ['bg', 'BG'],
        ['p1', 'P'],
        ['p2', 'P'],
        ['p3', 'P'],
      ]),
      levelSetAt: new Map([['bg', 1000]]),
      confirmedPairingsTonight: [],
    });
    expect(carryEligible.has('bg')).toBe(true);
  });

  it('is not eligible once they have a confirmed game since their tag', () => {
    const { carryEligible } = computeCarryEligibility({
      activeRosterIds: ['bg', 'p1', 'p2', 'p3'],
      levels: new Map([
        ['bg', 'BG'],
        ['p1', 'P'],
        ['p2', 'P'],
        ['p3', 'P'],
      ]),
      levelSetAt: new Map([['bg', 1000]]),
      confirmedPairingsTonight: [{ playerIds: ['bg', 'p1', 'p2', 'p3'], confirmedAt: 2000 }],
    });
    expect(carryEligible.has('bg')).toBe(false);
  });

  it('is eligible again for a confirmed game that predates the (re-)tag', () => {
    const { carryEligible } = computeCarryEligibility({
      activeRosterIds: ['bg', 'p1', 'p2', 'p3'],
      levels: new Map([
        ['bg', 'BG'],
        ['p1', 'P'],
        ['p2', 'P'],
        ['p3', 'P'],
      ]),
      levelSetAt: new Map([['bg', 5000]]), // tagged after that earlier game
      confirmedPairingsTonight: [{ playerIds: ['bg', 'p1', 'p2', 'p3'], confirmedAt: 2000 }],
    });
    expect(carryEligible.has('bg')).toBe(true);
  });

  it('never marks an untagged player eligible', () => {
    const { carryEligible } = computeCarryEligibility({
      activeRosterIds: ['x', 'p1', 'p2', 'p3'],
      levels: new Map([
        ['x', null],
        ['p1', 'P'],
        ['p2', 'P'],
        ['p3', 'P'],
      ]),
      levelSetAt: new Map(),
      confirmedPairingsTonight: [],
    });
    expect(carryEligible.size).toBe(0);
  });

  it('marks carriedTonight for whoever partnered a currently-eligible player tonight', () => {
    const { carriedTonight } = computeCarryEligibility({
      activeRosterIds: ['bg1', 'bg2', 'pro', 'p1', 'p2'],
      levels: new Map([
        ['bg1', 'BG'],
        ['bg2', 'BG'],
        ['pro', 'C'],
        ['p1', 'P'],
        ['p2', 'P'],
      ]),
      levelSetAt: new Map([
        ['bg1', 1000],
        ['bg2', 1000],
      ]),
      confirmedPairingsTonight: [{ playerIds: ['bg1', 'pro', 'p1', 'p2'], confirmedAt: 2000 }],
    });
    // bg1 already played (with pro) since being tagged, so bg1 is no longer
    // eligible — but bg2 still is, and `pro` carried a (then-)eligible
    // player tonight.
    expect(carriedTonight.has('pro')).toBe(true);
    expect(carriedTonight.has('bg1')).toBe(false); // bg1 is not "carried" for itself
  });

  describe('linked carry', () => {
    const levels = new Map([
      ['bg', 'BG'],
      ['mate', 'P'],
      ['p2', 'P'],
      ['p3', 'P'],
    ] as const);
    const base = {
      activeRosterIds: ['bg', 'mate', 'p2', 'p3'],
      levels,
      levelSetAt: new Map([['bg', 1000]]),
    };
    const game = (carryOutcomes: { playerId: string; partnerId: string | null }[]) => ({
      playerIds: ['bg', 'mate', 'p2', 'p3'],
      confirmedAt: 2000,
      carryOutcomes,
    });

    it('linked carry: a null outcome (unsuitable teammate) keeps the player eligible and carries nobody', () => {
      const result = computeCarryEligibility({ ...base, confirmedPairingsTonight: [game([{ playerId: 'bg', partnerId: null }])] });
      expect(result.carryEligible.has('bg')).toBe(true);
      expect([...result.carriedTonight]).toEqual([]);
    });

    it('linked carry: a higher teammate fulfils it once and only that teammate is carried', () => {
      const result = computeCarryEligibility({ ...base, confirmedPairingsTonight: [game([{ playerId: 'bg', partnerId: 'mate' }])] });
      expect(result.carryEligible.has('bg')).toBe(false);
      expect([...result.carriedTonight]).toEqual(['mate']);
    });

    it('linked carry: an earlier null outcome is not reinterpreted after a roster change makes them far-below', () => {
      // At confirmation bg was not far-below (null); now they are.
      const result = computeCarryEligibility({ ...base, confirmedPairingsTonight: [game([{ playerId: 'bg', partnerId: null }])] });
      expect(result.carryEligible.has('bg')).toBe(true);
    });

    it('linked carry: a game with no outcome for the player keeps the legacy any-game rule', () => {
      const result = computeCarryEligibility({ ...base, confirmedPairingsTonight: [game([{ playerId: 'other', partnerId: null }])] });
      expect(result.carryEligible.has('bg')).toBe(false);
      expect([...result.carriedTonight].sort()).toEqual(['mate', 'p2', 'p3']);
    });

    it('linked carry: a later tag still limits eligibility to games since the tag', () => {
      const result = computeCarryEligibility({
        ...base,
        levelSetAt: new Map([['bg', 3000]]),
        confirmedPairingsTonight: [game([{ playerId: 'bg', partnerId: 'mate' }])],
      });
      expect(result.carryEligible.has('bg')).toBe(true);
    });
  });

  it('custom ladder: far-below is judged by the group\'s order, not the built-in one', () => {
    const ladder = [{ name: 'S', startingElo: 1000 }, { name: 'C', startingElo: 1100 }, { name: 'B', startingElo: 1200 }];
    // In the built-in order S is below C, but here S is the bottom rung and B the top.
    const base = {
      activeRosterIds: ['low', 'a', 'b', 'c'],
      levels: new Map<string, string | null>([['low', 'S'], ['a', 'B'], ['b', 'B'], ['c', 'B']]),
      levelSetAt: new Map([['low', 1000]]),
      confirmedPairingsTonight: [],
    };
    expect(computeCarryEligibility({ ...base, ladder }).carryEligible.has('low')).toBe(true);
    // A two-rung gap in the custom order puts C and S in band, so the carry rule does not apply.
    const near = computeCarryEligibility({
      ...base,
      levels: new Map<string, string | null>([['low', 'S'], ['a', 'C'], ['b', 'C'], ['c', 'C']]),
      ladder,
    });
    expect(near.carryEligible.has('low')).toBe(false);
  });
});
