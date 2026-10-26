import { Injectable } from '@nestjs/common';
import { lineConfig } from './line-config.js';

const API = 'https://api.line.me/v2/bot';
const TIMEOUT_MS = 3000;
const NAME_TTL_MS = 24 * 60 * 60 * 1000;

/** How a push ended: sent, refused because this month's message quota is used up, or anything else. */
export type LinePushOutcome = 'ok' | 'quota' | 'failed';

/**
 * Thin LINE Messaging API client over global fetch. Every call has a short
 * timeout and none of them throw: a LINE outage or a missing token must never
 * break the webhook, linking or start. Failures read as null / no-op.
 */
@Injectable()
export class LineClient {
  private readonly names = new Map<string, { name: string; expiresAt: number }>();

  async reply(replyToken: string, text: string): Promise<void> {
    await this.call('POST', '/message/reply', { replyToken, messages: [{ type: 'text', text }] });
  }

  /** Counts against the monthly quota once per group member; never throws. */
  async push(lineGroupId: string, messages: unknown[]): Promise<LinePushOutcome> {
    const result = await this.send('POST', '/message/push', { to: lineGroupId, messages });
    if (result === null) return 'failed';
    if (result.status >= 200 && result.status < 300) return 'ok';
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
    payload?: unknown
  ): Promise<{ status: number; body: Record<string, unknown> | null } | null> {
    const { token } = lineConfig();
    if (!token) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
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
