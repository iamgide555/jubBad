/**
 * Numbered, reusable shuttles (host feedback D). The pure types and helpers
 * live here so the persistence layer, the lifecycle and the aggregates all
 * speak the same shapes. Nothing in this file touches Prisma.
 */

/** The host's choice when a game starts or its shuttle changes. */
export type ShuttleChoice = { kind: 'new' } | { kind: 'existing'; shuttleId: string };

/** A shuttle as clients see it: the id for writes, the number for display. */
export interface ShuttleRef {
  id: string;
  number: number;
}

/**
 * Checks which fields go with which kind of choice: `existing` needs a
 * shuttleId, `new` must not carry one. Returns the narrowed choice, or null
 * when the shape is inconsistent (the caller answers 400).
 */
export function parseShuttleChoice(input: { kind: 'new' | 'existing'; shuttleId?: string }): ShuttleChoice | null {
  if (input.kind === 'new') return input.shuttleId === undefined ? { kind: 'new' } : null;
  if (input.kind === 'existing' && typeof input.shuttleId === 'string' && input.shuttleId.length > 0) {
    return { kind: 'existing', shuttleId: input.shuttleId };
  }
  return null;
}

/** One game as the aggregate sees it: only the fields that decide whether and how it counts. */
export interface AccountedGame {
  confirmedAt: Date | null;
  endedAt: Date | null;
  shuttleLogKnown: boolean;
  shuttleIds: readonly string[];
}

export interface ShuttleAccounting {
  /** Distinct shuttle identities across the known logs of finished games — a shuttle reused ten times is one. */
  recordedFinishedShuttles: number;
  /** Finished games whose use was never recorded (legacy, or tracking was off). Makes the subtotal partial. */
  unknownFinishedMatches: number;
  finishedMatches: number;
  knownShuttleIds: string[];
}

/**
 * Derives the host-facing shuttle totals from persisted games, on every read.
 * Only confirmed, finished games count; an unknown log contributes to
 * `unknownFinishedMatches` and nothing else, while a known empty log is an
 * explicit zero. With no finished game the result carries `finishedMatches: 0`
 * so callers can tell "nothing to count yet" from a complete zero.
 */
export function deriveShuttleAccounting(games: readonly AccountedGame[]): ShuttleAccounting {
  const ids = new Set<string>();
  let finishedMatches = 0;
  let unknownFinishedMatches = 0;
  for (const game of games) {
    if (game.confirmedAt === null || game.endedAt === null) continue;
    finishedMatches += 1;
    if (!game.shuttleLogKnown) {
      unknownFinishedMatches += 1;
      continue;
    }
    for (const id of game.shuttleIds) ids.add(id);
  }
  return {
    recordedFinishedShuttles: ids.size,
    unknownFinishedMatches,
    finishedMatches,
    knownShuttleIds: [...ids],
  };
}
