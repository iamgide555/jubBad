import { asLevel, seedFor, type Level } from '../../engines/levels.ts';
import type { RatingAnchor } from '../../engines/elo.ts';
import type { PrismaService } from './prisma/prisma.service.js';

/** Write a level change, stamping the time it took effect only when it actually changed. */
export function levelWrite(
  previous: Level | null,
  next: Level | null
): { level?: Level | null; levelSetAt?: Date } {
  if (previous === next) return {};
  return { level: next, levelSetAt: new Date() };
}

/** A group's players, by id, with their skill level (null when unset). */
export async function loadPlayerLevels(
  prisma: PrismaService,
  groupId: string
): Promise<Map<string, Level | null>> {
  const players = await prisma.player.findMany({
    where: { groupId },
    select: { id: true, level: true },
  });
  return new Map(players.map((p) => [p.id, asLevel(p.level)]));
}

/** Rating anchors from each player's level and the time it was set. */
export async function loadRatingAnchors(
  prisma: PrismaService,
  groupId: string
): Promise<Map<string, RatingAnchor>> {
  const players = await prisma.player.findMany({
    where: { groupId },
    select: { id: true, level: true, levelSetAt: true },
  });

  return new Map(
    players.map((p) => [
      p.id,
      {
        rating: seedFor(asLevel(p.level)),
        setAt: p.levelSetAt ? p.levelSetAt.getTime() : null,
      },
    ])
  );
}
