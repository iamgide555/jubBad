import { attachDecisions } from './roster-review';
import type { RosterNameMatch } from '../../../../engines/fuzzy-match.ts';

describe('attachDecisions', () => {
  it('defaults every review to accept', () => {
    const matches: RosterNameMatch[] = [
      { inputName: 'ตั้ม', match: { type: 'exact', playerId: 'p1' } },
      { inputName: 'เกียร์', match: { type: 'new' } },
    ];
    expect(attachDecisions(matches)).toEqual([
      { inputName: 'ตั้ม', match: { type: 'exact', playerId: 'p1' }, decision: 'accept' },
      { inputName: 'เกียร์', match: { type: 'new' }, decision: 'accept' },
    ]);
  });

  it('defaults a duplicate to being a different person', () => {
    // "ตั้ม (1)" / "ตั้ม (2)" is two people far more often than it is one name
    // pasted twice, and a merge that should have been two people is the one
    // the host cannot undo afterwards. So the default is a new player, and
    // "same person" is the deliberate tap.
    const matches: RosterNameMatch[] = [
      { inputName: 'ตั้ม (1)', match: { type: 'exact', playerId: 'p1' } },
      { inputName: 'ตั้ม (2)', match: { type: 'duplicate', playerId: 'p1' } },
    ];
    expect(attachDecisions(matches).map((r) => r.decision)).toEqual(['accept', 'reject-new']);
  });

  it('preserves input order', () => {
    const matches: RosterNameMatch[] = [
      { inputName: 'a', match: { type: 'new' } },
      { inputName: 'b', match: { type: 'new' } },
    ];
    expect(attachDecisions(matches).map((r) => r.inputName)).toEqual(['a', 'b']);
  });
});
