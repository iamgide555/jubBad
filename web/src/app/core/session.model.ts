import type { CourtState } from './live-session.model';

export interface Session {
  code: string;
  groupCode: string;
  date: string | null;
  venue: string | null;
  courtCount: number | null;
  endedAt: string | null;
  createdAt: string;
  mode: 'variety' | 'balanced';
  /** Player id -> ISO time they last finished a match tonight. */
  lastPlayedAt: Record<string, string>;
  /** Player id -> when they joined or returned; absent for the original roster. */
  activatedAt: Record<string, string>;
  rawImportText: string;
  rosterPlayerIds: string[];
  /** Roster players sitting out; still on the roster, skipped for court fills. */
  restingPlayerIds: string[];
  /**
   * Player id -> games as the rotation counts them (matches tonight plus any
   * fairness offset). Orders the waiting list to match how the engine actually
   * selects. Not a statistic — the stats endpoints never apply the offset.
   */
  queueGames: Record<string, number>;
  waitlistPlayerIds: string[];
  courts: CourtState[];
}
