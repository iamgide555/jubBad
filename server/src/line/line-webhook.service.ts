import { Injectable, Logger } from '@nestjs/common';
import { LoginThrottle } from '../auth/login-throttle.js';
import { LineClient } from './line-client.js';
import { LineHostRosterService, type HostReply } from './line-host-roster.service.js';
import { LineHostService } from './line-host.service.js';
import { LineLinkService } from './line-link.service.js';
import { LineRosterService } from './line-roster.service.js';

export interface LineEvent {
  type: string;
  timestamp?: number;
  replyToken?: string;
  source?: { type?: string; groupId?: string; userId?: string };
  message?: { id?: string; type?: string; text?: string };
  unsend?: { messageId?: string };
  postback?: { data?: string };
}

const LINK_COMMAND = /^\/link\s+([A-Za-z0-9]{6})$/i;

/** Spoken into a Thai LINE group, so Thai only. States exactly what the bot keeps. */
const linkedText = (name: string | null) =>
  `เชื่อมกลุ่มนี้กับก๊วน «${name ?? 'ของคุณ'}» ใน JubBad แล้ว บอทจะจำเฉพาะข้อความรายชื่อ พร้อมชื่อคนที่ส่งและเวลา ไม่เก็บแชตอื่น`;
/** One generic line: it never says whether the code was wrong, expired, or the group already linked. */
export const LINK_FAILED_TEXT = 'รหัสไม่ถูกต้องหรือหมดอายุ ตรวจรหัสได้ที่ JubBad > ตั้งค่ากลุ่ม > LINE';
/** Spoken into the host's own chat with the bot. States exactly what the bot keeps. */
const hostLinkedText = (groupName: string | null) =>
  `ผูกบัญชี LINE นี้กับ JubBad${groupName ? ` และเปิดรับรายชื่อของก๊วน «${groupName}»` : ''}แล้ว ` +
  'ส่งรายชื่อก๊วนมาที่แชตนี้ได้เลย บอทจะจำเฉพาะข้อความรายชื่อ ไม่เก็บแชตอื่น';
const FOLLOW_TEXT =
  'ขอบคุณที่เพิ่มเพื่อน ส่งรายชื่อก๊วนมาที่แชตนี้ให้ JubBad ได้ ' +
  'ขอรหัสได้ที่ JubBad > ตั้งค่ากลุ่ม > LINE แล้วส่ง /link ตามด้วยรหัสมาที่แชตนี้';

/**
 * Handles verified LINE webhook events one at a time. Never logs message text
 * or a link code: a failed event is recorded by its type only.
 */
@Injectable()
export class LineWebhookService {
  private readonly logger = new Logger(LineWebhookService.name);
  /** In memory like the login throttle: a counter that resets on deploy is the right trade. */
  private readonly throttle = new LoginThrottle();

  constructor(
    private readonly link: LineLinkService,
    private readonly roster: LineRosterService,
    private readonly client: LineClient,
    private readonly host: LineHostService,
    private readonly hostRoster: LineHostRosterService
  ) {}

  async handleEvent(event: LineEvent): Promise<void> {
    try {
      await this.dispatch(event);
    } catch {
      this.logger.error(`event failed: ${String(event?.type)}`);
    }
  }

  private async dispatch(event: LineEvent): Promise<void> {
    if (event.source?.type === 'user') return this.dispatchDirect(event);
    const groupId = event.source?.type === 'group' ? event.source.groupId : undefined;
    if (!groupId) return;
    const postedAt = new Date(typeof event.timestamp === 'number' ? event.timestamp : Date.now());
    const senderUserId = event.source?.userId ?? null;

    switch (event.type) {
      case 'message': {
        if (event.message?.type !== 'text' || !event.message.id || typeof event.message.text !== 'string') return;
        const command = LINK_COMMAND.exec(event.message.text.trim());
        if (command) {
          await this.onLink(groupId, senderUserId, command[1], event.replyToken);
          return;
        }
        await this.roster.capture({
          lineGroupId: groupId, lineMessageId: event.message.id, text: event.message.text, senderUserId, postedAt,
        });
        return;
      }
      case 'messageEdited': {
        if (event.message?.type !== 'text' || !event.message.id || typeof event.message.text !== 'string') return;
        await this.roster.edit({
          lineGroupId: groupId, lineMessageId: event.message.id, text: event.message.text, senderUserId, postedAt,
        });
        return;
      }
      case 'unsend':
        if (event.unsend?.messageId) await this.roster.unsend(event.unsend.messageId);
        return;
      case 'leave':
        await this.link.markLeft(groupId);
        return;
      default:
        return;
    }
  }

  private async onLink(groupId: string, senderUserId: string | null, code: string, replyToken?: string): Promise<void> {
    // Per LINE group and sender, so one member's bad guesses cannot lock the host out.
    const key = `line:${groupId}:${senderUserId ?? 'anon'}`;
    if (!this.throttle.check(key)) return;
    const linked = await this.link.redeem(groupId, code);
    if (linked) this.throttle.recordSuccess(key);
    else this.throttle.recordFailure(key);
    if (replyToken) await this.client.reply(replyToken, linked ? linkedText(linked.groupName) : LINK_FAILED_TEXT);
  }

  /**
   * A host's one-to-one chat with the bot. Edits and unsends are ignored: sending a
   * roster here is a deliberate act, unlike chat in a group.
   */
  private async dispatchDirect(event: LineEvent): Promise<void> {
    const lineUserId = event.source?.userId;
    if (!lineUserId) return;

    switch (event.type) {
      case 'message': {
        if (event.message?.type !== 'text' || !event.message.id || typeof event.message.text !== 'string') return;
        const command = LINK_COMMAND.exec(event.message.text.trim());
        if (command) {
          await this.onHostLink(lineUserId, command[1], event.replyToken);
          return;
        }
        const postedAt = new Date(typeof event.timestamp === 'number' ? event.timestamp : Date.now());
        const reply = await this.hostRoster.receive({
          lineUserId, lineMessageId: event.message.id, text: event.message.text, postedAt,
        });
        await this.send(event.replyToken, reply);
        return;
      }
      case 'postback': {
        if (typeof event.postback?.data !== 'string') return;
        await this.send(event.replyToken, await this.hostRoster.choose({ lineUserId, data: event.postback.data }));
        return;
      }
      case 'follow':
        if (event.replyToken) await this.client.reply(event.replyToken, FOLLOW_TEXT);
        return;
      case 'unfollow':
        // A blocked bot cannot show buttons, so a held roster can never be chosen. The link stays.
        await this.host.dropPending(lineUserId);
        return;
      default:
        return;
    }
  }

  private async onHostLink(lineUserId: string, code: string, replyToken?: string): Promise<void> {
    // Its own key per LINE user, apart from any group's, with the same limit.
    const key = `line:user:${lineUserId}`;
    if (!this.throttle.check(key)) return;
    const linked = await this.host.redeem(lineUserId, code);
    if (linked) this.throttle.recordSuccess(key);
    else this.throttle.recordFailure(key);
    if (replyToken) await this.client.reply(replyToken, linked ? hostLinkedText(linked.groupName) : LINK_FAILED_TEXT);
  }

  private async send(replyToken: string | undefined, reply: HostReply): Promise<void> {
    if (!replyToken) return;
    if (reply.kind === 'text') await this.client.reply(replyToken, reply.text);
    else await this.client.replyMessages(replyToken, reply.messages);
  }
}
