import type { ShuttleRef } from './shuttle.model';

export type CourtFormat = 'doubles' | 'singles';

/** Per-court sticky mode — only ever differs from the session's own `mode`
 *  inside a custom session (see server/src/sessions/session-mode.ts's
 *  effectiveCourtMode). */
export type CourtMode = 'variety' | 'balanced' | 'level' | 'custom';

/** A level-mode court's target: 'low' / 'high' aim it at the lower / upper half
 *  of tonight's roster; 'auto' is the ordinary ±1 band. Only ever steers a
 *  court whose `mode` is 'level'. */
export type CourtTarget = 'auto' | 'low' | 'high';

/** A seat is a player id, or empty — possible only on a pending court, and
 *  only in custom mode (see server/src/sessions/pairing-teams.ts). Confirm
 *  refuses while any seat is empty, so an active court's teams are always
 *  fully seated. */
export type Seat = string | null;

export type CourtState =
  | { status: 'idle'; format: CourtFormat; mode: CourtMode; target?: CourtTarget }
  | {
      status: 'pending';
      pairingId: string;
      format: CourtFormat;
      mode: CourtMode;
      target?: CourtTarget;
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
      target?: CourtTarget;
      teamA: string[];
      teamB: string[];
      /** ISO timestamp of the server's `Pairing.confirmedAt` — when this
       *  court was confirmed and the timer started. Resets to a new value if
       *  the host undoes and re-confirms. */
      startedAt: string;
      /** `Pairing.revision` — a switch or winner tap must send it so a stale
       *  tab is refused. Always sent by the server; optional here only so
       *  display-side fixtures stay valid. A write without it is not attempted. */
      revision?: number;
      /** Advanced sessions only: the shuttle in hand (null right after an undo)
       *  and the distinct shuttles used so far in this game. Absent on ordinary sessions. */
      currentShuttle?: ShuttleRef | null;
      usedShuttles?: ShuttleRef[];
    };

/**
 * A host-set lineup waiting for a free court. Seats are player ids or null
 * (open — the engine fills them when a court takes this entry). `blocked`
 * names seated players who cannot take their seat right now; they are vacated
 * when the lineup is applied.
 */
export interface LineupEntry {
  id: string;
  position: number;
  teamA: Seat[];
  teamB: Seat[];
  blocked: { playerId: string; reason: 'resting' | 'on-court' }[];
}
