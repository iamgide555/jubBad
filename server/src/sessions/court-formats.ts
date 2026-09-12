/**
 * `Session.courtFormats` — a per-court doubles/singles setting, JSON-encoded
 * as a string array in a TEXT column (SQLite has no array type, the same
 * convention as `Player.aliases` and `Pairing.teamA`/`teamB`). Index 0 is
 * court 1.
 *
 * Null, missing, or an unrecognised entry all read as `'doubles'` — every
 * session that predates this column, and every court a host has never
 * touched, keeps behaving exactly as it always did. A malformed column
 * value reads as all-doubles rather than throwing: a corrupt settings string
 * must not take the dashboard down mid-session, and setting a court's format
 * again is how a host would actually recover from it.
 *
 * Deliberately not trimmed when `courtCount` shrinks: a host who drops to one
 * court for an hour and grows back to three finds court 3 still set the way
 * they left it. Readers must always index by court number, never read
 * `.length` as a court count.
 */

export type CourtFormat = 'doubles' | 'singles';

const MAX_COURTS = 20;

export function courtSizeFor(format: CourtFormat): 2 | 4 {
  return format === 'singles' ? 2 : 4;
}

export function parseCourtFormats(raw: string | null): CourtFormat[] {
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (entry === 'singles' ? 'singles' : 'doubles'));
}

/** The format for one court, defaulting to doubles when unset or out of range. */
export function formatAt(raw: string | null, courtNumber: number): CourtFormat {
  const formats = parseCourtFormats(raw);
  return formats[courtNumber - 1] ?? 'doubles';
}

/**
 * Sets one court's format, padding any gap before it with 'doubles' (never
 * with the new value — a gap is a court that was never touched, not one that
 * was ever set to this) and capping the written array at MAX_COURTS, matching
 * `SetCourtCountDto`'s own cap.
 */
export function withFormatAt(raw: string | null, courtNumber: number, format: CourtFormat): string {
  const formats = parseCourtFormats(raw);
  while (formats.length < courtNumber) formats.push('doubles');
  formats[courtNumber - 1] = format;
  return JSON.stringify(formats.slice(0, MAX_COURTS));
}
