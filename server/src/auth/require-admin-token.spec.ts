import { requireAdminToken } from './auth.module.js';

describe('requireAdminToken', () => {
  const original = process.env.ADMIN_TOKEN;

  afterEach(() => {
    if (original === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = original;
  });

  it('returns the configured token', () => {
    process.env.ADMIN_TOKEN = 'a-real-secret';
    expect(requireAdminToken()).toBe('a-real-secret');
  });

  it('trims surrounding whitespace, which a copied .env line often carries', () => {
    process.env.ADMIN_TOKEN = '  a-real-secret  ';
    expect(requireAdminToken()).toBe('a-real-secret');
  });

  // Refusing to boot is the whole point. If an unset secret were allowed to
  // mean "no token configured, so let everyone through", the failure would be
  // invisible in production: the app starts, every page works, and the door is
  // open. A container that will not start gets noticed.
  it('throws when the token is unset', () => {
    delete process.env.ADMIN_TOKEN;
    expect(() => requireAdminToken()).toThrow(/ADMIN_TOKEN is not set/);
  });

  it('throws when the token is empty', () => {
    process.env.ADMIN_TOKEN = '';
    expect(() => requireAdminToken()).toThrow(/ADMIN_TOKEN is not set/);
  });

  it('throws when the token is only whitespace', () => {
    process.env.ADMIN_TOKEN = '   ';
    expect(() => requireAdminToken()).toThrow(/ADMIN_TOKEN is not set/);
  });
});
