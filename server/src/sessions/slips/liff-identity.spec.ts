import { LiffIdentity } from './liff-identity.js';

const VERIFY = 'https://api.line.me/oauth2/v2.1/verify';
const PROFILE = 'https://api.line.me/v2/profile';
const TOKEN = 'tok/en+secret=1';

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('LiffIdentity', () => {
  const savedChannel = process.env.LINE_LOGIN_CHANNEL_ID;
  let fetchMock: ReturnType<typeof vi.fn>;
  const identity = new LiffIdentity();

  beforeEach(() => {
    process.env.LINE_LOGIN_CHANNEL_ID = '1234567890';
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedChannel === undefined) delete process.env.LINE_LOGIN_CHANNEL_ID;
    else process.env.LINE_LOGIN_CHANNEL_ID = savedChannel;
  });

  /** verify answers first, profile second. */
  function lineSays(verify: Response, profile?: Response) {
    fetchMock.mockResolvedValueOnce(verify);
    if (profile) fetchMock.mockResolvedValueOnce(profile);
  }
  const goodVerify = () => reply(200, { scope: 'profile', client_id: '1234567890', expires_in: 2591659 });
  const goodProfile = () => reply(200, { userId: 'U1', displayName: 'Nok', pictureUrl: 'https://p/1.png' });

  it('returns the full user for a valid token, calling exactly the two LINE endpoints', async () => {
    lineSays(goodVerify(), goodProfile());
    await expect(identity.verify(TOKEN)).resolves.toEqual({
      userId: 'U1',
      displayName: 'Nok',
      pictureUrl: 'https://p/1.png',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [verifyUrl, verifyInit] = fetchMock.mock.calls[0];
    expect(verifyUrl).toBe(`${VERIFY}?access_token=${encodeURIComponent(TOKEN)}`);
    expect(verifyInit.headers?.Authorization).toBeUndefined();
    const [profileUrl, profileInit] = fetchMock.mock.calls[1];
    expect(profileUrl).toBe(PROFILE);
    expect(profileInit.headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it('gives null for a token issued to another channel and never asks for the profile', async () => {
    lineSays(reply(200, { client_id: '999', expires_in: 100 }));
    await expect(identity.verify(TOKEN)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('compares client_id as a string, so a numeric client_id for our channel passes', async () => {
    lineSays(reply(200, { client_id: 1234567890, expires_in: 100 }), goodProfile());
    await expect(identity.verify(TOKEN)).resolves.toMatchObject({ userId: 'U1' });
  });

  it('gives null for an expired token', async () => {
    lineSays(reply(200, { client_id: '1234567890', expires_in: 0 }));
    await expect(identity.verify(TOKEN)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives null when expires_in is not a number', async () => {
    lineSays(reply(200, { client_id: '1234567890', expires_in: '100' }));
    await expect(identity.verify(TOKEN)).resolves.toBeNull();
  });

  it('gives null when the verify call answers 400', async () => {
    lineSays(reply(400, { error: 'invalid_request', error_description: 'access token expired' }));
    await expect(identity.verify(TOKEN)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives null when the profile call answers 401', async () => {
    lineSays(goodVerify(), reply(401, { message: 'Unauthorized' }));
    await expect(identity.verify(TOKEN)).resolves.toBeNull();
  });

  it('gives null when the verify body is not JSON', async () => {
    lineSays(new Response('<html>', { status: 200 }));
    await expect(identity.verify(TOKEN)).resolves.toBeNull();
  });

  it('gives null on a network error, without throwing', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(identity.verify(TOKEN)).resolves.toBeNull();
  });

  it('bounds every call with an abort signal, and an AbortError reads as null', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted', 'TimeoutError'));
    await expect(identity.verify(TOKEN)).resolves.toBeNull();
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);

    fetchMock.mockReset();
    lineSays(goodVerify());
    fetchMock.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    await expect(identity.verify(TOKEN)).resolves.toBeNull();
    expect(fetchMock.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('gives null with no fetch when LINE_LOGIN_CHANNEL_ID is unset or blank', async () => {
    delete process.env.LINE_LOGIN_CHANNEL_ID;
    await expect(identity.verify(TOKEN)).resolves.toBeNull();
    process.env.LINE_LOGIN_CHANNEL_ID = '  ';
    await expect(identity.verify(TOKEN)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gives null with no fetch for an empty or non-string token', async () => {
    await expect(identity.verify('')).resolves.toBeNull();
    await expect(identity.verify(undefined as unknown as string)).resolves.toBeNull();
    await expect(identity.verify(42 as unknown as string)).resolves.toBeNull();
    await expect(identity.verify({ toString: () => 'x' } as unknown as string)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns a missing or non-string displayName and pictureUrl into null', async () => {
    lineSays(goodVerify(), reply(200, { userId: 'U2', displayName: 7 }));
    await expect(identity.verify(TOKEN)).resolves.toEqual({ userId: 'U2', displayName: null, pictureUrl: null });
  });

  it('gives null when the profile userId is empty or missing', async () => {
    lineSays(goodVerify(), reply(200, { userId: '', displayName: 'Nok' }));
    await expect(identity.verify(TOKEN)).resolves.toBeNull();
    lineSays(goodVerify(), reply(200, { displayName: 'Nok' }));
    await expect(identity.verify(TOKEN)).resolves.toBeNull();
  });

  it('never lets the token escape in a returned value or a console message', async () => {
    const spies = (['log', 'warn', 'error', 'debug', 'info'] as const).map((m) => vi.spyOn(console, m));
    fetchMock.mockRejectedValue(new Error(`boom ${TOKEN}`));
    const result = await identity.verify(TOKEN);
    expect(result).toBeNull();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
    vi.restoreAllMocks();
  });
});
