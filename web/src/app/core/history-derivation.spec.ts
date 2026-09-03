import { deriveHistory } from './history-derivation';
import { pairKey } from '../../../../pairing.ts';
import type { MatchRecord } from './live-session.model';

describe('deriveHistory', () => {
  it('returns empty history for no matches', () => {
    const history = deriveHistory([]);
    expect(history.partnerCounts.size).toBe(0);
    expect(history.opponentCounts.size).toBe(0);
    expect(history.gamesPlayedThisSession.size).toBe(0);
  });

  it('counts partners, opponents, and games played from one match', () => {
    const matches: MatchRecord[] = [
      { courtNumber: 1, teamA: ['a', 'b'], teamB: ['c', 'd'], scoreA: null, scoreB: null },
    ];
    const history = deriveHistory(matches);

    expect(history.partnerCounts.get(pairKey('a', 'b'))).toBe(1);
    expect(history.partnerCounts.get(pairKey('c', 'd'))).toBe(1);
    expect(history.opponentCounts.get(pairKey('a', 'c'))).toBe(1);
    expect(history.opponentCounts.get(pairKey('a', 'd'))).toBe(1);
    expect(history.opponentCounts.get(pairKey('b', 'c'))).toBe(1);
    expect(history.opponentCounts.get(pairKey('b', 'd'))).toBe(1);
    expect(history.gamesPlayedThisSession.get('a')).toBe(1);
    expect(history.gamesPlayedThisSession.get('b')).toBe(1);
    expect(history.gamesPlayedThisSession.get('c')).toBe(1);
    expect(history.gamesPlayedThisSession.get('d')).toBe(1);
  });

  it('accumulates counts across multiple matches, regardless of court', () => {
    const matches: MatchRecord[] = [
      { courtNumber: 1, teamA: ['a', 'b'], teamB: ['c', 'd'], scoreA: null, scoreB: null },
      { courtNumber: 2, teamA: ['a', 'b'], teamB: ['e', 'f'], scoreA: 21, scoreB: 15 },
    ];
    const history = deriveHistory(matches);

    expect(history.partnerCounts.get(pairKey('a', 'b'))).toBe(2);
    expect(history.gamesPlayedThisSession.get('a')).toBe(2);
    expect(history.gamesPlayedThisSession.get('c')).toBe(1);
    expect(history.gamesPlayedThisSession.get('e')).toBe(1);
  });
});
