import { hashPassword, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('round-trips a correct password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('wrong password', stored)).toBe(false);
  });

  it('salts each hash differently, even for the same password', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same password', a)).toBe(true);
    expect(await verifyPassword('same password', b)).toBe(true);
  });

  it('fails closed on a malformed stored hash rather than throwing', async () => {
    await expect(verifyPassword('anything', 'not-a-hash-at-all')).resolves.toBe(false);
    await expect(verifyPassword('anything', 'scrypt$16384$8')).resolves.toBe(false);
    await expect(verifyPassword('anything', 'bcrypt$10$abc$def')).resolves.toBe(false);
    await expect(
      verifyPassword('anything', 'scrypt$not-a-number$8$1$c2FsdA==$aGFzaA==')
    ).resolves.toBe(false);
    await expect(verifyPassword('anything', 'scrypt$16384$8$1$$')).resolves.toBe(false);
    await expect(
      verifyPassword('anything', 'scrypt$16384$8$1$not-valid-base64!!!$also-not==')
    ).resolves.toBe(false);
  });

  it('fails closed on out-of-range cost parameters rather than throwing', async () => {
    // N must be a power of two greater than 1 — node:crypto's scrypt throws on
    // this rather than returning an error, which is exactly the case that
    // must not become a 500 in the login path.
    await expect(
      verifyPassword('anything', 'scrypt$3$8$1$c2FsdA==$aGFzaA==')
    ).resolves.toBe(false);
  });

  it('never verifies against an empty stored hash', async () => {
    expect(await verifyPassword('', '')).toBe(false);
  });
});
