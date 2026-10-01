import { InternalServerErrorException } from '@nestjs/common';
import { DEFAULT_LEVEL_LADDER, seedFor, type Level, type LevelSpec } from '../../engines/levels.ts';
import type { RatingAnchor } from '../../engines/elo.ts';
import type { PrismaService } from './prisma/prisma.service.js';

/**
 * Write a level change. Only a real change writes anything: it stamps the time
 * it took effect and freezes the rating anchor at that level's CURRENT seed in
 * the group's ladder (1200 when cleared). Choosing the level a player already
 * has is a no-op even if that level's seed has since been edited, so editing a
 * ladder never moves Elo that was already earned.
 */
export function levelWrite(
  previous: Level | null,
  next: Level | null,
  ladder: readonly LevelSpec[] = DEFAULT_LEVEL_LADDER,
  now: Date = new Date()
): { level?: Level | null; levelSeed?: number; levelSetAt?: Date } {
  if (previous === next) return {};
  return { level: next, levelSeed: seedFor(next, ladder), levelSetAt: now };
}

/**
 * A group's players, by id, with their skill level (null when unset), judged
 * against the GROUP's ladder. A stored label the ladder does not contain is a
 * data fault and throws: reading it as "untagged" would quietly widen the
 * level band and hand someone the wrong courts.
 */
export async function loadPlayerLevels(
  prisma: PrismaService,
  groupId: string,
  ladder: readonly LevelSpec[] = DEFAULT_LEVEL_LADDER
): Promise<Map<string, Level | null>> {
  const players = await prisma.player.findMany({
    where: { groupId },
    select: { id: true, level: true },
  });
  const known = new Set(ladder.map((l) => l.name));
  const unknown = players.filter((p) => p.level !== null && !known.has(p.level)).map((p) => p.id);
  if (unknown.length > 0) {
    throw new InternalServerErrorException({ code: 'LEVEL_DATA_INTEGRITY', playerIds: unknown });
  }
  return new Map(players.map((p) => [p.id, p.level]));
}

/** Player id -> when their level was last set (epoch ms), for every player
 *  who has ever been tagged. Untagged players (never set) are absent, not 0
 *  — a carry check must never treat "never tagged" as "tagged just now". */
export async function loadLevelSetAt(
  prisma: PrismaService,
  groupId: string
): Promise<Map<string, number>> {
  const players = await prisma.player.findMany({
    where: { groupId, levelSetAt: { not: null } },
    select: { id: true, levelSetAt: true },
  });
  return new Map(players.map((p) => [p.id, p.levelSetAt!.getTime()]));
}

/**
 * Rating anchors from each player's frozen seed and the time it was set. The
 * seed is read as saved, never re-derived from today's name-to-seed lookup, so
 * a ladder edit cannot rewrite earned ratings. A player who was never tagged
 * has no seed and starts at the plain 1200.
 */
export async function loadRatingAnchors(
  prisma: PrismaService,
  groupId: string
): Promise<Map<string, RatingAnchor>> {
  const players = await prisma.player.findMany({
    where: { groupId },
    select: { id: true, levelSeed: true, levelSetAt: true },
  });

  return new Map(
    players.map((p) => [
      p.id,
      {
        rating: p.levelSeed ?? seedFor(null),
        setAt: p.levelSetAt ? p.levelSetAt.getTime() : null,
      },
    ])
  );
}
