import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { bootSlipApp } from '../../../test/slip-http.fixture.js';

type Kit = Awaited<ReturnType<typeof bootSlipApp>>;

const LIFF_ID = '1234567890-AbCdEfGh';

describe('GET /sessions/:code/slip-pay/config (public, token-gated, no LINE identity)', () => {
  let kit: Kit;
  let hostId: string;
  let savedLiffId: string | undefined;

  beforeAll(async () => {
    kit = await bootSlipApp();
    hostId = (await kit.owner()).id;
  });
  afterAll(() => kit.cleanup());

  beforeEach(() => {
    savedLiffId = process.env.LINE_LIFF_ID;
    process.env.LINE_LIFF_ID = LIFF_ID;
    kit.liff.verify.mockReset().mockResolvedValue(null);
    kit.resetThrottles();
  });
  afterEach(() => {
    if (savedLiffId === undefined) delete process.env.LINE_LIFF_ID;
    else process.env.LINE_LIFF_ID = savedLiffId;
  });

  const q = (token: string) => `?token=${encodeURIComponent(token)}`;
  const config = (code: string, query: string) => request(kit.server).get(`/sessions/${code}/slip-pay/config${query}`);

  /** The body every other slip-pay route answers a gated-out caller with. */
  async function uniform404() {
    const { code } = await kit.setup(hostId);
    const res = await request(kit.server).get(`/sessions/${code}/slip-pay`).set('X-Line-Access-Token', 'nope');
    expect(res.status).toBe(404);
    return res.body;
  }

  it('returns the LIFF id for a confirmed card with the right token, with no LINE header', async () => {
    const { code, token } = await kit.setup(hostId);
    const res = await config(code, q(token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ liffId: LIFF_ID });
    expect(Object.keys(res.body)).toEqual(['liffId']);
    expect(res.text).not.toContain(token);
    expect(kit.liff.verify).not.toHaveBeenCalled();
  });

  describe('every gated-out request is the same bare 404', () => {
    it('wrong token, missing token, repeated token, unknown session', async () => {
      const body = await uniform404();
      const { code, token } = await kit.setup(hostId);
      const flipped = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
      const cases: [string, request.Test][] = [
        ['wrong token', config(code, q(flipped))],
        ['longer token', config(code, q(`${token}x`))],
        ['empty token', config(code, '?token=')],
        ['missing token', config(code, '')],
        ['repeated token', config(code, `?token=${token}&token=${token}`)],
        ['unknown session', config('no-such-session', q(token))],
      ];
      for (const [label, pending] of cases) {
        const res = await pending;
        expect({ label, status: res.status, body: res.body }).toEqual({ label, status: 404, body });
      }
    });

    it('plan lapsed', async () => {
      const body = await uniform404();
      const lapsed = await kit.owner('host', new Date(Date.now() - 86_400_000));
      const { code, token } = await kit.setup(lapsed.id);
      const res = await config(code, q(token));
      expect({ status: res.status, body: res.body }).toEqual({ status: 404, body });
    });

    it('card unconfirmed', async () => {
      const body = await uniform404();
      const { code, token } = await kit.setup(hostId);
      await kit.prisma.session.update({ where: { code }, data: { paymentCard: null } });
      const res = await config(code, q(token));
      expect({ status: res.status, body: res.body }).toEqual({ status: 404, body });
    });

    it('LINE_LIFF_ID unset', async () => {
      const body = await uniform404();
      const { code, token } = await kit.setup(hostId);
      delete process.env.LINE_LIFF_ID;
      const res = await config(code, q(token));
      expect({ status: res.status, body: res.body }).toEqual({ status: 404, body });
    });

    it('the old token dies on a reconfirm', async () => {
      const body = await uniform404();
      const { code, token } = await kit.setup(hostId);
      expect((await config(code, q(token))).status).toBe(200);
      const fresh = randomUUID().replace(/-/g, '').slice(0, 22);
      await kit.confirm(code, fresh);
      const old = await config(code, q(token));
      expect({ status: old.status, body: old.body }).toEqual({ status: 404, body });
      expect((await config(code, q(fresh))).body).toEqual({ liffId: LIFF_ID });
    });
  });

  describe('throttle', () => {
    it('answers 429 on the eleventh failing request from one address, with no detail, even for a good token', async () => {
      const { code, token } = await kit.setup(hostId);
      for (let i = 0; i < 10; i += 1) expect((await config(code, '?token=wrong')).status).toBe(404);
      const blocked = await config(code, '?token=wrong');
      expect(blocked.status).toBe(429);
      expect(blocked.body).toEqual({ statusCode: 429, message: '' });
      expect((await config(code, q(token))).status).toBe(429);
    });

    it('successes are not counted against the address', async () => {
      const { code, token } = await kit.setup(hostId);
      for (let i = 0; i < 15; i += 1) expect((await config(code, q(token))).status).toBe(200);
    });
  });
});
