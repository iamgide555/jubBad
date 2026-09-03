import { buildReviews } from './roster-review';
import type { Player } from '../../../../fuzzy-match.ts';

const players: Player[] = [{ id: 'p1', name: 'ตั้ม', aliases: [] }];

describe('buildReviews', () => {
  it('marks an exact match, defaulting decision to accept', () => {
    const result = buildReviews(['ตั้ม'], players);
    expect(result).toEqual([
      { inputName: 'ตั้ม', match: { type: 'exact', playerId: 'p1' }, decision: 'accept' },
    ]);
  });

  it('marks a new name as new', () => {
    const result = buildReviews(['เกียร์'], players);
    expect(result[0].match).toEqual({ type: 'new' });
  });

  it('preserves input order for multiple names', () => {
    const result = buildReviews(['ตั้ม', 'เกียร์'], players);
    expect(result.map((r) => r.inputName)).toEqual(['ตั้ม', 'เกียร์']);
  });
});
