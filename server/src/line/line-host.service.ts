import {
  ConflictException,
  Injectable,
  NotFoundException,
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
  /** The group's owner has linked their LINE account (one account for all their groups). */
  accountLinked: boolean;
  /** Rosters that account DMs to the bot may be filed under this group. */
  enabled: boolean;
  /** The group's default for the "send the summary card" checkbox at the end of a round. */
  summaryDefault: boolean;
  /**
   * The server can build the card and the LIFF button can open it. False for a bot-linked group:
   * its card is posted by the bot into the group, which has its own switch.
   */
  summaryAvailable: boolean;
}

/** Thrown inside the redeem transaction to roll it back; never leaves this file. */
class RedeemRefused extends Error {}

/**
 * Links a host's own LINE account (one-to-one chat with the bot) to their JubBad
 * user, so a roster DMed to the bot can be captured. Same code flow as
 * LineLinkService, but the binding lands on the user, and each group opts in
 * separately: the bot offers only the groups that have it switched on.
 */
@Injectable()
export class LineHostService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlansService,
  ) {}

  /** The group and its owner's LINE account; the owner is whose account every call below acts on. */
  private async ownerOf(
    groupCode: string,
  ): Promise<{
    ownerId: string;
    accountLinked: boolean;
    enabled: boolean;
    summaryDefault: boolean;
    botLinked: boolean;
  }> {
    const group = await this.prisma.group.findUnique({
      where: { code: groupCode },
      select: {
        ownerId: true,
        lineDmEnabled: true,
        lineSummaryDefault: true,
        lineGroupId: true,
        owner: { select: { lineUserId: true } },
      },
    });
    if (!group?.ownerId) throw new NotFoundException();
    return {
      ownerId: group.ownerId,
      accountLinked: group.owner?.lineUserId != null,
      enabled: group.lineDmEnabled,
      summaryDefault: group.lineSummaryDefault,
      botLinked: group.lineGroupId !== null,
    };
  }

  async status(groupCode: string): Promise<LineHostStatus> {
    const config = lineConfig();
    const { accountLinked, enabled, summaryDefault, botLinked } =
      await this.ownerOf(groupCode);
    return {
      configured: config.secret !== null && config.token !== null,
      botAddUrl: config.botAddUrl,
      accountLinked,
      enabled: accountLinked && enabled,
      summaryDefault,
      summaryAvailable:
        config.publicAppUrl !== null && config.liffId !== null && !botLinked,
    };
  }

  /**
   * Only the hash is stored; a new code voids the owner's earlier unused ones. The code
   * remembers the group it was asked for, so linking also switches that group on. An owner
   * whose account is already linked switches groups on with setEnabled instead.
   */
  async createCode(
    groupCode: string,
    now: Date = new Date(),
  ): Promise<{ code: string; expiresAt: string }> {
    const config = lineConfig();
    if (!config.secret || !config.token)
      throw new ServiceUnavailableException({ code: 'LINE_NOT_CONFIGURED' });
    await this.plans.requireGroupPlan(groupCode, 'host');
    const { ownerId: userId, accountLinked } = await this.ownerOf(groupCode);
    if (accountLinked)
      throw new ConflictException({ code: 'LINE_ALREADY_LINKED' });

    const code = newCode();
    const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
    await this.prisma.$transaction([
      this.prisma.lineUserLinkCode.deleteMany({
        where: { userId, usedAt: null },
      }),
      this.prisma.lineUserLinkCode.create({
        data: { userId, groupCode, codeHash: hashCode(code), expiresAt },
      }),
    ]);
    return { code, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Switch DM capture on or off for one group. On needs a linked account and the host plan;
   * off is always allowed, and drops the rosters this group captured by DM.
   */
  async setEnabled(groupCode: string, on: boolean): Promise<boolean> {
    if (on) {
      await this.plans.requireGroupPlan(groupCode, 'host');
      const { accountLinked } = await this.ownerOf(groupCode);
      if (!accountLinked)
        throw new ConflictException({ code: 'LINE_NOT_LINKED' });
      await this.prisma.group.update({
        where: { code: groupCode },
        data: { lineDmEnabled: true },
      });
      return true;
    }
    await this.ownerOf(groupCode);
    await this.prisma.$transaction([
      this.prisma.group.update({
        where: { code: groupCode },
        data: { lineDmEnabled: false },
      }),
      this.prisma.lineRosterMessage.deleteMany({
        where: { groupId: groupCode, direct: true },
      }),
    ]);
    return false;
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
  ): Promise<{ userId: string; groupName: string | null } | null> {
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

    let groupName: string | null = null;
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
        // Switch on the group whose page asked for the code, if the user still owns it.
        if (pending.groupCode !== null) {
          const enabled = await tx.group.updateMany({
            where: { code: pending.groupCode, ownerId: userId },
            data: { lineDmEnabled: true },
          });
          if (enabled.count === 1) {
            const group = await tx.group.findUnique({
              where: { code: pending.groupCode },
              select: { name: true, code: true },
            });
            groupName = group?.name?.trim() || group?.code || null;
          }
        }
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
    return { userId, groupName };
  }

  /**
   * Always allowed, on any plan: clears the account link for all of the host's groups, their
   * unused codes, any pending roster, and the rosters their groups captured by DM.
   */
  async unlink(userId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.user.updateMany({
        where: { id: userId },
        data: { lineUserId: null, lineLinkedAt: null },
      }),
      this.prisma.group.updateMany({
        where: { ownerId: userId },
        data: { lineDmEnabled: false },
      }),
      this.prisma.lineRosterMessage.deleteMany({
        where: { direct: true, group: { ownerId: userId } },
      }),
      this.prisma.lineUserLinkCode.deleteMany({ where: { userId } }),
      this.prisma.linePendingRoster.deleteMany({ where: { userId } }),
    ]);
  }

  /** Unlink the account of whoever owns this group (the group page is where the host asks). */
  async unlinkOwnerOf(groupCode: string): Promise<void> {
    await this.unlink((await this.ownerOf(groupCode)).ownerId);
  }

  /** The host blocked the bot: a held roster can no longer be chosen. The link itself stays. */
  async dropPending(lineUserId: string): Promise<void> {
    await this.prisma.linePendingRoster.deleteMany({
      where: { user: { lineUserId } },
    });
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
