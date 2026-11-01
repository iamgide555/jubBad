import { Injectable } from '@nestjs/common';
import { collectorPinHolds } from '../groups/pay-collector.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { parsePayAccount, sameReceivingAccount } from './pay-account.js';
import { parsePaymentState } from './payment-card-state.js';

export interface BillCollector {
  playerId: string;
  playerName: string;
  lineUserId: string;
  lineName: string | null;
  pictureUrl: string | null;
}

/**
 * Who collects a bill's payments, if anyone. The group's saved collector owns
 * the group's saved account; a card confirmed with some other account belongs
 * to that night's own collector instead. Compared by bank and number (not
 * name), so the group's collector stops applying the moment the money would go
 * somewhere else, and never silently inherits an account they do not own.
 *
 * Either pick is pinned to the LINE account the player was linked to when the
 * host made it: access holds only while that same LINE account is still the
 * player's link here. An unlink ends it, and a different LINE account linked to
 * that player later (a self-claim on the pay page, a host repoint) does not
 * inherit it; the host picks again.
 */
@Injectable()
export class CollectorService {
  constructor(private readonly prisma: PrismaService) {}

  async forBill(code: string): Promise<BillCollector | null> {
    const session = await this.prisma.session.findUnique({
      where: { code },
      select: {
        groupId: true,
        paymentCard: true,
        group: { select: { payAccount: true, payCollectorPlayerId: true, payCollectorLineUserId: true } },
      },
    });
    if (session === null) return null;
    const state = parsePaymentState(session.paymentCard);
    const groupAccount = parsePayAccount(session.group.payAccount);
    const cardAccount = state.account ?? groupAccount;
    const [playerId, pinned] = sameReceivingAccount(cardAccount, groupAccount)
      ? [session.group.payCollectorPlayerId, session.group.payCollectorLineUserId]
      : [state.collectorPlayerId ?? null, state.collectorLineUserId ?? null];
    if (playerId === null) return null;

    const link = await this.prisma.playerLineAccount.findFirst({
      where: { groupId: session.groupId, playerId },
      select: {
        lineUserId: true,
        player: { select: { name: true } },
        lineAccount: { select: { displayName: true, pictureUrl: true } },
      },
    });
    if (link === null || !collectorPinHolds(link.lineUserId, pinned)) return null;
    return {
      playerId,
      playerName: link.player.name,
      lineUserId: link.lineUserId,
      lineName: link.lineAccount.displayName,
      pictureUrl: link.lineAccount.pictureUrl,
    };
  }
}
