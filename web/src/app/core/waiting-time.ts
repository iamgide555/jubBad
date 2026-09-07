import { waitingSinceMs } from '../../../../engines/waiting.ts';

/**
 * How long each waiting player has been off court, in whole minutes.
 *
 * Derived rather than stored, and from the shared definition in
 * `engines/waiting` so the number shown here is the same one the rotation
 * engine tie-breaks on. A wait starts at the latest of the end of the player's
 * last match, the moment they were brought into the session, or the session
 * start — which is what stops someone who arrived an hour late from being
 * shown as having waited an hour.
 */
export function minutesWaiting(
  playerId: string,
  lastPlayedAt: Record<string, string>,
  sessionCreatedAt: string,
  now: number = Date.now(),
  activatedAt: Record<string, string> = {}
): number {
  const since = waitingSinceMs(playerId, lastPlayedAt, sessionCreatedAt, activatedAt);
  return Math.max(0, Math.floor((now - since) / 60_000));
}

export interface WaitingEntry {
  id: string;
  name: string;
  minutes: number;
}

/**
 * The order the engine will actually select in: fewest games first, then
 * longest wait. Sorting on waiting time alone was misleading — it looked like
 * a queue while the engine chose on games played and broke ties at random, so
 * the name at the top was often not who went on next.
 *
 * `queueGames` counts games the way the rotation does, including the fairness
 * offset credited to a late arrival. Omitted, this sorts on waiting time alone.
 */
export function buildWaitingList(
  playerIds: string[],
  names: string[],
  lastPlayedAt: Record<string, string>,
  sessionCreatedAt: string,
  now: number = Date.now(),
  activatedAt: Record<string, string> = {},
  queueGames: Record<string, number> = {}
): WaitingEntry[] {
  return playerIds
    .map((id, i) => ({
      id,
      name: names[i],
      minutes: minutesWaiting(id, lastPlayedAt, sessionCreatedAt, now, activatedAt),
    }))
    .sort(
      (a, b) => (queueGames[a.id] ?? 0) - (queueGames[b.id] ?? 0) || b.minutes - a.minutes
    );
}
