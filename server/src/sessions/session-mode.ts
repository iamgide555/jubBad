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
export const SESSION_MODES = ['variety', 'balanced', 'level', 'custom'] as const;

export type SessionMode = (typeof SESSION_MODES)[number];

export function isCustomMode(mode: string): boolean {
  return mode === 'custom';
}

export function isLevelMode(mode: string): boolean {
  return mode === 'level';
}
