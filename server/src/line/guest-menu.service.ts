import { Injectable } from '@nestjs/common';
import { LineClient } from './line-client.js';
import { lineConfig } from './line-config.js';

/**
 * The rich menu a LINE user sees until they have a JubBad account: sign up, or link an account they already
 * have. It is shown per user, never as the bot's default, so a linked host sees no menu. Every call is best
 * effort and does nothing without `LINE_GUEST_RICHMENU_ID`.
 */
@Injectable()
export class GuestMenuService {
  /** Who this process already linked the menu to, so the bot does not call LINE on every DM. It may reset on deploy. */
  private readonly shown = new Set<string>();

  constructor(private readonly client: LineClient) {}

  /** `force` links even if this process remembers doing so: a follow means LINE has no menu for them any more. */
  async show(lineUserId: string, force = false): Promise<void> {
    const { guestRichMenuId } = lineConfig();
    if (guestRichMenuId === null || (!force && this.shown.has(lineUserId))) return;
    try {
      if (await this.client.linkRichMenu(lineUserId, guestRichMenuId)) this.shown.add(lineUserId);
    } catch {
      // A menu failure never blocks a reply or a sign-up.
    }
  }

  async hide(lineUserId: string): Promise<void> {
    if (lineConfig().guestRichMenuId === null) return;
    this.shown.delete(lineUserId);
    try {
      await this.client.unlinkRichMenu(lineUserId);
    } catch {
      // See show().
    }
  }

  /** Only drops the memory, so the next message from this user shows the menu again (their account was unlinked). */
  forget(lineUserId: string): void {
    this.shown.delete(lineUserId);
  }
}
