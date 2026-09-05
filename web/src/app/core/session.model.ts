import type { CourtState } from './live-session.model';

export interface Session {
  code: string;
  groupCode: string;
  date: string | null;
  venue: string | null;
  courtCount: number | null;
  endedAt: string | null;
  rawImportText: string;
  rosterPlayerIds: string[];
  /** Roster players sitting out; still on the roster, skipped for court fills. */
  restingPlayerIds: string[];
  waitlistPlayerIds: string[];
  courts: CourtState[];
}
