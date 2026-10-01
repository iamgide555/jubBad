/**
 * Pure read-model builders for the public group dashboard. Kept free of
 * Prisma so the ranking rules are testable without a database.
 *
 * Deliberately participation-only: no rating, level or win/loss, and no
 * player id leaves this file. A public ranked skill list would put the
 * weakest players in front of the whole chat (docs/overview.md, Ratings).
 */

export const DASHBOARD_SESSION_LIMIT = 30;

/** One confirmed match: the session it belongs to and everyone on court. */
export interface DashboardMatch {
  sessionCode: string;
  playerIds: string[];
}

export interface StandingRow {
  name: string;
  sessionsAttended: number;
  gamesPlayed: number;
}

export interface DashboardSessionInput {
  code: string;
  date: string | null;
  venue: string | null;
  createdAt: Date;
  endedAt: Date | null;
}

export interface DashboardSession {
  code: string;
  date: string | null;
  createdAt: string;
  venue: string | null;
  playerCount: number;
  matchCount: number;
  live: boolean;
}

/**
 * All-time, over confirmed matches only. "Attended" means in at least one
 * confirmed match that session, so a rostered no-show does not count. A
 * player id with no name (the player was deleted) is skipped.
 */
export function buildStandings(
  matches: DashboardMatch[],
  names: ReadonlyMap<string, string>
): StandingRow[] {
  const games = new Map<string, number>();
  const sessions = new Map<string, Set<string>>();
  for (const match of matches) {
    for (const id of match.playerIds) {
      games.set(id, (games.get(id) ?? 0) + 1);
      const seen = sessions.get(id) ?? new Set<string>();
      seen.add(match.sessionCode);
      sessions.set(id, seen);
    }
  }

  const rows: StandingRow[] = [];
  for (const [id, gamesPlayed] of games) {
    const name = names.get(id);
    if (name === undefined) continue;
    rows.push({ name, sessionsAttended: sessions.get(id)!.size, gamesPlayed });
  }
  return rows.sort(
    (a, b) =>
      b.sessionsAttended - a.sessionsAttended ||
      b.gamesPlayed - a.gamesPlayed ||
      a.name.localeCompare(b.name)
  );
}

/**
 * `sessions` must already be newest first. An ended session with no confirmed
 * match (created, never played) is dropped: it has nothing to show. A live
 * session is always kept, even before its first match is confirmed.
 */
export function buildSessionList(
  sessions: DashboardSessionInput[],
  matches: DashboardMatch[]
): DashboardSession[] {
  const matchCount = new Map<string, number>();
  const players = new Map<string, Set<string>>();
  for (const match of matches) {
    matchCount.set(match.sessionCode, (matchCount.get(match.sessionCode) ?? 0) + 1);
    const seen = players.get(match.sessionCode) ?? new Set<string>();
    for (const id of match.playerIds) seen.add(id);
    players.set(match.sessionCode, seen);
  }

  const list: DashboardSession[] = [];
  for (const s of sessions) {
    const live = s.endedAt === null;
    const count = matchCount.get(s.code) ?? 0;
    if (!live && count === 0) continue;
    list.push({
      code: s.code,
      date: s.date,
      createdAt: s.createdAt.toISOString(),
      venue: s.venue,
      playerCount: players.get(s.code)?.size ?? 0,
      matchCount: count,
      live,
    });
    if (list.length === DASHBOARD_SESSION_LIMIT) break;
  }
  return list;
}
