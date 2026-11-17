import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { lineConfig } from './line-config.js';

/** The LINE profile a LIFF page reads for the viewer. Only `userId` is required to identify; the rest is for display. */
export interface LiffUser {
  userId: string;
  displayName: string | null;
  pictureUrl: string | null;
}

const VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';
const PROFILE_URL = 'https://api.line.me/v2/profile';
const TIMEOUT_MS = 3000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** LINE did not answer (timeout, network error or a 5xx): says nothing about the token itself. */
class LineUnreachable extends Error {}

const ATTEMPTS = 2;

/**
 * Who a LIFF access token really belongs to, asked of LINE itself. The caller never supplies a user id: it is
 * read from the profile the token unlocks, and only after LINE confirms the token was issued to our own LINE
 * Login channel and has not expired. Needs the `profile` scope on the LIFF app. A token LINE refuses, or a missing
 * config, reads as null. When LINE simply does not answer, the whole check is tried once more; if that fails too it
 * throws a 503 ("try again"), which is not a verdict on the token, so callers must not count it as a failed guess.
 * The token and the profile are never logged.
 */
@Injectable()
export class LiffIdentity {
  async verify(accessToken: string): Promise<LiffUser | null> {
    const channelId = lineConfig().loginChannelId;
    if (channelId === null) return refused('login channel not configured');
    if (typeof accessToken !== 'string' || accessToken === '') return null;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.check(accessToken, channelId);
      } catch (error) {
        if (!(error instanceof LineUnreachable)) return refused(failureOf(error));
        console.warn(`[liff-identity] LINE did not answer (attempt ${attempt} of ${ATTEMPTS}): ${error.message}`);
        if (attempt >= ATTEMPTS) throw new ServiceUnavailableException();
      }
    }
  }

  private async check(accessToken: string, channelId: string): Promise<LiffUser | null> {
    const checked = await this.get(`${VERIFY_URL}?access_token=${encodeURIComponent(accessToken)}`);
    if (!isRecord(checked)) return refused('verify body not an object');
    if (String(checked.client_id) !== channelId) return refused('token issued to another channel');
    if (typeof checked.expires_in !== 'number' || !(checked.expires_in > 0)) return refused('token expired');

    const profile = await this.get(PROFILE_URL, { Authorization: `Bearer ${accessToken}` });
    if (!isRecord(profile) || typeof profile.userId !== 'string' || profile.userId === '') return refused('profile has no userId');
    return {
      userId: profile.userId,
      displayName: typeof profile.displayName === 'string' ? profile.displayName : null,
      pictureUrl: typeof profile.pictureUrl === 'string' ? profile.pictureUrl : null,
    };
  }

  /**
   * The parsed JSON of a 200 answer. No answer at all, or a 5xx, is LineUnreachable; any other status (a 4xx is LINE
   * refusing the token) or a body that is not JSON is an ordinary error that reads as a refusal.
   */
  private async get(url: string, headers?: Record<string, string>): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new LineUnreachable(failureOf(error));
    }
    if (res.status >= 500) throw new LineUnreachable(`LINE answered ${res.status}`);
    if (res.status !== 200) throw new Error(`LINE answered ${res.status}`);
    return res.json();
  }
}

/**
 * Why LINE could not vouch for a token, for the server log: this is the one place a slow or failing LINE call turns into
 * the pay page's uniform 404. Only a fixed reason is ever logged, never the token, the profile or an error's own message.
 */
function refused(reason: string): null {
  console.warn(`[liff-identity] token not accepted: ${reason}`);
  return null;
}

/** An error's name (AbortError, TimeoutError, TypeError for a network failure), or our own "LINE answered <status>". */
function failureOf(error: unknown): string {
  if (error instanceof Error) {
    if (/^LINE answered \d{3}$/.test(error.message)) return error.message;
    if (/^[A-Za-z]{1,40}$/.test(error.name)) return `${error.name} calling LINE`;
  }
  return 'unknown error calling LINE';
}
