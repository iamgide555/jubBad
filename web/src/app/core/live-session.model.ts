export type CourtFormat = 'doubles' | 'singles';

/** A seat is a player id, or empty — possible only on a pending court, and
 *  only in custom mode (see server/src/sessions/pairing-teams.ts). Confirm
 *  refuses while any seat is empty, so an active court's teams are always
 *  fully seated. */
export type Seat = string | null;

export type CourtState =
  | { status: 'idle'; format: CourtFormat }
  | { status: 'pending'; pairingId: string; format: CourtFormat; teamA: Seat[]; teamB: Seat[] }
  | {
      status: 'active';
      pairingId: string;
      format: CourtFormat;
      teamA: string[];
      teamB: string[];
      /** ISO timestamp of the server's `Pairing.confirmedAt` — when this
       *  court was confirmed and the timer started. Resets to a new value if
       *  the host undoes and re-confirms. */
      startedAt: string;
    };
