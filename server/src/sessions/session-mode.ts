/**
 * The session's pairing mode. `variety` (default) spreads partners and
 * opponents; `balanced` also pulls the two sides of each match together on
 * Elo rating; `level` spreads partners and opponents exactly like `variety`
 * but is dominated first by the ±1 level band (C1) — see
 * `engines/pairing.ts`'s `bandOrderedByCourt` and the `bandBreaks` scoring
 * key; `custom` proposes empty seats and lets the host fill them by hand
 * (see `pairing-teams.ts` for how an unfilled seat is represented).
 *
 * Mutually exclusive, not layered: `level` never combines with `balanced` or
 * `custom`. A same-level group has little left for balance-by-rating to add,
 * and a custom-mode host is already placing people by hand with the level
 * badge in view, so band-aware auto-pair suggestions were dropped along with
 * this choice (owner decision, 2026-09-23).
 *
 * One place for the list of valid modes, so `SetModeDto`'s `@IsIn` and the
 * type can never drift from each other.
 */
import { modeAt } from './court-modes.js';

export const SESSION_MODES = ['variety', 'balanced', 'level', 'custom'] as const;

export type SessionMode = (typeof SESSION_MODES)[number];

export function isCustomMode(mode: string): boolean {
  return mode === 'custom';
}

export function isLevelMode(mode: string): boolean {
  return mode === 'level';
}

/**
 * The pairing mode that actually governs one court right now: the session's
 * own mode everywhere except a `custom` session, where each court has its
 * own sticky mode (2026-09-27 real-host feedback) — see `court-modes.ts`.
 * Every per-court engine call site reads this instead of `session.mode`
 * directly.
 */
export function effectiveCourtMode(
  session: { mode: string; courtModes: string | null },
  courtNumber: number
): SessionMode {
  if (!isCustomMode(session.mode)) return session.mode as SessionMode;
  return modeAt(session.courtModes, courtNumber);
}
