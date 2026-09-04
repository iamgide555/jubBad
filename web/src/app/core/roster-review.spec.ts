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

  it('preserves input order', () => {
    const matches: RosterNameMatch[] = [
      { inputName: 'a', match: { type: 'new' } },
      { inputName: 'b', match: { type: 'new' } },
    ];
    expect(attachDecisions(matches).map((r) => r.inputName)).toEqual(['a', 'b']);
  });
});
