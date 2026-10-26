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
    expect(lineConfig()).toEqual({ secret: null, token: null, botAddUrl: null });
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
});
