/**
 * How long each waiting player has been off court, in whole minutes.
 *
 * Derived rather than stored: a player's wait starts when their last match
 * ended, or when the session began if they have not played yet — which is why
 * `lastPlayedAt` having no entry for someone is meaningful, not missing data.
 */
export function minutesWaiting(
  playerId: string,
  lastPlayedAt: Record<string, string>,
  sessionCreatedAt: string,
  now: number = Date.now()
): number {
  const since = lastPlayedAt[playerId] ?? sessionCreatedAt;
  const elapsed = now - new Date(since).getTime();
  return Math.max(0, Math.floor(elapsed / 60_000));
}

export interface WaitingEntry {
  id: string;
  name: string;
  minutes: number;
}

/** Longest wait first — the host's actual question is "who's been sitting?". */
export function buildWaitingList(
  playerIds: string[],
  names: string[],
  lastPlayedAt: Record<string, string>,
  sessionCreatedAt: string,
  now: number = Date.now()
): WaitingEntry[] {
  return playerIds
    .map((id, i) => ({
      id,
      name: names[i],
      minutes: minutesWaiting(id, lastPlayedAt, sessionCreatedAt, now),
    }))
    .sort((a, b) => b.minutes - a.minutes);
}
