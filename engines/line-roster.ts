/**
 * Pure rules for the LINE bot's roster capture: which chat messages count as a
 * roster, when the newest one is stale, and which stored ones to purge.
 * No framework and no I/O, so the server and the tests share one definition.
 */
import { parseLineRosterMessage } from './parser.ts';

/** Numbered lines (roster plus waitlist, filled or empty) a message needs to count as a roster. */
export const MIN_ROSTER_LINES = 3;

/**
 * A roster needs numbered lines AND a header with a date, venue or time slot.
 * The header rule keeps a numbered rules post or announcement from becoming
 * "the newest roster" and hiding the real one.
 */
export function isRosterMessage(text: string): boolean {
  const r = parseLineRosterMessage(text);
  if (r.roster.length + r.waitlist.length < MIN_ROSTER_LINES) return false;
  return r.header.rawDate !== null || r.header.venue !== null || r.header.timeSlots.length > 0;
}

/** With no finished session to compare against, a roster older than this is stale. */
export const STALE_WITHOUT_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

export function rosterStaleness(postedAt: Date, lastEndedAt: Date | null, now: Date): 'fresh' | 'stale' {
  if (lastEndedAt !== null) return postedAt.getTime() < lastEndedAt.getTime() ? 'stale' : 'fresh';
  return now.getTime() - postedAt.getTime() > STALE_WITHOUT_SESSION_MS ? 'stale' : 'fresh';
}

export const MAX_KEPT_MESSAGES = 20;
export const MAX_KEPT_DAYS = 30;

/** Ids to delete: everything beyond the newest MAX_KEPT_MESSAGES, plus anything older than MAX_KEPT_DAYS. */
export function messagesToPurge(rows: { id: string; postedAt: Date }[], now: Date): string[] {
  const cutoff = now.getTime() - MAX_KEPT_DAYS * 24 * 60 * 60 * 1000;
  const newestFirst = [...rows].sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime());
  return newestFirst
    .filter((row, i) => i >= MAX_KEPT_MESSAGES || row.postedAt.getTime() < cutoff)
    .map((row) => row.id);
}
