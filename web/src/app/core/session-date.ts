/**
 * What a not-ended session means to the host looking at the group home:
 *  - ended: the host closed it.
 *  - live:  not closed, and it is tonight's — dated today (local calendar), or,
 *           for a session saved without a date, created in the last 18 hours.
 *  - open:  not closed but stale — a night left unfinished, not one in play.
 */
export type SessionState = 'live' | 'open' | 'ended';

const LIVE_WINDOW_MS = 18 * 60 * 60 * 1000;

const pad = (n: number): string => String(n).padStart(2, '0');

/** Today's calendar date in the viewer's own timezone, as YYYY-MM-DD. */
function localDate(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function sessionState(
  s: { endedAt: string | null; date: string | null; createdAt: string },
  now: Date = new Date()
): SessionState {
  if (s.endedAt) return 'ended';
  if (s.date !== null) return s.date === localDate(now) ? 'live' : 'open';
  // `<=` against NaN (an unparsable createdAt) is false: that is open, never live.
  return now.getTime() - Date.parse(s.createdAt) <= LIVE_WINDOW_MS ? 'live' : 'open';
}

/**
 * A session's date for people: weekday, day and month, no year ("Tue, Oct 13",
 * "อ. 13 ต.ค."). The stored YYYY-MM-DD is a calendar date, not an instant, so it
 * is built as a LOCAL date — `new Date('2026-10-13')` parses as UTC midnight and
 * lands on the 12th anywhere west of Greenwich. Null or unparsable gives ''.
 */
export function formatSessionDate(isoDate: string | null, locale: string): string {
  const m = isoDate === null ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return '';
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(year, month - 1, day);
  // 2026-02-30 would roll over to March: not a date.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return '';
  return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(date);
}
