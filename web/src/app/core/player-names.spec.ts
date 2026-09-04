import { resolvePlayerNames } from './player-names';
import type { Player } from '../../../../engines/fuzzy-match.ts';

const players: Player[] = [
  { id: 'p1', name: 'ตั้ม', aliases: [] },
  { id: 'p2', name: 'เบส', aliases: [] },
];

describe('resolvePlayerNames', () => {
  it('resolves ids to names in order', () => {
    expect(resolvePlayerNames(['p2', 'p1'], players)).toEqual(['เบส', 'ตั้ม']);
  });

  it('falls back to the raw id when a player is not found', () => {
    expect(resolvePlayerNames(['p1', 'ghost'], players)).toEqual(['ตั้ม', 'ghost']);
  });

  it('returns an empty array for an empty input', () => {
    expect(resolvePlayerNames([], players)).toEqual([]);
  });
});
