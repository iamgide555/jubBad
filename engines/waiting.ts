/**
 * When a player's current wait started — the single definition shared by the
 * rotation engine, the API, and both client screens.
 *
 * A wait starts at the latest of three moments: the end of their last match,
 * the moment they were brought into the session, or the session start. Taking
 * the latest is what stops a player who arrived an hour late from counting as
 * having waited an hour, which would put them ahead of people who were
 * actually here.
 *
 * This lived only in the web client while the engine ignored waiting entirely,
 * so the queue the host could see and the order the engine actually used were
 * two different things. See
 * docs/2026-09-07-project-audit-and-matchmaking-gaps.md, finding 30.
 */

export function waitingSinceMs(
  playerId: string,
  lastPlayedAt: Record<string, string>,
  sessionCreatedAt: string,
  activatedAt: Record<string, string> = {}
): number {
  return Math.max(
    new Date(sessionCreatedAt).getTime(),
    lastPlayedAt[playerId] ? new Date(lastPlayedAt[playerId]).getTime() : 0,
    activatedAt[playerId] ? new Date(activatedAt[playerId]).getTime() : 0
  );
}

/** The same values the engine tie-breaks on, keyed by player. */
export function waitingSinceMap(
  playerIds: string[],
  lastPlayedAt: Record<string, string>,
  sessionCreatedAt: string,
  activatedAt: Record<string, string> = {}
): Map<string, number> {
  return new Map(
    playerIds.map((id) => [id, waitingSinceMs(id, lastPlayedAt, sessionCreatedAt, activatedAt)])
  );
}
