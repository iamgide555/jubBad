import type { ShuttleRef } from './shuttle.model';

export interface SessionMatch {
  matchNumber: number;
  courtNumber: number;
  /** Null for a singles match — there is no partner to name. */
  partnerName: string | null;
  opponentNames: string[];
  scoreA: number | null;
  scoreB: number | null;
  result: 'win' | 'loss' | 'no-result';
  durationSeconds: number;
}

export interface FormatRecord {
  played: number;
  won: number;
  lost: number;
}

export interface PlayerSessionStat {
  playerId: string;
  name: string;
  played: number;
  won: number;
  lost: number;
  /** Sum of durationSeconds across this player's matches. */
  totalSeconds: number;
  /** Tonight's distinct doubles partners; a repeated partner counts once. */
  distinctPartners: number;
  /** Null when this player never played that format this session. */
  singles: FormatRecord | null;
  doubles: FormatRecord | null;
  matches: SessionMatch[];
}

/** One finished game's shuttle log row. `shuttles` null = unknown (never recorded); [] = recorded as none. */
export interface ShuttleLogRow {
  pairingId: string;
  courtNumber: number;
  matchNumber: number;
  shuttles: ShuttleRef[] | null;
}

export interface SessionSummary {
  session: {
    code: string;
    groupCode: string;
    date: string | null;
    venue: string | null;
    courtCount: number | null;
    /** Total shuttlecocks used this session. Null means never recorded, distinct from 0. */
    shuttleCount: number | null;
    /** Price per shuttlecock, in satang (1 THB = 100 satang) — same null-vs-0 distinction. */
    shuttlePriceSatang: number | null;
    endedAt: string | null;
    /** Per-court display names, index 0 = court 1 — see labelForCourt. */
    courtLabels: (string | null)[];
  };
  players: PlayerSessionStat[];
  /** Advanced (shuttle-tracking) sessions only: read-only, chronological, one row per finished game. */
  shuttleLog?: ShuttleLogRow[];
  /** Advanced sessions only: distinct shuttles across known logs, and how many finished games have no record. */
  shuttleAccounting?: {
    recordedFinishedShuttles: number;
    unknownFinishedMatches: number;
    finishedMatches: number;
  };
}
