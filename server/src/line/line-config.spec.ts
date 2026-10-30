import { lineConfig } from './line-config.js';

describe('lineConfig', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('reads the environment at call time and nulls what is unset', () => {
    delete process.env.LINE_CHANNEL_SECRET;
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    delete process.env.LINE_BOT_ADD_URL;
    delete process.env.PUBLIC_APP_URL;
    delete process.env.LINE_LIFF_ID;
    delete process.env.LINE_LOGIN_CHANNEL_ID;
    expect(lineConfig()).toEqual({
      secret: null,
      token: null,
      botAddUrl: null,
      publicAppUrl: null,
      liffId: null,
      loginChannelId: null,
    });
    process.env.LINE_CHANNEL_SECRET = 's';
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 't';
    expect(lineConfig()).toMatchObject({ secret: 's', token: 't' });
  });

  it('keeps an https add-friend link and drops anything else', () => {
    process.env.LINE_BOT_ADD_URL = 'https://lin.ee/abc';
    expect(lineConfig().botAddUrl).toBe('https://lin.ee/abc');
    process.env.LINE_BOT_ADD_URL = 'http://lin.ee/abc';
    expect(lineConfig().botAddUrl).toBeNull();
    process.env.LINE_BOT_ADD_URL = 'javascript:alert(1)';
    expect(lineConfig().botAddUrl).toBeNull();
    process.env.LINE_BOT_ADD_URL = '   ';
    expect(lineConfig().botAddUrl).toBeNull();
  });

  it('keeps an https public app url without a trailing slash and drops anything else', () => {
    process.env.PUBLIC_APP_URL = 'https://jubbad.wongnok.dev/';
    expect(lineConfig().publicAppUrl).toBe('https://jubbad.wongnok.dev');
    process.env.PUBLIC_APP_URL = 'https://jubbad.wongnok.dev';
    expect(lineConfig().publicAppUrl).toBe('https://jubbad.wongnok.dev');
    process.env.PUBLIC_APP_URL = 'http://jubbad.wongnok.dev';
    expect(lineConfig().publicAppUrl).toBeNull();
    process.env.PUBLIC_APP_URL = '';
    expect(lineConfig().publicAppUrl).toBeNull();
    delete process.env.PUBLIC_APP_URL;
    expect(lineConfig().publicAppUrl).toBeNull();
  });

  it('reads the LIFF id trimmed, and nulls it when unset or blank', () => {
    delete process.env.LINE_LIFF_ID;
    expect(lineConfig().liffId).toBeNull();
    process.env.LINE_LIFF_ID = '   ';
    expect(lineConfig().liffId).toBeNull();
    process.env.LINE_LIFF_ID = '  1234567890-AbCdEfGh ';
    expect(lineConfig().liffId).toBe('1234567890-AbCdEfGh');
  });

  it('reads the LINE Login channel id trimmed, and nulls it when unset or blank', () => {
    delete process.env.LINE_LOGIN_CHANNEL_ID;
    expect(lineConfig().loginChannelId).toBeNull();
    process.env.LINE_LOGIN_CHANNEL_ID = '   ';
    expect(lineConfig().loginChannelId).toBeNull();
    process.env.LINE_LOGIN_CHANNEL_ID = ' 1234567890 ';
    expect(lineConfig().loginChannelId).toBe('1234567890');
  });
});
