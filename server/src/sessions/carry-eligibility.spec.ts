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
});
