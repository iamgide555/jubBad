import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import {
  bootSlipApp,
  lineUser,
  newRef,
  slipRead,
} from '../../../test/slip-http.fixture.js';
import { SlipPaymentsService, type LiffUser } from './slip-payments.service.js';
import { BillService } from '../bill.service.js';
import { SlipUploadSlots } from './slip-throttles.js';

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
    kit.resetThrottles();
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
  const status = (code: string, query: string, access?: string) => {
    const r = request(kit.server).get(`${pay(code)}/status${query}`);
    return access === undefined ? r : r.set(HEADER, access);
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
      ['GET status', (c, qs, a) => status(c, qs, a)],
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
      expect((await status(code, q(token), access)).status).toBe(404);
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
      expect((await status(code, q(token), access)).status).toBe(404);
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

    it('answers waiting without saying why, for an unlinked sender', async () => {
      // The reason stays with the host: a sender (or a forger) is never told which check held the slip.
      const { code, token, ids } = await setupSession();
      const [access] = viewer();
      kit.reader.read.mockResolvedValue(slipRead(newRef(), await kit.owed(code, ids[0])));
      const res = await upload(code, q(token), access);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ outcome: 'waiting' });
      expect(await kit.prisma.pendingSlip.findMany({ where: { sessionId: code } })).toEqual([
        expect.objectContaining({ reason: 'unmapped' }),
      ]);
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
      expect(Object.keys(res.body).sort()).toEqual([
        'accountName', 'alreadyPaid', 'amountSatang', 'claimable', 'collectionClosed', 'playerName', 'sessionDate',
      ]);
      expect(res.body).toMatchObject({
        amountSatang: null, playerName: null, alreadyPaid: false, accountName: 'สมหญิง ใจดี', sessionDate: '30 ต.ค. 2569',
      });
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

  describe('GET payment status', () => {
    it('shows fresh bill rows to an unclaimed viewer without host data or writes', async () => {
      const { code, token, ids, groupCode } = await setupSession();
      const [access, user] = viewer();
      await kit.prisma.sessionPayment.create({ data: { sessionId: code, playerId: ids[0], source: 'slip', amountSatang: 1 } });
      const res = await status(code, q(token), access).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(Object.keys(res.body).sort()).toEqual(['closedAt', 'pendingSlipCount', 'rows', 'sessionDate']);
      expect(res.body.sessionDate).toBe('30 ต.ค. 2569');
      expect(res.body.rows).toHaveLength(4);
      expect(res.body.rows.find((r: { name: string }) => r.name === 'สมชาย')).toEqual({
        name: 'สมชาย', amountSatang: await kit.owed(code, ids[0]), paid: true, pending: false, amountChangedSince: true,
      });
      expect(res.body.rows.filter((r: { paid: boolean }) => !r.paid)).toHaveLength(3);
      for (const row of res.body.rows) expect(Object.keys(row).sort()).toEqual(['amountChangedSince', 'amountSatang', 'name', 'paid', 'pending']);
      for (const secret of [token, groupCode, ...ids, user.userId, '123-4-56789-0', 'receiverName', 'reference']) expect(res.text).not.toContain(secret);
      expect(await kit.prisma.playerLineAccount.count({ where: { groupId: groupCode } })).toBe(0);
      await kit.app.get(SlipPaymentsService).tick(code, ids[1]);
      expect((await status(code, q(token), access)).body.rows.filter((r: { paid: boolean }) => r.paid)).toHaveLength(2);
      await kit.app.get(SlipPaymentsService).untick(code, ids[1]);
      expect((await status(code, q(token), access)).body.rows.filter((r: { paid: boolean }) => r.paid)).toHaveLength(1);
    });

    it('reflects edited bill amounts and names without erasing existing payment marks', async () => {
      const { code, token, ids } = await setupSession();
      const [access] = viewer();
      const owed = await kit.owed(code, ids[0]);
      await kit.prisma.sessionPayment.create({ data: { sessionId: code, playerId: ids[0], source: 'slip', amountSatang: owed } });
      await kit.prisma.player.update({ where: { id: ids[0] }, data: { name: 'Updated name' } });
      await kit.app.get(BillService).setBillConfig(code, {
        model: 'fair', courtFeeSatang: 80000, courtSplit: 'equal', shuttleSplit: 'byGames',
        perGameRateSatang: 0, entryFeeSatang: 0, capSatang: null, buffetPriceSatang: 0,
        buffetShuttlesIncluded: true, startingFeeSatang: 0, hostFeeSatang: 0, walkInFeeSatang: 0, roundingBaht: 1,
        addedIds: [], removedIds: [], overrides: [],
      } as never);
      const res = await status(code, q(token), access).expect(200);
      const row = res.body.rows.find((r: { name: string }) => r.name === 'Updated name');
      expect(row.amountSatang).not.toBe(owed);
      expect(row).toMatchObject({ paid: true, amountChangedSince: true });
      expect(await kit.prisma.sessionPayment.count({ where: { sessionId: code } })).toBe(1);
    });

    it('refuses status mutations using only LINE credentials', async () => {
      const { code, token, ids } = await setupSession();
      const [access] = viewer();
      for (const method of ['post', 'patch', 'delete'] as const) {
        const res = await request(kit.server)[method](`${pay(code)}/status${q(token)}`).set(HEADER, access).send({ playerId: ids[0], paid: true });
        expect([401, 404]).toContain(res.status);
      }
      await request(kit.server).post(`/sessions/${code}/payments/tick`).set(HEADER, access).send({ playerId: ids[0] }).expect(401);
      expect(await kit.prisma.sessionPayment.count({ where: { sessionId: code } })).toBe(0);
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
      // The upload budget does not apply to GET: this 429 is the failure counter.
      expect((await get(code, q(token), access)).status).toBe(429);
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
      for (let i = 0; i < 10; i++) expect((await upload(code, q(token), access)).status).toBe(200);
      // Only the upload budget is spent; the failure counter is untouched.
      expect((await get(code, q(token), access)).status).toBe(200);
      expect((await claim(code, q(token), access, 'nobody')).status).toBe(200);
    });

    it('429s a source address after ten unverifiable LINE tokens, even for a good one', async () => {
      const { code, token } = await setupSession();
      for (let i = 0; i < 10; i++) expect((await get(code, q(token), `bad-${i}`)).status).toBe(404);
      const [good] = viewer();
      expect((await get(code, q(token), good)).status).toBe(429);
    });
  });

  describe('upload abuse limits (checked before the body is read)', () => {
    /** Starts a chunked image upload and resolves with the status once the server answers, without ending the body. */
    function chunkedUpload(code: string, query: string, access: string): Promise<{ status: number; consumedAll: boolean }> {
      const { port } = kit.server.address() as AddressInfo;
      return new Promise((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1', port, method: 'POST', path: `${pay(code)}/upload${query}`,
          headers: { 'content-type': 'image/png', 'transfer-encoding': 'chunked', [HEADER]: access },
        });
        req.on('response', (res) => {
          res.resume();
          // The request body was never ended by the client, so a server that waited for it could not have answered.
          resolve({ status: res.statusCode ?? 0, consumedAll: false });
          req.destroy();
        });
        req.on('error', (e) => {
          if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e);
        });
        req.write(Buffer.alloc(64 * 1024, 1));
        setTimeout(() => reject(new Error('server waited for the body')), 3000).unref();
      });
    }

    it('refuses an upload from a blocked address with 429 without reading the body', async () => {
      const { code, token } = await setupSession();
      for (let i = 0; i < 10; i++) expect((await get(code, q(token), `bad-${i}`)).status).toBe(404);
      const [good] = viewer();
      const res = await chunkedUpload(code, q(token), good);
      expect(res.status).toBe(429);
      expect(kit.liff.verify).not.toHaveBeenCalledWith(good);
      expect(kit.reader.read).not.toHaveBeenCalled();
    });

    it('answers an unverifiable LINE token on upload with the uniform 404, counts it against the address, and never reads the body', async () => {
      const { code, token } = await setupSession();
      const baseline = await upload(code, q(token), undefined);
      expect(baseline.status).toBe(404);
      const res = await chunkedUpload(code, q(token), 'not-a-real-token');
      expect(res.status).toBe(404);
      // Nine more unverifiable tokens fill the address budget (ten in all); a missing header earlier did not count.
      for (let i = 0; i < 9; i++) expect((await upload(code, q(token), `bad-${i}`)).body).toEqual(baseline.body);
      const [good] = viewer();
      expect((await get(code, q(token), good)).status).toBe(429);
    });

    it('a missing header is a bare 404 and is never counted against the address', async () => {
      const { code, token } = await setupSession();
      for (let i = 0; i < 15; i++) expect((await upload(code, q(token), undefined)).status).toBe(404);
      const [good] = viewer();
      expect((await get(code, q(token), good)).status).toBe(200);
    });

    it('429s the eleventh upload of one viewer in the window even when every earlier one was harmless', async () => {
      const { code, token, ids } = await setupSession();
      const [access] = viewer();
      kit.reader.read.mockImplementation(async () => slipRead(newRef(), await kit.owed(code, ids[0])));
      for (let i = 0; i < 10; i++) {
        const res = await upload(code, q(token), access);
        expect({ i, status: res.status, outcome: res.body.outcome }).toEqual({ i, status: 200, outcome: 'waiting' });
      }
      const calls = kit.reader.read.mock.calls.length;
      const blocked = await upload(code, q(token), access, Buffer.alloc(1024, 1));
      expect(blocked.status).toBe(429);
      expect(kit.reader.read.mock.calls.length).toBe(calls);
      // GET and claim are not uploads.
      expect((await get(code, q(token), access)).status).toBe(200);
    });

    it('does not share a budget between viewers or between sessions', async () => {
      const one = await setupSession();
      const two = await setupSession();
      const [a] = viewer('A');
      const [b] = viewer('B');
      kit.reader.read.mockResolvedValue({ kind: 'not-slip' });
      for (let i = 0; i < 10; i++) expect((await upload(one.code, q(one.token), a)).status).toBe(200);
      expect((await upload(one.code, q(one.token), a)).status).toBe(429);
      expect((await upload(one.code, q(one.token), b)).status).toBe(200);
      expect((await upload(two.code, q(two.token), a)).status).toBe(200);
    });

    it('refuses with 429 when six uploads are already being processed, and frees the slot afterwards', async () => {
      const { code, token } = await setupSession();
      const release: (() => void)[] = [];
      kit.reader.read.mockImplementation(
        () => new Promise((resolve) => release.push(() => resolve({ kind: 'not-slip' })))
      );
      const viewers = Array.from({ length: 7 }, (_, i) => viewer(`V${i}`)[0]);
      const inFlight = viewers.slice(0, 6).map((v) => upload(code, q(token), v).then((r) => r));
      for (let i = 0; i < 200 && kit.reader.read.mock.calls.length < 6; i++) await new Promise((r) => setTimeout(r, 10));
      expect(kit.reader.read.mock.calls.length).toBe(6);

      const seventh = await upload(code, q(token), viewers[6], Buffer.alloc(1024, 1));
      expect(seventh.status).toBe(429);
      expect(kit.reader.read.mock.calls.length).toBe(6);

      release.forEach((r) => r());
      for (const res of await Promise.all(inFlight)) expect(res.status).toBe(200);

      kit.reader.read.mockResolvedValue({ kind: 'not-slip' });
      expect((await upload(code, q(token), viewers[6])).status).toBe(200);
    });
  });

  describe('the in-flight slot is released on every path', () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 300 && !cond(); i++) await wait(10);
      expect(cond()).toBe(true);
    };
    const inFlight = () => kit.app.get(SlipUploadSlots).inFlight;

    /** A chunked image upload that is started and left open; `abort()` drops the connection. */
    function openUpload(code: string, query: string, access: string, withBody = true) {
      const { port } = kit.server.address() as AddressInfo;
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: `${pay(code)}/upload${query}`,
        headers: { 'content-type': 'image/png', 'transfer-encoding': 'chunked', [HEADER]: access },
      });
      req.on('error', () => {});
      // Without a body the server notices the disconnect at once; with unread body bytes it may not until it reads them.
      if (withBody) req.write(Buffer.alloc(64 * 1024, 1));
      else req.flushHeaders();
      return { abort: () => req.destroy() };
    }

    it('does not leak slots when clients abort during a slow LINE verification (six times)', async () => {
      const { code, token } = await setupSession();
      const [access, user] = viewer();
      const pending: (() => void)[] = [];
      kit.liff.verify.mockReset().mockImplementation(
        () => new Promise((resolve) => pending.push(() => resolve(user)))
      );
      for (let i = 0; i < 6; i++) {
        const call = openUpload(code, q(token), access, false);
        await until(() => kit.liff.verify.mock.calls.length === i + 1);
        call.abort();
      }
      await wait(100);
      // LINE answers after every client is gone.
      pending.forEach((resolve) => resolve());
      await wait(100);
      expect(inFlight()).toBe(0);
      expect(kit.reader.read).not.toHaveBeenCalled();

      kit.liff.verify.mockReset().mockImplementation(async (t) => users.get(t) ?? null);
      kit.reader.read.mockResolvedValue({ kind: 'not-slip' });
      expect((await upload(code, q(token), access)).status).toBe(200);
      // The aborted attempts spent none of the viewer's upload budget: ten more uploads still fit after the one above...
      const statuses: number[] = [];
      for (let i = 0; i < 9; i++) statuses.push((await upload(code, q(token), access)).status);
      expect(statuses).toEqual(Array(9).fill(200));
      expect((await upload(code, q(token), access)).status).toBe(429);
      expect(inFlight()).toBe(0);
    });

    it('releases the slot when the client aborts during the body read', async () => {
      const { code, token } = await setupSession();
      const [access] = viewer();
      const call = openUpload(code, q(token), access);
      await until(() => inFlight() === 1);
      call.abort();
      await until(() => inFlight() === 0);
      expect(kit.reader.read).not.toHaveBeenCalled();
    });

    it('still refuses the seventh of six live uploads, and counts zero once they finish', async () => {
      const { code, token } = await setupSession();
      const release: (() => void)[] = [];
      kit.reader.read.mockImplementation(
        () => new Promise((resolve) => release.push(() => resolve({ kind: 'not-slip' })))
      );
      const viewers = Array.from({ length: 7 }, (_, i) => viewer(`W${i}`)[0]);
      const live = viewers.slice(0, 6).map((v) => upload(code, q(token), v).then((r) => r));
      await until(() => kit.reader.read.mock.calls.length === 6);
      expect(inFlight()).toBe(6);
      expect((await upload(code, q(token), viewers[6], Buffer.alloc(1024, 1))).status).toBe(429);
      release.forEach((r) => r());
      for (const res of await Promise.all(live)) expect(res.status).toBe(200);
      await until(() => inFlight() === 0);
    });
  });
});
