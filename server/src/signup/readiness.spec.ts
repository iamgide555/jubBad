import { signupReadiness } from './readiness.js';

describe('signupReadiness', () => {
  const saved = { ...process.env };
  const KEYS = ['LINE_LIFF_ID', 'LINE_LOGIN_CHANNEL_ID', 'LINE_BOT_ADD_URL', 'PUBLIC_APP_URL', 'LINE_GUEST_RICHMENU_ID', 'UPGRADE_CONTACT_URL'];
  beforeEach(() => {
    for (const key of KEYS) delete process.env[key];
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('names every setting that is missing and what stops working without it', () => {
    const { missing } = signupReadiness();
    expect(missing.map((m) => m.name).sort()).toEqual([...KEYS].sort());
    for (const m of missing) expect(m.effect.length).toBeGreaterThan(10);
  });

  it('is complete when everything is set to a usable value', () => {
    process.env.LINE_LIFF_ID = 'L1';
    process.env.LINE_LOGIN_CHANNEL_ID = '999';
    process.env.LINE_BOT_ADD_URL = 'https://lin.ee/x';
    process.env.PUBLIC_APP_URL = 'https://jubbad.example';
    process.env.LINE_GUEST_RICHMENU_ID = 'richmenu-1';
    process.env.UPGRADE_CONTACT_URL = 'https://line.me/ti/p/abc';
    expect(signupReadiness().missing).toEqual([]);
  });

  it('treats an add-friend or contact link that is not https as missing', () => {
    process.env.LINE_BOT_ADD_URL = 'http://lin.ee/x';
    process.env.UPGRADE_CONTACT_URL = 'javascript:alert(1)';
    const names = signupReadiness().missing.map((m) => m.name);
    expect(names).toContain('LINE_BOT_ADD_URL');
    expect(names).toContain('UPGRADE_CONTACT_URL');
  });
});
