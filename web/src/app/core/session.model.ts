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
  waitlistPlayerIds: string[];
  courts: CourtState[];
}
