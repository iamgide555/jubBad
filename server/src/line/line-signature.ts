import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * LINE signs the raw request body with the channel secret (HMAC-SHA256, base64)
 * and sends it in `x-line-signature`. Must be checked against the exact bytes
 * received, never a re-serialized body.
 */
export function verifyLineSignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(signature, 'base64');
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}
