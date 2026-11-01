import { ConflictException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * A collector must be a player of this group who has linked a LINE account
 * here: that link is how the bot knows who to message. Returns that link's
 * LINE user id, which the caller pins beside the player id. A plain function, not a
 * provider, because GroupsModule cannot import SessionsModule (the reverse
 * import already exists) yet both modules need this check.
 */
export async function assertCollectorEligible(
  prisma: PrismaService,
  groupId: string,
  playerId: string,
): Promise<string> {
  const link = await prisma.playerLineAccount.findFirst({
    where: { groupId, playerId, player: { groupId } },
    select: { lineUserId: true },
  });
  if (link === null) throw new ConflictException({ code: 'COLLECTOR_INVALID' });
  return link.lineUserId;
}

/**
 * Whether a stored collector pick still holds: the player is still linked here to the very LINE account the host
 * picked (the returned id of assertCollectorEligible, pinned beside the player id). A pick without a pinned id, an
 * unlinked player, or a player now linked to some other LINE account all fail, so collector powers never pass to
 * whoever links that player next; the host picks again.
 */
export function collectorPinHolds(
  liveLineUserId: string | null | undefined,
  pinnedLineUserId: string | null | undefined,
): boolean {
  return typeof pinnedLineUserId === 'string' && pinnedLineUserId !== '' && liveLineUserId === pinnedLineUserId;
}
