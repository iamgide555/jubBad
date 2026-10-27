import { createHash, randomInt } from 'node:crypto';

/** No 0/O/1/I: a code is read off a phone and typed into a chat. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
export const CODE_TTL_MS = 10 * 60 * 1000;
/** How long a host's DMed roster waits for them to pick a group. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** `/link ab12cd ` -> `AB12CD`; null when it is not shaped like a code. */
export function normalizeCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return /^[A-Z0-9]{6}$/.test(code) ? code : null;
}

export function newCode(): string {
  return Array.from(
    { length: CODE_LENGTH },
    () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)],
  ).join('');
}
