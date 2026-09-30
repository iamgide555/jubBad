/**
 * Linked-carry outcomes (host-feedback C): a snapshot, taken at confirmation,
 * of whether a must-pair-linked player's game counted as their carry. See
 * docs/archive/specs/2026-09-30-pair-rules-design.md, "Pending matches,
 * overrides and carry state".
 */

import { isFarBelow, levelIndex } from '../../../engines/levels.ts';
import type { Level } from '../../../engines/levels.ts';

export type CarryOutcome = { playerId: string; partnerId: string | null };

export class InvalidCarryOutcomesError extends Error {}

/**
 * One outcome per tagged player holding an enabled must-pair link, far-below
 * or not: recording the null decision now is what stops a later roster change
 * from reinterpreting this game as a completed carry.
 */
export function carryOutcomesForConfirm(
  teams: { teamA: string[]; teamB: string[] },
  linkedIds: ReadonlySet<string>,
  levels: ReadonlyMap<string, Level | null>,
  activeRosterIds: readonly string[]
): CarryOutcome[] {
  const activeLevels = new Map(activeRosterIds.map((id) => [id, levels.get(id) ?? null] as const));
  const outcomes: CarryOutcome[] = [];
  for (const team of [teams.teamA, teams.teamB]) {
    for (const playerId of team) {
      if (!linkedIds.has(playerId)) continue;
      const level = levels.get(playerId) ?? null;
      if (level === null) continue;
      let partnerId: string | null = null;
      if (isFarBelow(playerId, activeLevels)) {
        const mate = team.find((id) => id !== playerId);
        const mateLevel = mate === undefined ? null : levels.get(mate) ?? null;
        if (mate !== undefined && mateLevel !== null && levelIndex(mateLevel) > levelIndex(level)) {
          partnerId = mate;
        }
      }
      outcomes.push({ playerId, partnerId });
    }
  }
  return outcomes;
}

/** `[]` is the legacy value (no linked outcome recorded). Anything malformed
 *  throws rather than being read as a completed carry. */
export function parseCarryOutcomes(raw: string): CarryOutcome[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidCarryOutcomesError(`carryOutcomes is not JSON: ${raw}`);
  }
  const valid =
    Array.isArray(parsed) &&
    parsed.every(
      (o) =>
        typeof o === 'object' &&
        o !== null &&
        typeof o.playerId === 'string' &&
        o.playerId.length > 0 &&
        'partnerId' in o &&
        (o.partnerId === null || (typeof o.partnerId === 'string' && o.partnerId.length > 0))
    );
  if (!valid) throw new InvalidCarryOutcomesError(`carryOutcomes is malformed: ${raw}`);
  return (parsed as CarryOutcome[]).map(({ playerId, partnerId }) => ({ playerId, partnerId }));
}
