/** Mirrors server/src/line/line-link.service.ts LineStatus. */
export interface LineStatus {
  configured: boolean;
  botAddUrl: string | null;
  linked: boolean;
  lineGroupName: string | null;
  linkedAt: string | null;
  leftAt: string | null;
  /** Whether the end-of-session "send the summary card" checkbox starts ticked. */
  summaryDefault: boolean;
  /** False when the server has no public app url, so no card can be sent and the switch would do nothing. */
  summaryAvailable: boolean;
}

/** Mirrors server/src/line/line-summary.service.ts. */
export type LineSummaryOutcome = 'sent' | 'already-sent' | 'busy' | 'quota' | 'failed' | 'unavailable';

export interface LineSummaryState {
  /** A card could be posted for this session (it may still be open). */
  available: boolean;
  /** A card has already gone out; there is never a second one. */
  sent: boolean;
  /** The group's saved default for the end-of-session checkbox. */
  defaultOn: boolean;
}

/** Mirrors server/src/line/line-host.service.ts LineHostStatus: the signed-in host's own LINE link. */
export interface LineHostStatus {
  configured: boolean;
  botAddUrl: string | null;
  linked: boolean;
  linkedAt: string | null;
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
  /** True when the host sent it to the bot by direct message, not from a LINE group. */
  direct: boolean;
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
