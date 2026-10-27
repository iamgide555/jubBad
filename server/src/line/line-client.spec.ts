import { vi } from 'vitest';
import { LineClient, groupChoiceMessage } from './line-client.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('LineClient', () => {
  const saved = { ...process.env };
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: LineClient;

  beforeEach(() => {
    process.env.LINE_CHANNEL_SECRET = 's';
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'tok';
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    client = new LineClient();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    process.env = { ...saved };
  });

  it('groupName returns groupName from a 200 body, with the bearer token', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { groupId: 'C1', groupName: 'ก๊วนพฤหัส' }));
    expect(await client.groupName('C1')).toBe('ก๊วนพฤหัส');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.line.me/v2/bot/group/C1/summary');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('groupName returns null on a 404', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { message: 'Not found' }));
    expect(await client.groupName('C1')).toBeNull();
  });

  it('returns null and makes no request when the access token is unset', async () => {
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    expect(await client.groupName('C1')).toBeNull();
    expect(await client.memberName('C1', 'U1')).toBeNull();
    await client.reply('rt', 'hi');
    await client.leave('C1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reply posts the reply token and one text message', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await client.reply('rt-1', 'สวัสดี');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.line.me/v2/bot/message/reply');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ replyToken: 'rt-1', messages: [{ type: 'text', text: 'สวัสดี' }] });
  });

  it('leave posts to the group leave endpoint and never throws on a 404 or a network error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await client.leave('C1');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.line.me/v2/bot/group/C1/leave');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { message: 'Not found' }));
    await expect(client.leave('C1')).resolves.toBeUndefined();
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await expect(client.leave('C1')).resolves.toBeUndefined();
  });

  it('memberName returns the display name and serves the same user from cache', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { displayName: 'Nok', userId: 'U1' }));
    expect(await client.memberName('C1', 'U1')).toBe('Nok');
    expect(await client.memberName('C1', 'U1')).toBe('Nok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.line.me/v2/bot/group/C1/member/U1');
  });

  it('memberName returns null on a 404 and does not cache the failure', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { message: 'Not found' }));
    expect(await client.memberName('C1', 'U9')).toBeNull();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { displayName: 'Mod' }));
    expect(await client.memberName('C1', 'U9')).toBe('Mod');
  });

  it('returns null once the 3 second timeout fires on a request that never resolves', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const pending = client.groupName('C1');
    await vi.advanceTimersByTimeAsync(3100);
    expect(await pending).toBeNull();
  });

  describe('push', () => {
    const message = { type: 'flex', altText: 'x', contents: {} };

    it('posts to the push endpoint with the group id and messages and reads a 200 as ok', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, {}));
      expect(await client.push('Cgroup', [message])).toBe('ok');
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.line.me/v2/bot/message/push');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ to: 'Cgroup', messages: [message] });
    });

    it('reads a 429 monthly limit as quota', async () => {
      fetchMock.mockResolvedValue(jsonResponse(429, { message: 'You have reached your monthly limit.' }));
      expect(await client.push('Cgroup', [message])).toBe('quota');
    });

    it('reads any other 429 as failed', async () => {
      fetchMock.mockResolvedValue(jsonResponse(429, { message: 'Too many requests' }));
      expect(await client.push('Cgroup', [message])).toBe('failed');
    });

    it('reads a 500 and a network error as failed', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(500, { message: 'boom' }));
      expect(await client.push('Cgroup', [message])).toBe('failed');
      fetchMock.mockRejectedValueOnce(new Error('network down'));
      expect(await client.push('Cgroup', [message])).toBe('failed');
    });

    it('sends the retry key header when given one, and none otherwise', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, {}));
      await client.push('Cgroup', [message], '5b7e1c0a-0000-4000-8000-000000000001');
      expect(fetchMock.mock.calls[0][1].headers['X-Line-Retry-Key']).toBe('5b7e1c0a-0000-4000-8000-000000000001');
      await client.push('Cgroup', [message]);
      expect(fetchMock.mock.calls[1][1].headers['X-Line-Retry-Key']).toBeUndefined();
    });

    it('reads a 409 (this retry key was already accepted) as ok', async () => {
      fetchMock.mockResolvedValue(jsonResponse(409, { message: 'The retry key is already accepted' }));
      expect(await client.push('Cgroup', [message], '5b7e1c0a-0000-4000-8000-000000000001')).toBe('ok');
    });

    it('is failed without calling LINE when the access token is unset', async () => {
      delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
      expect(await client.push('Cgroup', [message])).toBe('failed');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('replyMessages and groupChoiceMessage', () => {
    it('replyMessages posts the reply token and the given messages array', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, {}));
      const messages = [{ type: 'text', text: 'a' }, groupChoiceMessage('เลือก', [{ label: 'ก๊วน', data: 'x' }])];
      await client.replyMessages('rt-2', messages);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.line.me/v2/bot/message/reply');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ replyToken: 'rt-2', messages });
    });

    it('replyMessages is a no-op without a token and never throws on a network error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network down'));
      await expect(client.replyMessages('rt-2', [])).resolves.toBeUndefined();
      delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
      fetchMock.mockClear();
      await client.replyMessages('rt-2', []);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('groupChoiceMessage builds a text message with one postback quick reply per choice', () => {
      expect(
        groupChoiceMessage('เลือกก๊วน', [
          { label: 'ก๊วน A', data: 'pick:1' },
          { label: 'ก๊วน B', data: 'pick:2' }
        ])
      ).toEqual({
        type: 'text',
        text: 'เลือกก๊วน',
        quickReply: {
          items: [
            { type: 'action', action: { type: 'postback', label: 'ก๊วน A', data: 'pick:1', displayText: 'ก๊วน A' } },
            { type: 'action', action: { type: 'postback', label: 'ก๊วน B', data: 'pick:2', displayText: 'ก๊วน B' } }
          ]
        }
      });
    });

    it('groupChoiceMessage truncates a 30-character label to 20 and leaves data untouched', () => {
      const label = 'ก'.repeat(30);
      const data = 'd'.repeat(120);
      const msg = groupChoiceMessage('t', [{ label, data }]) as {
        quickReply: { items: { action: { label: string; data: string; displayText: string } }[] };
      };
      const action = msg.quickReply.items[0].action;
      expect(action.label).toBe('ก'.repeat(20));
      expect(action.displayText).toBe('ก'.repeat(20));
      expect(action.data).toBe(data);
    });
  });
});
