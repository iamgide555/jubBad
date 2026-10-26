import { Injectable, Logger } from '@nestjs/common';
import { LoginThrottle } from '../auth/login-throttle.js';
import { LineClient } from './line-client.js';
import { LineLinkService } from './line-link.service.js';
import { LineRosterService } from './line-roster.service.js';

export interface LineEvent {
  type: string;
  timestamp?: number;
  replyToken?: string;
  source?: { type?: string; groupId?: string; userId?: string };
  message?: { id?: string; type?: string; text?: string };
  unsend?: { messageId?: string };
}

const LINK_COMMAND = /^\/link\s+([A-Za-z0-9]{6})$/i;

/** Spoken into a Thai LINE group, so Thai only. States exactly what the bot keeps. */
const linkedText = (name: string | null) =>
  `เชื่อมกลุ่มนี้กับก๊วน «${name ?? 'ของคุณ'}» ใน JubBad แล้ว บอทจะจำเฉพาะข้อความรายชื่อ พร้อมชื่อคนที่ส่งและเวลา ไม่เก็บแชตอื่น`;
/** One generic line: it never says whether the code was wrong, expired, or the group already linked. */
export const LINK_FAILED_TEXT = 'รหัสไม่ถูกต้องหรือหมดอายุ ตรวจรหัสได้ที่ JubBad > ตั้งค่ากลุ่ม > กลุ่ม LINE';

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
    private readonly client: LineClient
  ) {}

  async handleEvent(event: LineEvent): Promise<void> {
    try {
      await this.dispatch(event);
    } catch {
      this.logger.error(`event failed: ${String(event?.type)}`);
    }
  }

  private async dispatch(event: LineEvent): Promise<void> {
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
}
