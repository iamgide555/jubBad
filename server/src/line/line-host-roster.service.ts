import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isRosterMessage } from '../../../engines/line-roster.ts';
import { planAtLeast } from '../plans/plan.js';
import { PlansService } from '../plans/plans.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { groupChoiceMessage } from './line-client.js';
import { PENDING_TTL_MS } from './line-code.js';
import { LineHostService } from './line-host.service.js';
import { LineRosterService } from './line-roster.service.js';

/** What the webhook replies with: plain text, or message objects (the Quick Reply group choice). */
export type HostReply = { kind: 'text'; text: string } | { kind: 'messages'; messages: unknown[] };

export interface HostRosterInput {
  lineUserId: string;
  lineMessageId: string;
  text: string;
  /** LINE's own event time, never the arrival time, as for a group capture. */
  postedAt: Date;
}

/** LINE allows 13 Quick Reply buttons. A host with more groups switched on is offered the 13 newest; none exists today. */
const MAX_CHOICES = 13;
/** Postback data: `pr:<pending id>:<group code>`. The roster itself never rides in it (300 character cap). */
const CHOICE_DATA = /^pr:([^:]+):(.+)$/;

// Spoken into the host's own LINE chat, so Thai only, like the group bot's replies.
const LINK_FIRST_TEXT =
  'บัญชี LINE นี้ยังไม่ได้ผูกกับ JubBad ขอรหัสได้ที่ JubBad > ตั้งค่ากลุ่ม > LINE ' +
  'แล้วส่ง /link ตามด้วยรหัสมาที่แชตนี้';
const NOT_ROSTER_TEXT =
  'ข้อความนี้ไม่เหมือนรายชื่อก๊วน (ต้องมีวันที่ สถานที่ หรือเวลา และรายชื่อเรียงเลขอย่างน้อย 3 คน) ' +
  'บอทไม่เก็บข้อความอื่น';
const NO_GROUP_TEXT =
  'ยังไม่มีก๊วนที่เปิดรับรายชื่อทางแชตนี้ เปิดได้ที่ JubBad > ตั้งค่ากลุ่ม > LINE แล้วส่งรายชื่อมาใหม่';
const PLAN_TEXT = 'การรับรายชื่อทาง LINE ใช้ได้กับแพ็กเกจ Host ขึ้นไป บอทจึงไม่ได้เก็บรายชื่อนี้';
const ASK_TEXT = 'รายชื่อนี้ของก๊วนไหน แตะเลือกด้านล่างภายใน 10 นาที';
/** One line for every refused tap: it never says whether the roster expired, was replaced, or the group changed. */
const SEND_AGAIN_TEXT = 'เลือกก๊วนไม่สำเร็จหรือหมดเวลาแล้ว ส่งรายชื่อมาใหม่อีกครั้ง';
const storedText = (groupName: string) =>
  `เก็บรายชื่อไว้ให้ก๊วน «${groupName}» แล้ว เปิดหน้าเริ่มก๊วนใน JubBad เพื่อใช้รายชื่อนี้`;

const text = (value: string): { kind: 'text'; text: string } => ({ kind: 'text', text: value });
/** A group with an empty name is shown by its code, so a button label is never empty. */
const groupLabel = (group: { code: string; name: string | null }) => group.name?.trim() || group.code;

/**
 * A roster a host DMed to the bot. Stored straight into the host's only group,
 * or held as one pending roster per host until they tap which group it is for.
 * Only roster-shaped text from a linked host on a paid plan is ever stored.
 */
