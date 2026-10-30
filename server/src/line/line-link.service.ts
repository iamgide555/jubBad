import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { planAtLeast } from '../plans/plan.js';
import { PlansService } from '../plans/plans.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LineClient } from './line-client.js';
import { CODE_TTL_MS, hashCode, newCode, normalizeCode } from './line-code.js';
import { lineConfig } from './line-config.js';

export interface LineStatus {
  configured: boolean;
  botAddUrl: string | null;
  linked: boolean;
  lineGroupName: string | null;
  linkedAt: string | null;
  leftAt: string | null;
  /** Whether the end-of-session "send the summary card" checkbox starts ticked. */
  summaryDefault: boolean;
  /** Whether this server can send the card at all: needs `PUBLIC_APP_URL` for the button link. */
  summaryAvailable: boolean;
}

/** Thrown inside the redeem transaction to roll it back; never leaves this file. */
class RedeemRefused extends Error {}

@Injectable()
export class LineLinkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlansService,
    private readonly client: LineClient
  ) {}

  async status(groupCode: string): Promise<LineStatus> {
    const config = lineConfig();
    const group = await this.prisma.group.findUnique({ where: { code: groupCode } });
    return {
      configured: config.secret !== null && config.token !== null,
      botAddUrl: config.botAddUrl,
      linked: group?.lineGroupId != null,
      lineGroupName: group?.lineGroupId != null ? group.lineGroupName : null,
      linkedAt: group?.lineLinkedAt?.toISOString() ?? null,
      leftAt: group?.lineLeftAt?.toISOString() ?? null,
      summaryDefault: group?.lineSummaryDefault ?? true,
      summaryAvailable: config.publicAppUrl !== null,
    };
  }

  /**
   * Owner route: paid plan and a linked group only, like the rest of the bot. A group with
   * no bot still counts when the host DM is on and the owner's LINE account is linked: the
   * card goes to the host instead.
   */
  async setSummaryDefault(groupCode: string, on: boolean): Promise<boolean> {
    await this.plans.requireGroupPlan(groupCode, 'host');
    const group = await this.prisma.group.findUnique({
      where: { code: groupCode },
      include: { owner: { select: { lineUserId: true } } },
    });
    if (!group) throw new NotFoundException();
    const dmLinked = group.lineDmEnabled && group.owner?.lineUserId != null;
    if (group.lineGroupId === null && !dmLinked) throw new ConflictException({ code: 'LINE_NOT_LINKED' });
    await this.prisma.group.update({ where: { code: groupCode }, data: { lineSummaryDefault: on } });
    return on;
  }

  /** Owner route. Only the hash is stored; a new code voids the group's earlier unused ones. */
  async createCode(groupCode: string, now: Date = new Date()): Promise<{ code: string; expiresAt: string }> {
    const config = lineConfig();
    if (!config.secret || !config.token) throw new ServiceUnavailableException({ code: 'LINE_NOT_CONFIGURED' });
    await this.plans.requireGroupPlan(groupCode, 'host');
    const group = await this.prisma.group.findUnique({ where: { code: groupCode } });
    if (!group) throw new NotFoundException();
    if (group.lineGroupId !== null) throw new ConflictException({ code: 'LINE_ALREADY_LINKED' });

    const code = newCode();
    const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
    await this.prisma.$transaction([
      this.prisma.lineLinkCode.deleteMany({ where: { groupId: groupCode, usedAt: null } }),
      this.prisma.lineLinkCode.create({ data: { groupId: groupCode, codeHash: hashCode(code), expiresAt } }),
    ]);
    return { code, expiresAt: expiresAt.toISOString() };
  }

  /**
   * `/link <code>` from the LINE group. Null for every refusal (wrong, expired or
   * used code, a group on either side already linked, an unpaid owner), so the
   * caller can say one generic thing. The check-and-set is one transaction, so
   * two simultaneous redeems cannot both link.
   */
  async redeem(
    lineGroupId: string,
    rawCode: string,
    now: Date = new Date()
  ): Promise<{ groupCode: string; groupName: string | null } | null> {
    const code = normalizeCode(rawCode);
    if (code === null) return null;
    const codeHash = hashCode(code);

    const pending = await this.prisma.lineLinkCode.findUnique({ where: { codeHash } });
    if (!pending || pending.usedAt !== null || pending.expiresAt.getTime() <= now.getTime()) return null;
    const groupCode = pending.groupId;
    const owner = await this.plans.planForGroup(groupCode, now);
    if (!planAtLeast(owner, 'host')) return null;

    let groupName: string | null;
    try {
      groupName = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.lineLinkCode.updateMany({
          where: { codeHash, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });
        if (claimed.count !== 1) throw new RedeemRefused();
        const linked = await tx.group.updateMany({
          where: { code: groupCode, lineGroupId: null },
          data: { lineGroupId, lineLinkedAt: now, lineLeftAt: null },
        });
        if (linked.count !== 1) throw new RedeemRefused();
        const group = await tx.group.findUniqueOrThrow({ where: { code: groupCode }, select: { name: true } });
        return group.name;
      });
    } catch (error) {
      // RedeemRefused: lost the race. P2002: this LINE group is already linked elsewhere.
      if (error instanceof RedeemRefused) return null;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
      throw error;
    }

    const lineName = await this.client.groupName(lineGroupId);
    if (lineName !== null) {
      await this.prisma.group.update({ where: { code: groupCode }, data: { lineGroupName: lineName } });
    }
    return { groupCode, groupName };
  }

  /**
   * Clears the link, forgets everything stored for it, and asks the bot to leave
   * so it stops receiving a chat it no longer serves. A LINE failure never blocks it.
   */
  async unlink(groupCode: string): Promise<void> {
    const group = await this.prisma.group.findUnique({ where: { code: groupCode }, select: { lineGroupId: true } });
    await this.prisma.$transaction([
      this.prisma.group.updateMany({
        where: { code: groupCode },
        data: { lineGroupId: null, lineGroupName: null, lineLinkedAt: null, lineLeftAt: null },
      }),
      this.prisma.lineRosterMessage.deleteMany({ where: { groupId: groupCode } }),
      this.prisma.lineLinkCode.deleteMany({ where: { groupId: groupCode } }),
      // Slip links and slips go with the link; recorded SessionPayment rows stay.
      this.prisma.playerLineAccount.deleteMany({ where: { groupId: groupCode } }),
      this.prisma.pendingSlip.deleteMany({ where: { groupId: groupCode } }),
      this.prisma.slipDuplicate.deleteMany({ where: { groupId: groupCode } }),
      this.prisma.slipReference.deleteMany({ where: { groupId: groupCode } }),
    ]);
    if (group?.lineGroupId) await this.leaveQuietly(group.lineGroupId);
  }

  /** The bot was removed from the LINE group: same as unlink, minus the leave call, and remembered. */
  async markLeft(lineGroupId: string, now: Date = new Date()): Promise<void> {
    const group = await this.prisma.group.findUnique({ where: { lineGroupId }, select: { code: true } });
    if (!group) return;
    await this.prisma.$transaction([
      this.prisma.group.update({
        where: { code: group.code },
        data: { lineGroupId: null, lineGroupName: null, lineLinkedAt: null, lineLeftAt: now },
      }),
      this.prisma.lineRosterMessage.deleteMany({ where: { groupId: group.code } }),
      this.prisma.lineLinkCode.deleteMany({ where: { groupId: group.code } }),
      // Slip links and slips go with the link; recorded SessionPayment rows stay.
      this.prisma.playerLineAccount.deleteMany({ where: { groupId: group.code } }),
      this.prisma.pendingSlip.deleteMany({ where: { groupId: group.code } }),
      this.prisma.slipDuplicate.deleteMany({ where: { groupId: group.code } }),
      this.prisma.slipReference.deleteMany({ where: { groupId: group.code } }),
    ]);
  }

  /** Housekeeping: codes that expired or were used more than a day ago. */
  async purgeExpiredCodes(now: Date = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    await this.prisma.lineLinkCode.deleteMany({
      where: { OR: [{ expiresAt: { lt: cutoff } }, { usedAt: { lt: cutoff } }] },
    });
  }

  /** For callers that delete a group themselves: the group is gone, so only the bot is left to remove. */
  async leaveQuietly(lineGroupId: string): Promise<void> {
    try {
      await this.client.leave(lineGroupId);
    } catch {
      // Best effort: a LINE outage must not undo an unlink or a delete.
    }
  }
}
