/**
 * Which active players are eligible for a carry game right now, and who has
 * already carried one tonight — pure, DB-agnostic derivation so it can be
 * unit-tested without Prisma. See
 * docs/superpowers/specs/2026-09-27-level-rework-design.md, section 1b.
 */

import { isFarBelow } from '../../../engines/levels.ts';
import type { Level } from '../../../engines/levels.ts';

export interface CarryInputs {
  /** Active roster player ids tonight. */
  activeRosterIds: string[];
  /** Every active player's tag, keyed by id. */
  levels: ReadonlyMap<string, Level | null>;
  /** Player id -> Player.levelSetAt (epoch ms), for players ever tagged. */
  levelSetAt: ReadonlyMap<string, number>;
  /** This session's confirmed pairings: each entry's player ids + confirmedAt (epoch ms). */
  confirmedPairingsTonight: { playerIds: string[]; confirmedAt: number }[];
}

export interface CarryEligibility {
  /** Far-below active players with no confirmed game tonight since their level was tagged. */
  carryEligible: Set<string>;
  /** Players who partnered a currently-far-below player in a confirmed game tonight. */
  carriedTonight: Set<string>;
}

export function computeCarryEligibility(input: CarryInputs): CarryEligibility {
  const activeLevels = new Map(
    input.activeRosterIds.map((id) => [id, input.levels.get(id) ?? null] as const)
  );

  const playedSince = (id: string, sinceMs: number): boolean =>
    input.confirmedPairingsTonight.some(
      (p) => p.confirmedAt >= sinceMs && p.playerIds.includes(id)
    );

  const carryEligible = new Set<string>();
  for (const id of input.activeRosterIds) {
    if (!isFarBelow(id, activeLevels)) continue;
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
  for (const p of input.confirmedPairingsTonight) {
    if (!p.playerIds.some((id) => isFarBelow(id, activeLevels))) continue;
    for (const id of p.playerIds) {
      if (!isFarBelow(id, activeLevels)) carriedTonight.add(id);
    }
  }

  return { carryEligible, carriedTonight };
}
