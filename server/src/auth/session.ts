export const SESSION_COOKIE = 'jubbad_session';

/**
 * The cookie's payload is `userId:tokenVersion`, signed by cookie-parser
 * (see main.ts / requireSessionSecret). tokenVersion is what makes
 * revocation per-user rather than all-or-nothing: bumping it on disable,
 * password change, or password reset invalidates every cookie issued before
 * that, without touching anyone else's.
 */
export interface ParsedSession {
  userId: string;
  tokenVersion: number;
}

export function packSession(userId: string, tokenVersion: number): string {
  return `${userId}:${tokenVersion}`;
}

/**
 * `value` is whatever cookie-parser's req.signedCookies put there: the
 * verified payload on a valid signature, `false` on an invalid one, or
 * `undefined` when the cookie is absent. Only a verified string payload of
 * the expected shape parses to anything.
 */
export function parseSession(value: string | false | undefined): ParsedSession | null {
  if (typeof value !== 'string') return null;

  const separator = value.lastIndexOf(':');
  if (separator <= 0) return null;

  const userId = value.slice(0, separator);
  const tokenVersion = Number(value.slice(separator + 1));
  if (!Number.isInteger(tokenVersion)) return null;

  return { userId, tokenVersion };
}