@Injectable()
export class LineHostRosterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlansService,
    private readonly host: LineHostService,
    private readonly roster: LineRosterService
  ) {}

  async receive(input: HostRosterInput): Promise<HostReply> {
    const user = await this.host.userForLineUser(input.lineUserId);
    if (!user) return text(LINK_FIRST_TEXT);
    if (!isRosterMessage(input.text)) return text(NOT_ROSTER_TEXT);

    // LINE redelivers an event it thinks failed: a message already stored answers as it did the first time.
    const already = await this.prisma.lineRosterMessage.findUnique({
      where: { lineMessageId: input.lineMessageId },
      select: { direct: true, senderUserId: true, group: { select: { code: true, name: true } } }
    });
    if (already?.direct && already.senderUserId === input.lineUserId) {
      return text(storedText(groupLabel(already.group)));
    }

    // Only the groups the host switched DM capture on for; with one, no question is asked.
    const groups = await this.prisma.group.findMany({
      where: { ownerId: user.id, lineDmEnabled: true },
      orderBy: [{ createdAt: 'desc' }, { code: 'asc' }],
      take: MAX_CHOICES,
      select: { code: true, name: true }
    });
    if (groups.length === 0) return text(NO_GROUP_TEXT);
    // Every group here is the host's own, so the owner's plan is one answer for all of them.
    if (!planAtLeast(await this.plans.planForUser(user.id), 'host')) return text(PLAN_TEXT);

    if (groups.length === 1) {
      const [only] = groups;
      await this.store(only.code, input);
      return text(storedText(groupLabel(only)));
    }

    const pendingId = await this.hold(user.id, input);
    const choices = groups.map((group) => ({ label: groupLabel(group), data: `pr:${pendingId}:${group.code}` }));
    return { kind: 'messages', messages: [groupChoiceMessage(ASK_TEXT, choices)] };
  }

  /**
   * A tapped group button. Refused, with nothing stored, unless the pending roster
   * is still there and unexpired, belongs to the LINE user who tapped, and the
   * group is still owned by that host, still has DM capture on, and is on a paid plan now.
   */
  async choose(input: { lineUserId: string; data: string; now?: Date }): Promise<{ kind: 'text'; text: string }> {
    const now = input.now ?? new Date();
    const parsed = CHOICE_DATA.exec(input.data);
    if (!parsed) return text(SEND_AGAIN_TEXT);
    const [, pendingId, groupCode] = parsed;

    const user = await this.host.userForLineUser(input.lineUserId);
    if (!user) return text(SEND_AGAIN_TEXT);
    const pending = await this.prisma.linePendingRoster.findUnique({ where: { id: pendingId } });
    if (!pending || pending.userId !== user.id) return text(SEND_AGAIN_TEXT);
    if (now.getTime() - pending.createdAt.getTime() >= PENDING_TTL_MS) return text(SEND_AGAIN_TEXT);

    const group = await this.prisma.group.findUnique({
      where: { code: groupCode },
      select: { code: true, name: true, ownerId: true, lineDmEnabled: true }
    });
    if (!group || group.ownerId !== pending.userId || !group.lineDmEnabled) return text(SEND_AGAIN_TEXT);
    if (!planAtLeast(await this.plans.planForGroup(group.code, now), 'host')) return text(SEND_AGAIN_TEXT);

    if (!(await this.move(pending, group.code, input.lineUserId))) return text(SEND_AGAIN_TEXT);
    await this.roster.purgeFor(group.code, now);
    return text(storedText(groupLabel(group)));
  }

  /** A repeat of the same LINE message id (a redelivery racing the first) stores no second row. */
  private async store(groupCode: string, input: HostRosterInput): Promise<void> {
    try {
      await this.prisma.lineRosterMessage.create({
        data: {
          groupId: groupCode,
          text: input.text,
          senderUserId: input.lineUserId,
          senderName: null,
          postedAt: input.postedAt,
          lineMessageId: input.lineMessageId,
          botPosted: false,
          direct: true
        }
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
      throw error;
    }
    await this.roster.purgeFor(groupCode);
  }

  /**
   * The host's one pending roster, and its id for the buttons. A newer DM replaces it
   * under a fresh id, so the older message's buttons stop working instead of filing
   * the newer text; a redelivery of the same message keeps the id and its buttons.
   * Expiry runs from createdAt, so a replacement renews it along with postedAt.
   */
  private async hold(userId: string, input: HostRosterInput): Promise<string> {
    const now = new Date();
    const current = await this.prisma.linePendingRoster.findUnique({ where: { userId } });
    if (
      current &&
      current.lineMessageId === input.lineMessageId &&
      now.getTime() - current.createdAt.getTime() < PENDING_TTL_MS
    )
      return current.id;
    const id = randomUUID();
    const row = { id, text: input.text, lineMessageId: input.lineMessageId, postedAt: input.postedAt, createdAt: now };
    await this.prisma.linePendingRoster.upsert({ where: { userId }, create: { userId, ...row }, update: row });
    return id;
  }

  /**
   * Claims the pending row and files its text in one transaction. Claiming by id
   * means a tap racing a newer DM (which changed the id) or a second tap finds
   * nothing to claim and is refused.
   */
  private async move(
    pending: { id: string; text: string; lineMessageId: string; postedAt: Date },
    groupCode: string,
    lineUserId: string
  ): Promise<boolean> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.linePendingRoster.deleteMany({ where: { id: pending.id } });
        if (claimed.count !== 1) return false;
        await tx.lineRosterMessage.create({
          data: {
            groupId: groupCode,
            text: pending.text,
            senderUserId: lineUserId,
            senderName: null,
            postedAt: pending.postedAt,
            lineMessageId: pending.lineMessageId,
            botPosted: false,
            direct: true
          }
        });
        return true;
      });
    } catch (error) {
      // The message is already filed (P2002 on lineMessageId): the transaction rolled back, nothing moved.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false;
      throw error;
    }
  }
}
