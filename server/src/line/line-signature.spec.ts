import { createHmac } from 'node:crypto';
import { verifyLineSignature } from './line-signature.js';

function sign(body: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64');
}

describe('verifyLineSignature', () => {
  const body = Buffer.from(JSON.stringify({ events: [] }));

  it('accepts a body signed with the channel secret', () => {
    expect(verifyLineSignature(body, sign(body, 's'), 's')).toBe(true);
  });

  it('rejects a body changed by one byte', () => {
    const signature = sign(body, 's');
    const tampered = Buffer.from(body);
    tampered[3] ^= 1;
    expect(verifyLineSignature(tampered, signature, 's')).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifyLineSignature(body, sign(body, 'other'), 's')).toBe(false);
  });

  it('rejects an undefined header', () => {
    expect(verifyLineSignature(body, undefined, 's')).toBe(false);
  });

  it('rejects a wrong-length header without throwing', () => {
    expect(() => verifyLineSignature(body, 'abc', 's')).not.toThrow();
    expect(verifyLineSignature(body, 'abc', 's')).toBe(false);
  });
});
