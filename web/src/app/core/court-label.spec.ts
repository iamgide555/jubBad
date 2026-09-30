import { labelForCourt } from './court-label';

describe('labelForCourt', () => {
  it('uses a custom label when set', () => {
    expect(labelForCourt(['A'], 1)).toBe('A');
  });

  it('falls back to the court number when unset or null', () => {
    expect(labelForCourt([], 3)).toBe('3');
    expect(labelForCourt([null, 'B'], 1)).toBe('1');
  });
});
