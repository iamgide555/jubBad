import { formatPostedAt } from './line.model';

describe('formatPostedAt', () => {
  const now = new Date('2026-10-26T12:00:00Z');

  it('shows just the time for a message posted today in Bangkok', () => {
    expect(formatPostedAt('2026-10-26T11:42:00Z', now, 'en-US')).toBe('18:42');
  });

  it('includes the date for a message from another day', () => {
    const text = formatPostedAt('2026-10-22T11:42:00Z', now, 'en-US');
    expect(text).toContain('22');
    expect(text).toContain('18:42');
  });

  it('judges the day in Bangkok, not UTC: 01:00 Bangkok and 06:30 Bangkok are the same day', () => {
    // 18:00Z is 01:00 on the 27th in Bangkok; 23:30Z is 06:30 on the 27th. Different UTC days, same Bangkok day.
    expect(formatPostedAt('2026-10-26T18:00:00Z', new Date('2026-10-26T23:30:00Z'), 'en-US')).toBe('01:00');
  });

  it('judges the day in Bangkok, not UTC: 23:00 Bangkok on the 26th is yesterday at 01:00 Bangkok on the 27th', () => {
    // Both are 26 Oct in UTC, but the Bangkok days differ.
    const text = formatPostedAt('2026-10-26T16:00:00Z', new Date('2026-10-26T18:00:00Z'), 'en-US');
    expect(text).not.toBe('23:00');
    expect(text).toContain('23:00');
  });
});
