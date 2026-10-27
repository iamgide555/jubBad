import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { planAtLeast } from '../plans/plan.js';
import { PlansService } from '../plans/plans.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  CODE_TTL_MS,
  hashCode,
  newCode,
  normalizeCode,
  PENDING_TTL_MS,
} from './line-code.js';
import { lineConfig } from './line-config.js';

export interface LineHostStatus {
  configured: boolean;
  botAddUrl: string | null;
  linked: boolean;
  linkedAt: string | null;
}

/** Thrown inside the redeem transaction to roll it back; never leaves this file. */
class RedeemRefused extends Error {}

/**
 * Links a host's own LINE account (one-to-one chat with the bot) to their JubBad
 * user, so a roster DMed to the bot can be captured. Same code flow as
 * LineLinkService, but the binding lands on the user, not on a group.
 */
@Injectable()
export class LineHostService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlansService,
  ) {}

  async status(userId: string): Promise<LineHostStatus> {
    const config = lineConfig();
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { lineUserId: true, lineLinkedAt: true },
    });
    return {
      configured: config.secret !== null && config.token !== null,
      botAddUrl: config.botAddUrl,
      linked: user?.lineUserId != null,
      linkedAt: user?.lineLinkedAt?.toISOString() ?? null,
    };
  }

  /** Only the hash is stored; a new code voids the user's earlier unused ones. */
  async createCode(
    userId: string,
    now: Date = new Date(),
  ): Promise<{ code: string; expiresAt: string }> {
    const config = lineConfig();
    if (!config.secret || !config.token)
      throw new ServiceUnavailableException({ code: 'LINE_NOT_CONFIGURED' });
    await this.plans.requireUserPlan(userId, 'host');
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { lineUserId: true },
    });
    if (user?.lineUserId != null)
      throw new ConflictException({ code: 'LINE_ALREADY_LINKED' });

    const code = newCode();
    const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
    await this.prisma.$transaction([
      this.prisma.lineUserLinkCode.deleteMany({
        where: { userId, usedAt: null },
      }),
      this.prisma.lineUserLinkCode.create({
        data: { userId, codeHash: hashCode(code), expiresAt },
      }),
    ]);
    return { code, expiresAt: expiresAt.toISOString() };
  }

  /**
   * `/link <code>` from the host's one-to-one chat. Null for every refusal (wrong,
   * expired or used code, a lapsed plan, either side already linked), so the caller
   * can say one generic thing. The claim and the bind are one transaction, so two
   * simultaneous redeems cannot both link.
   */
  async redeem(
    lineUserId: string,
    rawCode: string,
    now: Date = new Date(),
  ): Promise<{ userId: string } | null> {
    const code = normalizeCode(rawCode);
    if (code === null) return null;
    const codeHash = hashCode(code);

    const pending = await this.prisma.lineUserLinkCode.findUnique({
      where: { codeHash },
    });
    if (
      !pending ||
      pending.usedAt !== null ||
      pending.expiresAt.getTime() <= now.getTime()
    )
      return null;
    const userId = pending.userId;
    if (!planAtLeast(await this.plans.planForUser(userId, now), 'host'))
      return null;

    try {
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.lineUserLinkCode.updateMany({
          where: { codeHash, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });
        if (claimed.count !== 1) throw new RedeemRefused();
        const linked = await tx.user.updateMany({
          where: { id: userId, lineUserId: null },
          data: { lineUserId, lineLinkedAt: now },
        });
        if (linked.count !== 1) throw new RedeemRefused();
      });
    } catch (error) {
      // RedeemRefused: lost the race or the user is already linked. P2002: this LINE user is linked to someone else.
      if (error instanceof RedeemRefused) return null;
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        return null;
      throw error;
    }
    return { userId };
  }

  /** Always allowed, on any plan: clears the link and forgets everything stored for it. */
  async unlink(userId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.user.updateMany({
        where: { id: userId },
        data: { lineUserId: null, lineLinkedAt: null },
      }),
      this.prisma.lineUserLinkCode.deleteMany({ where: { userId } }),
      this.prisma.linePendingRoster.deleteMany({ where: { userId } }),
    ]);
  }

  async userForLineUser(lineUserId: string): Promise<{ id: string } | null> {
    return this.prisma.user.findUnique({
      where: { lineUserId },
      select: { id: true },
    });
  }

  /**
   * Housekeeping: codes that expired or were used more than a day ago, and pending
   * rosters past their 10 minutes. A row goes only when both its timestamps are
   * stale, so a roster that a newer DM replaced is never swept out from under the host.
   */
  async purgeExpired(now: Date = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    await this.prisma.lineUserLinkCode.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: cutoff } }, { usedAt: { lt: cutoff } }],
      },
    });
    const pendingCutoff = new Date(now.getTime() - PENDING_TTL_MS);
    await this.prisma.linePendingRoster.deleteMany({
      where: {
        createdAt: { lt: pendingCutoff },
        postedAt: { lt: pendingCutoff },
      },
    });
  }
}
