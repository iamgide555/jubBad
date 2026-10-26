/** Mirrors server/src/line/line-link.service.ts LineStatus. */
export interface LineStatus {
  configured: boolean;
  botAddUrl: string | null;
  linked: boolean;
  lineGroupName: string | null;
  linkedAt: string | null;
  leftAt: string | null;
}

export interface LineLinkCode {
  code: string;
  expiresAt: string;
}

/** Mirrors server/src/line/line-roster.service.ts LatestRoster. */
export interface LatestRoster {
  text: string;
  senderName: string | null;
  postedAt: string;
  stale: boolean;
}

const BANGKOK = 'Asia/Bangkok';

/**
 * When a roster was posted, as the host reads it: just "18:42" if it was posted today (judged in
 * Bangkok, where the group plays, not in UTC), otherwise a short weekday, day, month and time.
 */
export function formatPostedAt(iso: string, now: Date, locale: string): string {
  const at = new Date(iso);
  const day = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: BANGKOK, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const time = new Intl.DateTimeFormat(locale, {
    timeZone: BANGKOK,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
  if (day(at) === day(now)) return time;
  const date = new Intl.DateTimeFormat(locale, { timeZone: BANGKOK, weekday: 'short', day: 'numeric', month: 'short' }).format(at);
  return `${date} ${time}`;
}
