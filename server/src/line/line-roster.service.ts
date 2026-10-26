import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isRosterMessage, messagesToPurge } from '../../../engines/line-roster.ts';
import { planAtLeast } from '../plans/plan.js';
import { PlansService } from '../plans/plans.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LineClient } from './line-client.js';

export interface CaptureInput {
  lineGroupId: string;
  lineMessageId: string;
  text: string;
  senderUserId: string | null;
  /** LINE's own event time, never the arrival time: redelivery can reorder events. */
  postedAt: Date;
}

/**
 * Keeps roster messages from linked LINE groups and nothing else. Every method
 * is a no-op for an unlinked group or an owner who is not on a paid plan right
 * now, so a lapsed plan stops the bot's storing without touching the link.
 */
@Injectable()
export class LineRosterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlansService,
    private readonly client: LineClient
  ) {}

  async capture(input: CaptureInput): Promise<'stored' | 'ignored'> {
    // Cheapest check first: most chat is not a roster and never touches the database.
    if (!isRosterMessage(input.text)) return 'ignored';
    const groupCode = await this.paidLinkedGroup(input.lineGroupId);
    if (groupCode === null) return 'ignored';

    const senderName = input.senderUserId ? await this.client.memberName(input.lineGroupId, input.senderUserId) : null;
    try {
      await this.prisma.lineRosterMessage.create({
        data: {
          groupId: groupCode,
          text: input.text,
          senderUserId: input.senderUserId,
          senderName,
          postedAt: input.postedAt,
          lineMessageId: input.lineMessageId,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return 'ignored';
      throw error;
    }
    await this.purgeGroup(groupCode, new Date());
    return 'stored';
  }

  /**
   * A user edited a message. The stored text follows the edit and keeps its
   * original time; an edit that is no longer a roster removes the row; an edit
   * of a message never stored (it was not a roster when posted) is captured.
   */
  async edit(input: CaptureInput): Promise<'updated' | 'removed' | 'stored' | 'ignored'> {
    const existing = await this.prisma.lineRosterMessage.findUnique({ where: { lineMessageId: input.lineMessageId } });
    if (!existing) return this.capture(input);
    if ((await this.paidLinkedGroup(input.lineGroupId)) === null) return 'ignored';
    if (!isRosterMessage(input.text)) {
      await this.prisma.lineRosterMessage.delete({ where: { id: existing.id } });
      return 'removed';
    }
    await this.prisma.lineRosterMessage.update({ where: { id: existing.id }, data: { text: input.text } });
    return 'updated';
  }

  async unsend(lineMessageId: string): Promise<void> {
    await this.prisma.lineRosterMessage.deleteMany({ where: { lineMessageId } });
  }

  /** Sweep for every group, so an idle group's old messages still age out. Returns rows deleted. */
  async purge(now: Date = new Date()): Promise<number> {
    const rows = await this.prisma.lineRosterMessage.findMany({ select: { id: true, groupId: true, postedAt: true } });
    const byGroup = new Map<string, { id: string; postedAt: Date }[]>();
    for (const row of rows) byGroup.set(row.groupId, [...(byGroup.get(row.groupId) ?? []), row]);
    const doomed = [...byGroup.values()].flatMap((group) => messagesToPurge(group, now));
    if (doomed.length === 0) return 0;
    return (await this.prisma.lineRosterMessage.deleteMany({ where: { id: { in: doomed } } })).count;
  }

  private async purgeGroup(groupCode: string, now: Date): Promise<void> {
    const rows = await this.prisma.lineRosterMessage.findMany({
      where: { groupId: groupCode },
      select: { id: true, postedAt: true },
    });
    const doomed = messagesToPurge(rows, now);
    if (doomed.length > 0) await this.prisma.lineRosterMessage.deleteMany({ where: { id: { in: doomed } } });
  }

  /** The JubBad group a LINE group is linked to, or null when unlinked or the owner is not paid now. */
  private async paidLinkedGroup(lineGroupId: string): Promise<string | null> {
    const group = await this.prisma.group.findUnique({ where: { lineGroupId }, select: { code: true } });
    if (!group) return null;
    return planAtLeast(await this.plans.planForGroup(group.code), 'host') ? group.code : null;
  }
}
