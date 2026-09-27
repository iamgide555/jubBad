export type CourtFormat = 'doubles' | 'singles';

/** Per-court sticky mode — only ever differs from the session's own `mode`
 *  inside a custom session (see server/src/sessions/session-mode.ts's
 *  effectiveCourtMode). */
export type CourtMode = 'variety' | 'balanced' | 'level' | 'custom';

/** A seat is a player id, or empty — possible only on a pending court, and
 *  only in custom mode (see server/src/sessions/pairing-teams.ts). Confirm
 *  refuses while any seat is empty, so an active court's teams are always
 *  fully seated. */
export type Seat = string | null;

export type CourtState =
  | { status: 'idle'; format: CourtFormat; mode: CourtMode }
  | {
      status: 'pending';
      pairingId: string;
      format: CourtFormat;
      mode: CourtMode;
      teamA: Seat[];
      teamB: Seat[];
      /** ISO timestamp of when this match auto-confirms if nobody touches
       *  it, or null when it won't (no `pendingSince` yet, a seat still
       *  empty, or a seated player currently resting). */
      autoStartAt: string | null;
    }
  | {
      status: 'active';
      pairingId: string;
      format: CourtFormat;
      mode: CourtMode;
      teamA: string[];
      teamB: string[];
      /** ISO timestamp of the server's `Pairing.confirmedAt` — when this
       *  court was confirmed and the timer started. Resets to a new value if
       *  the host undoes and re-confirms. */
      startedAt: string;
    };
