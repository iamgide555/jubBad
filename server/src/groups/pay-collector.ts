import { ConflictException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * A collector must be a player of this group who has linked a LINE account
 * here: that link is how the bot knows who to message. A plain function, not a
 * provider, because GroupsModule cannot import SessionsModule (the reverse
 * import already exists) yet both modules need this check.
 */
export async function assertCollectorEligible(
  prisma: PrismaService,
  groupId: string,
  playerId: string,
): Promise<void> {
  const link = await prisma.playerLineAccount.findFirst({
    where: { groupId, playerId, player: { groupId } },
    select: { id: true },
  });
  if (link === null) throw new ConflictException({ code: 'COLLECTOR_INVALID' });
}
