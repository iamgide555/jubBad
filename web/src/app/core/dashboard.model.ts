/** Public group dashboard payload — GET /dashboards/:token. No player ids, ratings or levels exist in it. */
export interface DashboardSession {
  code: string;
  date: string | null;
  /** ISO timestamp; the label when `date` is null. */
  createdAt: string;
  venue: string | null;
  playerCount: number;
  matchCount: number;
  /** Not ended yet. */
  live: boolean;
}

export interface DashboardStanding {
  name: string;
  sessionsAttended: number;
  gamesPlayed: number;
}

export interface Dashboard {
  groupName: string | null;
  lastSessionDate: string | null;
  sessions: DashboardSession[];
  standings: DashboardStanding[];
}
