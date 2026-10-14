import { formatSessionDate, sessionState } from './session-date';

const HOUR = 3_600_000;
const NOW = new Date(2026, 9, 14, 20, 0); // 14 Oct 2026, 20:00 local

// The web tsconfig carries no node types; the runner is node, so process exists.
const proc = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process;

const originalTz = proc.env['TZ'];
const restoreTz = () => {
  if (originalTz === undefined) delete proc.env['TZ'];
  else proc.env['TZ'] = originalTz;
};

const ago = (ms: number, from = NOW) => new Date(from.getTime() - ms).toISOString();

describe('sessionState', () => {
  afterEach(restoreTz);

  it('is ended whenever endedAt is set, even for a session dated today', () => {
    expect(sessionState({ endedAt: ago(HOUR), date: '2026-10-14', createdAt: ago(2 * HOUR) }, NOW)).toBe('ended');
  });

  it('is live for a not-ended session dated today', () => {
    expect(sessionState({ endedAt: null, date: '2026-10-14', createdAt: ago(30 * HOUR) }, NOW)).toBe('live');
  });

  it('is live for a not-ended session with no date created 2 hours ago', () => {
    expect(sessionState({ endedAt: null, date: null, createdAt: ago(2 * HOUR) }, NOW)).toBe('live');
  });

  it('is open for a not-ended session dated five days ago', () => {
    expect(sessionState({ endedAt: null, date: '2026-10-09', createdAt: ago(5 * 24 * HOUR) }, NOW)).toBe('open');
  });

  it('is open for a not-ended session with no date created 30 hours ago', () => {
    expect(sessionState({ endedAt: null, date: null, createdAt: ago(30 * HOUR) }, NOW)).toBe('open');
  });

  describe('the 18-hour window for a session with no date', () => {
    const MINUTE = 60_000;
    const undated = (createdAt: string) => ({ endedAt: null, date: null, createdAt });

    it('is live at 17h59m', () => {
      expect(sessionState(undated(ago(18 * HOUR - MINUTE)), NOW)).toBe('live');
    });

    it('is live at exactly 18h: the boundary is inclusive', () => {
      expect(sessionState(undated(ago(18 * HOUR)), NOW)).toBe('live');
    });

    it('is open at 18h01m', () => {
      expect(sessionState(undated(ago(18 * HOUR + MINUTE)), NOW)).toBe('open');
    });
  });

  it('compares dates on the local calendar, not UTC: just before and just after local midnight', () => {
    // Under UTC the local and UTC dates always agree, which would let a
    // toISOString-based implementation pass. Force a zone west of Greenwich,
    // where 23:30 on the 31st is already the 1st in UTC, and prove it took.
    proc.env['TZ'] = 'America/Los_Angeles';
    expect(new Date().getTimezoneOffset()).not.toBe(0);
    const lateEvening = new Date(2026, 11, 31, 23, 30);
    const justAfterMidnight = new Date(2027, 0, 1, 0, 30);
    const s = { endedAt: null, date: '2026-12-31', createdAt: ago(3 * 24 * HOUR, lateEvening) };
    expect(sessionState(s, lateEvening)).toBe('live');
    expect(sessionState(s, justAfterMidnight)).toBe('open');
  });

  it('defaults now to the current time', () => {
    const t = new Date();
    const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    expect(sessionState({ endedAt: null, date: today, createdAt: t.toISOString() })).toBe('live');
  });
});

describe('formatSessionDate', () => {
  it('formats an English weekday, month and day without a year', () => {
    expect(formatSessionDate('2026-10-13', 'en')).toBe('Tue, Oct 13');
  });

  it('formats a Thai short date: the day and a Thai month abbreviation, no year digits', () => {
    const th = formatSessionDate('2026-10-13', 'th');
    expect(th).toContain('13');
    expect(th).toContain('ต.ค.');
    expect(th).not.toMatch(/\d{4}/);
    expect(th).not.toContain('2569');
  });

  it('is empty for null and for unparsable input', () => {
    expect(formatSessionDate(null, 'en')).toBe('');
    expect(formatSessionDate('not-a-date', 'en')).toBe('');
    expect(formatSessionDate('2026-02-30', 'en')).toBe('');
    expect(formatSessionDate('2026-10-13T00:00:00Z', 'en')).toBe('');
  });

  describe('near a month boundary the day is never shifted by the timezone', () => {
    afterEach(restoreTz);

    it('keeps 31 December in the local calendar under the machine timezone', () => {
      expect(formatSessionDate('2026-12-31', 'en')).toBe('Thu, Dec 31');
      expect(formatSessionDate('2026-12-31', 'th')).toContain('31');
    });

    it('keeps 31 December under a negative UTC offset, where new Date("2026-12-31") would land on the 30th', () => {
      proc.env['TZ'] = 'America/Los_Angeles';
      // Precondition: the offset really is negative (positive getTimezoneOffset),
      // otherwise this proves nothing.
      expect(new Date(2026, 11, 31, 12).getTimezoneOffset()).toBeGreaterThan(0);
      expect(formatSessionDate('2026-12-31', 'en')).toBe('Thu, Dec 31');
      expect(formatSessionDate('2026-12-31', 'th')).toContain('31');
      expect(formatSessionDate('2026-12-31', 'th')).not.toContain('30');
    });
  });
});
