import { describe, expect, it } from 'vitest';
import { pairKey } from '../../../engines/pairing.ts';
import { deriveHistory } from './derive-history.js';

describe('deriveHistory', () => {
  const earlierSession = [{ teamA: ['a', 'b'] as [string, string], teamB: ['c', 'd'] as [string, string] }];
  const thisSession = [{ teamA: ['a', 'c'] as [string, string], teamB: ['b', 'd'] as [string, string] }];

  it('counts partners across every session it is given', () => {
    const history = deriveHistory([...earlierSession, ...thisSession], thisSession);

    expect(history.partnerCounts.get(pairKey('a', 'b'))).toBe(1);
    expect(history.partnerCounts.get(pairKey('a', 'c'))).toBe(1);
  });

  it('counts opponents across every session it is given', () => {
    const history = deriveHistory([...earlierSession, ...thisSession], thisSession);

    expect(history.opponentCounts.get(pairKey('a', 'c'))).toBe(1);
    expect(history.opponentCounts.get(pairKey('a', 'b'))).toBe(1);
  });

  it('counts games played from the current session only', () => {
    const history = deriveHistory([...earlierSession, ...thisSession], thisSession);

    expect(history.gamesPlayedThisSession.get('a')).toBe(1);
  });

  it('leaves games played at zero for a player who only appears in earlier sessions', () => {
    const history = deriveHistory(earlierSession, []);

    expect(history.partnerCounts.get(pairKey('a', 'b'))).toBe(1);
    expect(history.gamesPlayedThisSession.get('a')).toBeUndefined();
  });
});
