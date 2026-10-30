import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PaymentCardService } from '../payment-card.service.js';
import { SessionLock } from '../session-lock.js';

/** One person's paid mark on the bill screen. */
export interface PaidRow {
  playerId: string;
  source: 'slip' | 'host';
  /** ISO time the mark was written. */
  at: string;
  /** A slip credited an amount that no longer matches the player's current bill row. The mark stays; the host decides. */
  amountChangedSince: boolean;
}

/** The LINE profile the pay page reads for the viewer. Only `userId` is required to link; the rest is for display. */
export interface LiffUser {
  userId: string;
  displayName: string | null;
  pictureUrl: string | null;
}

export type ClaimOutcome = 'linked' | 'player-taken' | 'account-already-linked' | 'not-on-bill';

export interface LinkRow {
  playerId: string;
  displayName: string | null;
  linkedBy: 'self' | 'host';
}

/**
 * Per-person paid state for one session: a `SessionPayment` row exists exactly while the person counts as paid.
 * Written by a matched slip or by the host's tick. Every write runs under the session lock, like the card's.
 */
@Injectable()
export class SlipPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cards: PaymentCardService,
    private readonly lock: SessionLock
  ) {}

  async getPaid(code: string): Promise<PaidRow[]> {
    const panel = await this.cards.panel(code);
    const current = new Map(panel.rows.map((r) => [r.playerId, r.amountSatang]));
    const stored = await this.prisma.sessionPayment.findMany({ where: { sessionId: code }, orderBy: { createdAt: 'asc' } });
    return stored.map((p) => ({
      playerId: p.playerId,
      source: p.source === 'slip' ? 'slip' : 'host',
      at: p.createdAt.toISOString(),
      amountChangedSince: p.amountSatang !== null && p.amountSatang !== current.get(p.playerId),
    }));
  }

  /** The host marks a person paid. Already paid (by a slip or an earlier tick) stays as it is. */
  tick(code: string, playerId: string): Promise<void> {
    return this.lock.run(code, async () => {
      const panel = await this.cards.panel(code);
      if (!panel.rows.some((r) => r.playerId === playerId)) throw new ConflictException({ code: 'PLAYER_NOT_ON_BILL' });
      await this.prisma.sessionPayment.upsert({
        where: { sessionId_playerId: { sessionId: code, playerId } },
        create: { sessionId: code, playerId, source: 'host' },
        update: {},
      });
    });
  }

  /** Removes the paid mark if there is one. The slip's reference is deliberately left alone by this task. */
  untick(code: string, playerId: string): Promise<void> {
    return this.lock.run(code, async () => {
      await this.cards.panel(code);
      await this.prisma.sessionPayment.deleteMany({ where: { sessionId: code, playerId } });
    });
  }

  /**
   * A viewer claims "this is me" on the pay page. One account per player and one player per account within the group;
   * the first claim wins and a later one never overwrites it (the host can repoint with `setLink`).
   */
  claimPlayer(code: string, user: LiffUser, playerId: string): Promise<ClaimOutcome> {
    return this.lock.run(code, async () => {
      const panel = await this.cards.panel(code);
      if (!panel.rows.some((r) => r.playerId === playerId)) return 'not-on-bill';
      const groupId = await this.groupOf(code);
      // A bill row always belongs to the session's group, but a link row must never depend on that being true.
      if (!(await this.prisma.player.findFirst({ where: { id: playerId, groupId }, select: { id: true } }))) return 'not-on-bill';

      const existing = await this.existingOutcome(groupId, user.userId, playerId);
      if (existing) return existing;
      try {
        await this.prisma.playerLineAccount.create({
          data: { groupId, playerId, lineUserId: user.userId, displayName: user.displayName, linkedBy: 'self' },
        });
      } catch (error) {
        // The lock is per session, so a claim from another session of this group can win between the check and the
        // create. Judge the row that won the same way as the pre-check does.
        if (!isUniqueViolation(error)) throw error;
        return (await this.existingOutcome(groupId, user.userId, playerId)) ?? 'player-taken';
      }
      return 'linked';
    });
  }

  /** The player this LINE account is linked to in the group, if any. */
  async linkedPlayerOf(groupCode: string, lineUserId: string): Promise<string | null> {
    const link = await this.prisma.playerLineAccount.findUnique({
      where: { groupId_lineUserId: { groupId: groupCode, lineUserId } },
      select: { playerId: true },
    });
    return link?.playerId ?? null;
  }

  /** Every link in the session's group, oldest first. */
  async listLinks(code: string): Promise<LinkRow[]> {
    const groupId = await this.groupOf(code);
    const links = await this.prisma.playerLineAccount.findMany({ where: { groupId }, orderBy: { createdAt: 'asc' } });
    return links.map((l) => ({
      playerId: l.playerId,
      displayName: l.displayName,
      linkedBy: l.linkedBy === 'self' ? 'self' : 'host',
    }));
  }

  /** Host: points the player at this account (replacing any link the player has), or with `null` removes the link. */
  setLink(code: string, playerId: string, lineUserId: string | null): Promise<void> {
    return this.lock.run(code, async () => {
      const groupId = await this.groupOf(code);
      if (lineUserId === null) {
        await this.prisma.playerLineAccount.deleteMany({ where: { groupId, playerId } });
        return;
      }
      if (!(await this.prisma.player.findFirst({ where: { id: playerId, groupId }, select: { id: true } }))) {
        throw new ConflictException({ code: 'PLAYER_NOT_IN_GROUP' });
      }
      const byAccount = await this.prisma.playerLineAccount.findUnique({
        where: { groupId_lineUserId: { groupId, lineUserId } },
      });
      if (byAccount && byAccount.playerId !== playerId) throw new ConflictException({ code: 'ACCOUNT_ALREADY_LINKED' });
      try {
        if (byAccount) {
          // Already this player's account: only the label changes; the stored name and age stay.
          await this.prisma.playerLineAccount.update({ where: { id: byAccount.id }, data: { linkedBy: 'host' } });
          return;
        }
        await this.prisma.$transaction([
          this.prisma.playerLineAccount.deleteMany({ where: { groupId, playerId } }),
          this.prisma.playerLineAccount.create({
            data: { groupId, playerId, lineUserId, displayName: null, linkedBy: 'host' },
          }),
        ]);
      } catch (error) {
        // Another session of this group linked the account in between (the lock is per session); the transaction
        // rolled back, so nothing changed.
        if (isUniqueViolation(error)) throw new ConflictException({ code: 'ACCOUNT_ALREADY_LINKED' });
        throw error;
      }
    });
  }

  /** What an existing link says about a claim, or null when neither the account nor the player is linked. */
  private async existingOutcome(groupId: string, lineUserId: string, playerId: string): Promise<ClaimOutcome | null> {
    const byAccount = await this.prisma.playerLineAccount.findUnique({
      where: { groupId_lineUserId: { groupId, lineUserId } },
    });
    if (byAccount) return byAccount.playerId === playerId ? 'linked' : 'account-already-linked';
    const byPlayer = await this.prisma.playerLineAccount.findUnique({ where: { groupId_playerId: { groupId, playerId } } });
    return byPlayer ? 'player-taken' : null;
  }

  private async groupOf(code: string): Promise<string> {
    const session = await this.prisma.session.findUnique({ where: { code }, select: { groupId: true } });
    if (!session) throw new NotFoundException();
    return session.groupId;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
