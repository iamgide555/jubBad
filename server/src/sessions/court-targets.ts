/**
 * `Session.courtTargets` — a per-court target level ('auto' | 'low' | 'high'),
 * JSON-encoded as a string array in a TEXT column, the same convention as
 * `courtModes` (`court-modes.ts`). Index 0 is court 1. Only read for a court
 * whose effective mode is `'level'`.
 *
 * Null, missing, or an unrecognised entry all read as `'auto'`, so every
 * session that predates this column keeps behaving exactly as it always did.
 */

import { COURT_TARGETS, isCourtTarget, type CourtTarget } from '../../../engines/levels.ts';
import { InvalidCourtNumberError } from './court-formats.js';

/** Matches court-formats.ts's own cap. */
const MAX_COURTS = 20;

export { COURT_TARGETS, InvalidCourtNumberError };
export type { CourtTarget };

export function parseCourtTargets(raw: string | null): CourtTarget[] {
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (isCourtTarget(entry) ? entry : 'auto'));
}

/** The target for one court, defaulting to auto when unset or out of range. */
export function targetAt(raw: string | null, courtNumber: number): CourtTarget {
  return parseCourtTargets(raw)[courtNumber - 1] ?? 'auto';
}

/** Sets one court's target, padding any gap before it with 'auto'. Throws for
 *  a court number beyond `MAX_COURTS` rather than silently truncating. */
export function withTargetAt(raw: string | null, courtNumber: number, target: CourtTarget): string {
  if (courtNumber > MAX_COURTS) {
    throw new InvalidCourtNumberError(courtNumber);
  }
  const targets = parseCourtTargets(raw);
  while (targets.length < courtNumber) targets.push('auto');
  targets[courtNumber - 1] = target;
  return JSON.stringify(targets.slice(0, MAX_COURTS));
}
