import { Injectable } from '@nestjs/common';
import { lineConfig } from './line-config.js';

const API = 'https://api.line.me/v2/bot';
const TIMEOUT_MS = 3000;
const NAME_TTL_MS = 24 * 60 * 60 * 1000;

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
      if (!response.ok) return null;
      return (await response.json().catch(() => ({}))) as Record<string, unknown>;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
