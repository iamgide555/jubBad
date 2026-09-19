/**
 * The session's pairing mode. `variety` (default) spreads partners and
 * opponents; `balanced` also pulls the two sides of each match together on
 * Elo rating; `custom` proposes empty seats and lets the host fill them by
 * hand (see `pairing-teams.ts` for how an unfilled seat is represented).
 *
 * One place for the list of valid modes, so `SetModeDto`'s `@IsIn` and the
 * type can never drift from each other.
 */
export const SESSION_MODES = ['variety', 'balanced', 'custom'] as const;

export type SessionMode = (typeof SESSION_MODES)[number];

export function isCustomMode(mode: string): boolean {
  return mode === 'custom';
}
