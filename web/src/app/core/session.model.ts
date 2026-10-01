import type { CourtState } from './live-session.model';

export interface Session {
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
  /** Snapshot of the group's advanced-tools switch at creation: true means numbered shuttle tracking
   *  is on for this session. Absent reads as off (older fixtures and sessions). */
  shuttleToolsEnabled?: boolean;
  createdAt: string;
  /** Server's clock at response time — the skew reference for live court timers. */
  serverNow: string;
  /** 'level' (C1) spreads partners like 'variety' but dominated first by the
   *  ±1 skill band. Levels themselves are host-only, read separately via
   *  LiveSessionService.getLevels — never on this session poll. */
  mode: 'variety' | 'balanced' | 'level' | 'custom';
  /** 'wait' in a level session, 'games' otherwise — how the waiting list
   *  should be ordered to match what the engine actually does. */
  queueBy: 'games' | 'wait';
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
  /** Per-court display names, index 0 = court 1; null/absent = the number.
   *  Resolve with labelForCourt, never read `.length` as a court count. */
  courtLabels: (string | null)[];
  /** Highest court the host may label — may exceed courtCount for retired
   *  courts that still have matches or a label. */
  editableCourtCount: number;
}
