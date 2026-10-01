/**
 * Which active players are eligible for a carry game right now, and who has
 * already carried one tonight — pure, DB-agnostic derivation so it can be
 * unit-tested without Prisma. See
 * docs/superpowers/specs/2026-09-27-level-rework-design.md, section 1b.
 */

import { DEFAULT_LEVEL_LADDER, isFarBelow } from '../../../engines/levels.ts';
import type { Level, LevelSpec } from '../../../engines/levels.ts';
import type { CarryOutcome } from './carry-outcomes.js';

export interface CarryInputs {
  /** Active roster player ids tonight. */
  activeRosterIds: string[];
  /** Every active player's tag, keyed by id. */
  levels: ReadonlyMap<string, Level | null>;
  /** The group's ordered ladder. Omitted: the built-in one. */
  ladder?: readonly LevelSpec[];
  /** Player id -> Player.levelSetAt (epoch ms), for players ever tagged. */
  levelSetAt: ReadonlyMap<string, number>;
  /** This session's confirmed pairings: each entry's player ids + confirmedAt
   *  (epoch ms), plus any linked-carry outcomes snapshotted at confirmation.
   *  A player with no outcome on a pairing (legacy `[]`, or unlinked) keeps
   *  the any-game rule; a player with one counts only a non-null partner. */
  confirmedPairingsTonight: { playerIds: string[]; confirmedAt: number; carryOutcomes?: CarryOutcome[] }[];
}

export interface CarryEligibility {
  /** Far-below active players with no confirmed game tonight since their level was tagged. */
  carryEligible: Set<string>;
  /** Players who partnered a currently-far-below player in a confirmed game tonight. */
  carriedTonight: Set<string>;
}

export function computeCarryEligibility(input: CarryInputs): CarryEligibility {
  const ladder = input.ladder ?? DEFAULT_LEVEL_LADDER;
  const activeLevels = new Map(
    input.activeRosterIds.map((id) => [id, input.levels.get(id) ?? null] as const)
  );

  const outcomeFor = (p: CarryInputs['confirmedPairingsTonight'][number], id: string) =>
    p.carryOutcomes?.find((o) => o.playerId === id);

  const playedSince = (id: string, sinceMs: number): boolean =>
    input.confirmedPairingsTonight.some((p) => {
      if (p.confirmedAt < sinceMs || !p.playerIds.includes(id)) return false;
      const outcome = outcomeFor(p, id);
      return outcome === undefined || outcome.partnerId !== null;
    });

  const carryEligible = new Set<string>();
  for (const id of input.activeRosterIds) {
    if (!isFarBelow(id, activeLevels, ladder)) continue;
    const setAt = input.levelSetAt.get(id);
    if (setAt === undefined) continue; // isFarBelow already requires a tag; guards a missing entry
    if (playedSince(id, setAt)) continue;
    carryEligible.add(id);
  }

  // "Carried" is judged by isFarBelow, not carryEligible: a player who
  // already had their carry game tonight is still far-below (that never
  // changes mid-session) even though playing since their tag dropped them
  // out of carryEligible — their partner did carry them, and should stay
  // deprioritised as the next carry's pro.
  const carriedTonight = new Set<string>();
  // A linked game counts only its snapshotted teammate, never opponents.
  for (const p of input.confirmedPairingsTonight) {
    for (const farBelow of p.playerIds.filter((id) => isFarBelow(id, activeLevels, ladder))) {
      const outcome = outcomeFor(p, farBelow);
      if (outcome) {
        if (outcome.partnerId !== null) carriedTonight.add(outcome.partnerId);
        continue;
      }
      for (const id of p.playerIds) {
        if (!isFarBelow(id, activeLevels, ladder)) carriedTonight.add(id);
      }
    }
  }

  return { carryEligible, carriedTonight };
}
