import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { LoginThrottle } from '../../auth/login-throttle.js';
import {
  bootSlipApp,
  lineUser,
  newRef,
  slipRead,
} from '../../../test/slip-http.fixture.js';
import { SlipPayController } from './slip-pay.controller.js';
import { SlipPaymentsService, type LiffUser } from './slip-payments.service.js';

type Kit = Awaited<ReturnType<typeof bootSlipApp>>;

const IMAGE = Buffer.from('fake image bytes');
const HEADER = 'X-Line-Access-Token';

describe('slip pay-page routes (public, token-gated)', () => {
  let kit: Kit;
  let hostId: string;
  const users = new Map<string, LiffUser>();

  beforeAll(async () => {
    kit = await bootSlipApp();
    hostId = (await kit.owner()).id;
  });
  afterAll(() => kit.cleanup());

  beforeEach(() => {
    users.clear();
    kit.liff.verify.mockReset().mockImplementation(async (t) => users.get(t) ?? null);
    kit.reader.read.mockReset();
    // A fresh counter per test: the address key is shared by every request from this process.
    Reflect.set(kit.app.get(SlipPayController), 'throttle', new LoginThrottle());
  });

  /** A viewer LINE account whose access token verifies, as `[token, user]`. */
  function viewer(name = 'Somchai'): [string, LiffUser] {
    const user = lineUser(name);
    const token = `tok-${randomUUID()}`;
    users.set(token, user);
    return [token, user];
  }

  const pay = (code: string) => `/sessions/${code}/slip-pay`;
  const get = (code: string, query: string, access?: string) => {
    const r = request(kit.server).get(`${pay(code)}${query}`);
    return access === undefined ? r : r.set(HEADER, access);
  };
  const claim = (code: string, query: string, access: string | undefined, playerId: unknown) => {
    const r = request(kit.server).post(`${pay(code)}/claim${query}`);
    return (access === undefined ? r : r.set(HEADER, access)).send({ playerId });
  };
  const upload = (code: string, query: string, access: string | undefined, body: Buffer | string = IMAGE, type = 'image/png') => {
    const r = request(kit.server).post(`${pay(code)}/upload${query}`).set('Content-Type', type);
    return (access === undefined ? r : r.set(HEADER, access)).send(body);
  };
  const q = (token: string) => `?token=${encodeURIComponent(token)}`;
  const setupSession = async () => kit.setup(hostId);
  const writtenFor = async (groupCode: string, code: string) =>
    (await kit.prisma.slipReference.count({ where: { groupId: groupCode } })) +
    (await kit.prisma.sessionPayment.count({ where: { sessionId: code } })) +
    (await kit.prisma.pendingSlip.count({ where: { sessionId: code } }));

  describe('every failure is the same bare 404', () => {
    type Call = (code: string, query: string, access: string | undefined) => request.Test;
    const routes: [string, Call][] = [
      ['GET slip-pay', (c, qs, a) => get(c, qs, a)],
      ['POST claim', (c, qs, a) => claim(c, qs, a, 'p')],
      ['POST upload', (c, qs, a) => upload(c, qs, a)],
    ];

    for (const [name, call] of routes) {
      it(`${name}: no header, unverifiable header, bad pay token, no pay token, repeated token, unknown session`, async () => {
        const { code, token, ids } = await setupSession();
        const [access] = viewer();
        // A claim body that is well formed, so only the gates differ.
        const send: Call =
          name === 'POST claim' ? (c, qs, a) => claim(c, qs, a, ids[0]) : call;
        const baseline = await send(code, q(token), undefined);
        expect(baseline.status).toBe(404);
        expect(Object.keys(baseline.body).sort()).toEqual(['message', 'statusCode']);

        const flipped = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
        const cases: [string, request.Test][] = [
          ['unverifiable header', send(code, q(token), 'not-a-real-token')],
          ['bad pay token', send(code, q(flipped), access)],
          ['longer pay token', send(code, q(`${token}x`), access)],
          ['empty pay token', send(code, '?token=', access)],
          ['no pay token', send(code, '', access)],
          ['repeated token', send(code, `?token=${token}&token=${token}`, access)],
          ['unknown session', send('no-such-session', q(token), access)],
        ];
        for (const [label, pending] of cases) {
          const res = await pending;
          expect({ label, status: res.status, body: res.body }).toEqual({ label, status: 404, body: baseline.body });
        }
      });

      it(`${name}: another session's pay token is refused`, async () => {
        const one = await setupSession();
        const two = await setupSession();
        const [access] = viewer();
        const send: Call = name === 'POST claim' ? (c, qs, a) => claim(c, qs, a, one.ids[0]) : call;
        const res = await send(one.code, q(two.token), access);
        expect(res.status).toBe(404);
      });

      it(`${name}: the old pay token dies on a reconfirm`, async () => {
        const { code, token, ids } = await setupSession();
        const [access] = viewer();
        const send: Call = name === 'POST claim' ? (c, qs, a) => claim(c, qs, a, ids[0]) : call;
        kit.reader.read.mockResolvedValue({ kind: 'not-slip' });
        expect((await send(code, q(token), access)).status).toBe(200);
        const fresh = randomUUID().replace(/-/g, '').slice(0, 22);
        await kit.confirm(code, fresh);
        expect((await send(code, q(token), access)).status).toBe(404);
        expect((await send(code, q(fresh), access)).status).toBe(200);
      });
    }

    it('answers 404 when the plan has lapsed, on all three routes', async () => {
      const lapsed = await kit.owner('host', new Date(Date.now() - 86_400_000));
      const { code, token, ids } = await kit.setup(lapsed.id);
      const [access] = viewer();
      expect((await get(code, q(token), access)).status).toBe(404);
      expect((await claim(code, q(token), access, ids[0])).status).toBe(404);
      expect((await upload(code, q(token), access)).status).toBe(404);
      expect(kit.reader.read).not.toHaveBeenCalled();
      expect(await kit.prisma.playerLineAccount.count({ where: { lineUserId: users.get(access)!.userId } })).toBe(0);
    });

    it('answers 404 when no card is confirmed', async () => {
      const { code, token } = await setupSession();
      await kit.prisma.session.update({ where: { code }, data: { paymentCard: null } });
      const [access] = viewer();
      expect((await get(code, q(token), access)).status).toBe(404);
    });
  });

  describe('POST upload', () => {
    it('refuses a body that is not an image with 400 and writes nothing', async () => {
      const { code, token, groupCode } = await setupSession();
      const [access] = viewer();
      const res = await upload(code, q(token), access, 'hello', 'text/plain');
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'SLIP_IMAGE_REQUIRED' });
      const json = await upload(code, q(token), access, JSON.stringify({ a: 1 }), 'application/json');
      expect(json.status).toBe(400);
      expect(kit.reader.read).not.toHaveBeenCalled();
      expect(await writtenFor(groupCode, code)).toBe(0);
    });

    it('refuses an empty body with 400', async () => {
      const { code, token, groupCode } = await setupSession();
      const [access] = viewer();
      const res = await upload(code, q(token), access, Buffer.alloc(0));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'SLIP_IMAGE_REQUIRED' });
      expect(kit.reader.read).not.toHaveBeenCalled();
      expect(await writtenFor(groupCode, code)).toBe(0);
    });

    it('refuses an image over 8 MB with 413 and writes nothing', async () => {
      const { code, token, groupCode } = await setupSession();
      const [access] = viewer();
      const res = await upload(code, q(token), access, Buffer.alloc(9 * 1024 * 1024, 1));
      expect(res.status).toBe(413);
      expect(kit.reader.read).not.toHaveBeenCalled();
      expect(await writtenFor(groupCode, code)).toBe(0);
    });

    it('marks a linked sender paid when the slip matches, and says so', async () => {
      const { code, token, ids } = await setupSession();
      const [access, user] = viewer();
      expect((await claim(code, q(token), access, ids[0])).body).toEqual({ outcome: 'linked' });
      const reference = newRef();
      kit.reader.read.mockResolvedValue(slipRead(reference, await kit.owed(code, ids[0])));

      const res = await upload(code, q(token), access);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ outcome: 'paid' });
      expect(kit.reader.read).toHaveBeenCalledWith(expect.any(Buffer));
      expect((kit.reader.read.mock.calls[0][0] as Buffer).equals(IMAGE)).toBe(true);
      expect(await kit.prisma.sessionPayment.findMany({ where: { sessionId: code } })).toEqual([
        expect.objectContaining({ playerId: ids[0], source: 'slip', reference }),
      ]);
      // The same slip again is a duplicate, never a second mark.
      const again = await upload(code, q(token), access);
      expect(again.body).toEqual({ outcome: 'duplicate' });
      expect(user.userId).toBeTruthy();
    });

    it('answers waiting with its reason for an unlinked sender', async () => {
      const { code, token, ids } = await setupSession();
      const [access] = viewer();
      kit.reader.read.mockResolvedValue(slipRead(newRef(), await kit.owed(code, ids[0])));
      const res = await upload(code, q(token), access);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ outcome: 'waiting', reason: 'unmapped' });
    });

    it('answers not-slip for an image with no slip QR', async () => {
      const { code, token } = await setupSession();
      const [access] = viewer();
      kit.reader.read.mockResolvedValue({ kind: 'not-slip' });
      const res = await upload(code, q(token), access);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ outcome: 'not-slip' });
    });
  });

  describe('GET slip-pay', () => {
    it('shows an unlinked viewer who can be claimed, and no amount', async () => {
      const { code, token, ids } = await setupSession();
      const [access] = viewer();
      const res = await get(code, q(token), access);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['accountName', 'alreadyPaid', 'amountSatang', 'claimable', 'playerName']);
      expect(res.body).toMatchObject({ amountSatang: null, playerName: null, alreadyPaid: false, accountName: 'สมหญิง ใจดี' });
      expect(res.body.claimable.map((c: { playerId: string }) => c.playerId).sort()).toEqual([...ids].sort());
      expect(res.body.claimable[0]).toEqual({ playerId: expect.any(String), name: expect.any(String) });
    });

    it('shows a linked viewer their own amount, and drops claimed and paid players from claimable', async () => {
      const { code, token, ids } = await setupSession();
      const [access] = viewer();
      expect((await claim(code, q(token), access, ids[1])).body).toEqual({ outcome: 'linked' });
      await kit.prisma.sessionPayment.create({ data: { sessionId: code, playerId: ids[2], source: 'host' } });

      const res = await get(code, q(token), access);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        amountSatang: await kit.owed(code, ids[1]),
        playerName: 'มาลี',
        alreadyPaid: false,
      });
      expect(res.body.claimable.map((c: { playerId: string }) => c.playerId).sort()).toEqual([ids[0], ids[3]].sort());

      await kit.prisma.sessionPayment.create({ data: { sessionId: code, playerId: ids[1], source: 'host' } });
      expect((await get(code, q(token), access)).body).toMatchObject({ alreadyPaid: true, playerName: 'มาลี' });
    });

    it('does not leak ids other than the claimable players, the account number or the token', async () => {
      const { code, token, groupCode } = await setupSession();
      const [access] = viewer();
      const res = await get(code, q(token), access);
      for (const secret of [token, groupCode, '123-4-56789-0', 'lineUserId']) expect(res.text).not.toContain(secret);
    });
  });

  describe('POST claim', () => {
    it('links once; a taken player and a second player for one account are refused', async () => {
      const { code, token, ids } = await setupSession();
      const [a] = viewer('A');
      const [b] = viewer('B');
      expect((await claim(code, q(token), a, ids[0])).body).toEqual({ outcome: 'linked' });
      expect((await claim(code, q(token), b, ids[0])).body).toEqual({ outcome: 'player-taken' });
      expect((await claim(code, q(token), a, ids[1])).body).toEqual({ outcome: 'account-already-linked' });
      expect((await claim(code, q(token), b, 'someone-else')).body).toEqual({ outcome: 'not-on-bill' });
      expect(await kit.app.get(SlipPaymentsService).linkedPlayerOf(
        (await kit.prisma.session.findUniqueOrThrow({ where: { code } })).groupId,
        users.get(a)!.userId
      )).toBe(ids[0]);
    });

    it('rejects a body without a playerId as a bad request', async () => {
      const { code, token } = await setupSession();
      const [a] = viewer();
      expect((await claim(code, q(token), a, undefined)).status).toBe(400);
    });
  });

  describe('throttle', () => {
    it('answers 429 on the eleventh failed attempt by one viewer for one session, then not for another session', async () => {
      const { code, token } = await setupSession();
      const other = await setupSession();
      const [access] = viewer();
      for (let i = 0; i < 10; i++) expect((await get(code, '?token=wrong', access)).status).toBe(404);
      const blocked = await get(code, '?token=wrong', access);
      expect(blocked.status).toBe(429);
      // Blocked even with the right token: the key is spent, nothing says which half was wrong.
      expect((await get(code, q(token), access)).status).toBe(429);
      // Another session of the same viewer has its own budget.
      expect((await get(other.code, q(other.token), access)).status).toBe(200);
      // Another viewer on the first session too.
      const [fresh] = viewer();
      expect((await get(code, q(token), fresh)).status).toBe(200);
    });

    it('counts a plan-lapsed (unavailable) attempt as a failure', async () => {
      const lapsed = await kit.owner('host', new Date(Date.now() - 86_400_000));
      const { code, token } = await kit.setup(lapsed.id);
      const [access] = viewer();
      for (let i = 0; i < 10; i++) expect((await upload(code, q(token), access)).status).toBe(404);
      expect((await upload(code, q(token), access)).status).toBe(429);
    });

    it('a paid upload resets the counter', async () => {
      const { code, token, ids } = await setupSession();
      const [access] = viewer();
      await claim(code, q(token), access, ids[0]);
      for (let i = 0; i < 9; i++) expect((await get(code, '?token=wrong', access)).status).toBe(404);
      kit.reader.read.mockResolvedValue(slipRead(newRef(), await kit.owed(code, ids[0])));
      expect((await upload(code, q(token), access)).body).toEqual({ outcome: 'paid' });
      for (let i = 0; i < 9; i++) expect((await get(code, '?token=wrong', access)).status).toBe(404);
      expect((await get(code, '?token=wrong', access)).status).toBe(404);
      expect((await get(code, '?token=wrong', access)).status).toBe(429);
    });

    it('waiting, duplicate and not-slip outcomes are not failures', async () => {
      const { code, token } = await setupSession();
      const [access] = viewer();
      kit.reader.read.mockResolvedValue({ kind: 'not-slip' });
      for (let i = 0; i < 15; i++) expect((await upload(code, q(token), access)).status).toBe(200);
      expect((await get(code, q(token), access)).status).toBe(200);
    });

    it('429s a source address after ten unverifiable LINE tokens, even for a good one', async () => {
      const { code, token } = await setupSession();
      for (let i = 0; i < 10; i++) expect((await get(code, q(token), `bad-${i}`)).status).toBe(404);
      const [good] = viewer();
      expect((await get(code, q(token), good)).status).toBe(429);
    });
  });
});
