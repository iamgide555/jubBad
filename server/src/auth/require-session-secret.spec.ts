import { requireSessionSecret } from './auth.module.js';

describe('requireSessionSecret', () => {
  const original = process.env.SESSION_SECRET;

  afterEach(() => {
    if (original === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = original;
  });

  it('returns the configured secret', () => {
    process.env.SESSION_SECRET = 'a-real-secret';
    expect(requireSessionSecret()).toBe('a-real-secret');
  });

  it('trims surrounding whitespace, which a copied .env line often carries', () => {
    process.env.SESSION_SECRET = '  a-real-secret  ';
    expect(requireSessionSecret()).toBe('a-real-secret');
  });

  // Refusing to boot is the whole point. If an unset secret were allowed to
  // mean "sign cookies with nothing" or "verify none of them", the failure
  // would be invisible in production: the app starts, every page works until
  // a session is silently rejected, and nothing indicates why. A container
  // that will not start gets noticed.
  it('throws when the secret is unset', () => {
    delete process.env.SESSION_SECRET;
    expect(() => requireSessionSecret()).toThrow(/SESSION_SECRET is not set/);
  });

  it('throws when the secret is empty', () => {
    process.env.SESSION_SECRET = '';
    expect(() => requireSessionSecret()).toThrow(/SESSION_SECRET is not set/);
  });

  it('throws when the secret is only whitespace', () => {
    process.env.SESSION_SECRET = '   ';
    expect(() => requireSessionSecret()).toThrow(/SESSION_SECRET is not set/);
  });
});
