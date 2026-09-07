/**
 * How long each waiting player has been off court, in whole minutes.
 *
 * Derived rather than stored. A wait starts at the latest of three things: the
 * end of their last match, the moment they were brought into the session, or
 * the session start. Taking the latest is what stops a player who arrived an
 * hour late from being shown as having waited an hour — which would contradict
 * the rotation, where they are deliberately *not* owed that time.
 */
export function minutesWaiting(
  playerId: string,
  lastPlayedAt: Record<string, string>,
  sessionCreatedAt: string,
  now: number = Date.now(),
  activatedAt: Record<string, string> = {}
): number {
  const since = Math.max(
    new Date(sessionCreatedAt).getTime(),
    lastPlayedAt[playerId] ? new Date(lastPlayedAt[playerId]).getTime() : 0,
    activatedAt[playerId] ? new Date(activatedAt[playerId]).getTime() : 0
  );
  return Math.max(0, Math.floor((now - since) / 60_000));
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
  now: number = Date.now(),
  activatedAt: Record<string, string> = {}
): WaitingEntry[] {
  return playerIds
    .map((id, i) => ({
      id,
      name: names[i],
      minutes: minutesWaiting(id, lastPlayedAt, sessionCreatedAt, now, activatedAt),
    }))
    .sort((a, b) => b.minutes - a.minutes);
}
