import { Injectable } from '@nestjs/common';
import { lineConfig } from './line-config.js';

const API = 'https://api.line.me/v2/bot';
const TIMEOUT_MS = 3000;
const NAME_TTL_MS = 24 * 60 * 60 * 1000;

/** How a push ended: sent, refused because this month's message quota is used up, or anything else. */
export type LinePushOutcome = 'ok' | 'quota' | 'failed';

const QUICK_REPLY_LABEL_MAX = 20;

/** At most `max` UTF-16 units, cut between code points so an emoji is never left as half a surrogate pair. */
function clip(label: string, max: number): string {
  let shown = '';
  for (const point of label) {
    if (shown.length + point.length > max) break;
    shown += point;
  }
  return shown;
}

/**
 * One text message with a Quick Reply postback button per choice. LINE rejects a label over 20 characters
 * (counted in UTF-16 units, so an emoji is two), so it is cut; `data` is passed through as is (the caller
 * keeps it within LINE's 300 characters).
 */
export function groupChoiceMessage(text: string, choices: { label: string; data: string }[]): unknown {
  return {
    type: 'text',
    text,
    quickReply: {
      items: choices.map(({ label, data }) => {
        const shown = clip(label, QUICK_REPLY_LABEL_MAX);
        // No displayText: LINE might echo it as a message event, and the bot's own reply already names the group.
        return { type: 'action', action: { type: 'postback', label: shown, data } };
      })
    }
  };
}

/**
 * Thin LINE Messaging API client over global fetch. Every call has a short
 * timeout and none of them throw: a LINE outage or a missing token must never
 * break the webhook, linking or start. Failures read as null / no-op.
 */
@Injectable()
export class LineClient {
  private readonly names = new Map<string, { name: string; expiresAt: number }>();

  async reply(replyToken: string, text: string): Promise<void> {
    await this.replyMessages(replyToken, [{ type: 'text', text }]);
  }

  /** Replies are free (a push spends quota); `messages` may carry Quick Reply buttons, see groupChoiceMessage. */
  async replyMessages(replyToken: string, messages: unknown[]): Promise<void> {
    await this.call('POST', '/message/reply', { replyToken, messages });
  }

  /**
   * Counts against the monthly quota once per group member; never throws. `retryKey` (a UUID) makes LINE
   * drop a repeat of the same push, so a timeout we could not read the answer to is safe to retry.
   */
  async push(lineGroupId: string, messages: unknown[], retryKey?: string): Promise<LinePushOutcome> {
    const result = await this.send(
      'POST',
      '/message/push',
      { to: lineGroupId, messages },
      retryKey ? { 'X-Line-Retry-Key': retryKey } : undefined
    );
    if (result === null) return 'failed';
    if (result.status >= 200 && result.status < 300) return 'ok';
    // LINE already accepted a push with this retry key: our earlier attempt got through, the answer was lost.
    if (result.status === 409) return 'ok';
    const reason = typeof result.body?.message === 'string' ? result.body.message : '';
    return result.status === 429 && /monthly limit/i.test(reason) ? 'quota' : 'failed';
  }

  async groupName(lineGroupId: string): Promise<string | null> {
    const body = await this.call('GET', `/group/${encodeURIComponent(lineGroupId)}/summary`);
    return typeof body?.groupName === 'string' ? body.groupName : null;
  }

  /** Cached per group and user for 24 hours; a failed lookup is not cached. */
  async memberName(lineGroupId: string, userId: string): Promise<string | null> {
    const key = `${lineGroupId}:${userId}`;
    const hit = this.names.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.name;
    const body = await this.call(
      'GET',
      `/group/${encodeURIComponent(lineGroupId)}/member/${encodeURIComponent(userId)}`
    );
    if (typeof body?.displayName !== 'string') return null;
    this.names.set(key, { name: body.displayName, expiresAt: Date.now() + NAME_TTL_MS });
    return body.displayName;
  }

  async leave(lineGroupId: string): Promise<void> {
    await this.call('POST', `/group/${encodeURIComponent(lineGroupId)}/leave`);
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown
  ): Promise<Record<string, unknown> | null> {
    const result = await this.send(method, path, payload);
    return result !== null && result.status >= 200 && result.status < 300 ? result.body : null;
  }

  /** The status and JSON body of the response, or null when there was no response at all. */
  private async send(
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<{ status: number; body: Record<string, unknown> | null } | null> {
    const { token } = lineConfig();
    if (!token) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...extraHeaders };
      const init: RequestInit = { method, headers, signal: controller.signal };
      if (payload !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(payload);
      }
      const response = await fetch(`${API}${path}`, init);
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown> | null;
      return { status: response.status, body };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
