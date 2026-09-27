/**
 * `Session.courtModes` — a per-court pairing mode, JSON-encoded as a string
 * array in a TEXT column, the same convention as `courtFormats`
 * (`court-formats.ts`). Index 0 is court 1. Read only while the session's
 * own `mode` is `'custom'` — see `session-mode.ts`'s `effectiveCourtMode`.
 *
 * Null, missing, or an unrecognised entry all read as `'custom'` — every
 * custom session that predates this column, and every court a host has
 * never touched, keeps behaving exactly as it always did (an empty draft
 * the host fills by hand).
 */

import { InvalidCourtNumberError } from './court-formats.js';
import { SESSION_MODES, type SessionMode } from './session-mode.js';

/** Matches court-formats.ts's own cap. */
const MAX_COURTS = 20;

export { InvalidCourtNumberError };

export function parseCourtModes(raw: string | null): SessionMode[] {
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.map((entry) =>
    (SESSION_MODES as readonly string[]).includes(entry) ? (entry as SessionMode) : 'custom'
  );
}

/** The mode for one court, defaulting to custom when unset or out of range. */
export function modeAt(raw: string | null, courtNumber: number): SessionMode {
  const modes = parseCourtModes(raw);
  return modes[courtNumber - 1] ?? 'custom';
}

/** Sets one court's mode, padding any gap before it with 'custom'. Mirrors
 *  `withFormatAt`'s own reasoning, including the throw for a court number
 *  beyond `MAX_COURTS` rather than a silently-truncated write. */
export function withModeAt(raw: string | null, courtNumber: number, mode: SessionMode): string {
  if (courtNumber > MAX_COURTS) {
    throw new InvalidCourtNumberError(courtNumber);
  }
  const modes = parseCourtModes(raw);
  while (modes.length < courtNumber) modes.push('custom');
  modes[courtNumber - 1] = mode;
  return JSON.stringify(modes.slice(0, MAX_COURTS));
}
