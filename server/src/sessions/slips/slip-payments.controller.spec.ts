import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { bootSlipApp, lineUser, newRef } from '../../../test/slip-http.fixture.js';

type Kit = Awaited<ReturnType<typeof bootSlipApp>>;

describe('host payment routes /sessions/:code/payments (owner only)', () => {
  let kit: Kit;
  let host: { id: string; cookie: string };
  let stranger: { id: string; cookie: string };

  beforeAll(async () => {
    kit = await bootSlipApp();
    host = await kit.owner();
    stranger = await kit.owner();
  });
  afterAll(() => kit.cleanup());

  const base = (code: string) => `/sessions/${code}/payments`;
  const as = (cookie: string | null, r: request.Test) => (cookie === null ? r : r.set('Cookie', cookie));
  const get = (code: string, cookie: string | null = host.cookie) => as(cookie, request(kit.server).get(base(code)));
  const post = (code: string, path: string, body: object = {}, cookie: string | null = host.cookie) =>
    as(cookie, request(kit.server).post(`${base(code)}${path}`)).send(body);
  const setupSession = () => kit.setup(host.id);

  async function waitingSlip(code: string, groupCode: string, over: Partial<Record<string, unknown>> = {}) {
    return kit.prisma.pendingSlip.create({
      data: {
        sessionId: code, groupId: groupCode, reference: newRef(), lineUserId: lineUser().userId,
        displayName: 'Sender', pictureUrl: null, amountSatang: null, receiverName: null, receiverTail: null,
        reason: 'unmapped', ...over,
      },
    });
  }

  describe('access', () => {
    it('refuses an anonymous caller with 401 on every route and a non-owner with 404', async () => {
      const { code } = await setupSession();
      const calls: [string, string][] = [
        ['get', ''], ['post', '/tick'], ['post', '/untick'], ['post', '/waiting/x/resolve'], ['post', '/waiting/x/dismiss'],
        ['post', '/waiting/x/update-name'], ['post', '/duplicates/x/dismiss'], ['post', '/links'],
      ];
      for (const [method, path] of calls) {
        const url = `${base(code)}${path}`;
        const anon = await (method === 'get' ? request(kit.server).get(url) : request(kit.server).post(url).send({}));
        expect({ path, status: anon.status }).toEqual({ path, status: 401 });
        const other = await as(
          stranger.cookie,
          method === 'get' ? request(kit.server).get(url) : request(kit.server).post(url).send({})
        );
        expect({ path, status: other.status }).toEqual({ path, status: 404 });
      }
    });
  });

  describe('GET', () => {
    it('lists the paid rows, waiting slips, duplicates and links', async () => {
      const { code, groupCode, ids } = await setupSession();
      expect((await get(code)).body).toEqual({ paid: [], waiting: [], duplicates: [], links: [] });

      await post(code, '/tick', { playerId: ids[0] }).expect(200);
      const waiting = await waitingSlip(code, groupCode);
      await kit.prisma.slipDuplicate.create({
        data: {
          groupId: groupCode, sessionId: code, reference: 'REFDUPLICATE123456', lineUserId: lineUser().userId,
          displayName: 'Dup', originalPlayerIds: JSON.stringify([ids[0]]),
        },
      });
      await post(code, '/links', { playerId: ids[1], lineUserId: 'Uabc' }).expect(200);

      const res = await get(code);
      expect(res.status).toBe(200);
      expect(res.body.paid).toEqual([expect.objectContaining({ playerId: ids[0], source: 'host', amountChangedSince: false })]);
      expect(res.body.waiting).toEqual([expect.objectContaining({ id: waiting.id, reason: 'unmapped' })]);
      expect(res.body.waiting[0].candidatePlayerIds.sort()).toEqual(ids.slice(1).sort());
      expect(res.body.duplicates).toEqual([
        expect.objectContaining({ referenceTail: '123456', originalPlayerIds: [ids[0]] }),
      ]);
      expect(res.body.links).toEqual([expect.objectContaining({ playerId: ids[1], linkedBy: 'host' })]);
    });

    it('404s an unknown session', async () => {
      await get('no-such-session').expect(404);
    });
  });

  describe('tick and untick', () => {
    it('round-trips through GET', async () => {
      const { code, ids } = await setupSession();
      expect(await post(code, '/tick', { playerId: ids[0] })).toMatchObject({ status: 200, body: { ok: true } });
      expect((await get(code)).body.paid.map((p: { playerId: string }) => p.playerId)).toEqual([ids[0]]);
      // Ticking again keeps the one mark.
      await post(code, '/tick', { playerId: ids[0] }).expect(200);
      expect((await get(code)).body.paid).toHaveLength(1);
      expect(await post(code, '/untick', { playerId: ids[0] })).toMatchObject({ status: 200, body: { ok: true } });
      expect((await get(code)).body.paid).toEqual([]);
    });

    it('409s a player who is not on the bill, and 400s a missing playerId', async () => {
      const { code } = await setupSession();
      const res = await post(code, '/tick', { playerId: 'nobody' });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'PLAYER_NOT_ON_BILL' });
      await post(code, '/tick', {}).expect(400);
      await post(code, '/untick', {}).expect(400);
    });
  });

  describe('waiting slips', () => {
    it('resolve marks the covered players paid and links the sender', async () => {
      const { code, groupCode, ids } = await setupSession();
      const slip = await waitingSlip(code, groupCode, { lineUserId: 'Usender1' });
      const res = await post(code, `/waiting/${slip.id}/resolve`, { coversPlayerIds: [ids[0], ids[1]], senderPlayerId: ids[0] });
      expect(res).toMatchObject({ status: 200, body: { ok: true } });
      const after = (await get(code)).body;
      expect(after.waiting).toEqual([]);
      expect(after.paid.map((p: { playerId: string }) => p.playerId).sort()).toEqual([ids[0], ids[1]].sort());
      expect(after.links).toEqual([expect.objectContaining({ playerId: ids[0], linkedBy: 'host' })]);
    });

    it('resolve without a sender links nobody', async () => {
      const { code, groupCode, ids } = await setupSession();
      const slip = await waitingSlip(code, groupCode);
      await post(code, `/waiting/${slip.id}/resolve`, { coversPlayerIds: [ids[2]] }).expect(200);
      const after = (await get(code)).body;
      expect(after.links).toEqual([]);
      expect(after.paid).toHaveLength(1);
    });

    it('resolve conflicts: nobody covered, a player off the bill, a sender whose account is linked elsewhere', async () => {
      const { code, groupCode, ids } = await setupSession();
      const slip = await waitingSlip(code, groupCode, { lineUserId: 'Ulinked' });
      const none = await post(code, `/waiting/${slip.id}/resolve`, { coversPlayerIds: [] });
      expect(none.status).toBe(409);
      expect(none.body).toMatchObject({ code: 'COVERS_REQUIRED' });
      expect((await post(code, `/waiting/${slip.id}/resolve`, { coversPlayerIds: ['nobody'] })).status).toBe(409);
      await post(code, '/links', { playerId: ids[3], lineUserId: 'Ulinked' }).expect(200);
      const taken = await post(code, `/waiting/${slip.id}/resolve`, { coversPlayerIds: [ids[0]], senderPlayerId: ids[0] });
      expect(taken.status).toBe(409);
      expect(taken.body).toMatchObject({ code: 'ACCOUNT_ALREADY_LINKED' });
      // Nothing was written by the refusals.
      expect((await get(code)).body.paid).toEqual([]);
    });

    it('resolve of an unknown or already-resolved slip is 404; a malformed body is 400', async () => {
      const { code, groupCode, ids } = await setupSession();
      expect((await post(code, '/waiting/nope/resolve', { coversPlayerIds: [ids[0]] })).status).toBe(404);
      const slip = await waitingSlip(code, groupCode);
      await post(code, `/waiting/${slip.id}/resolve`, { coversPlayerIds: [ids[0]] }).expect(200);
      expect((await post(code, `/waiting/${slip.id}/resolve`, { coversPlayerIds: [ids[0]] })).status).toBe(404);
      await post(code, `/waiting/${slip.id}/resolve`, { coversPlayerIds: 'x' }).expect(400);
    });

    it('does not touch another session\'s slip', async () => {
      const one = await setupSession();
      const two = await setupSession();
      const slip = await waitingSlip(two.code, two.groupCode);
      expect((await post(one.code, `/waiting/${slip.id}/dismiss`)).status).toBe(404);
      expect((await post(one.code, `/waiting/${slip.id}/resolve`, { coversPlayerIds: [one.ids[0]] })).status).toBe(404);
    });

    it('dismiss removes it without paying anyone; a second dismiss is 404', async () => {
      const { code, groupCode } = await setupSession();
      const slip = await waitingSlip(code, groupCode);
      expect(await post(code, `/waiting/${slip.id}/dismiss`)).toMatchObject({ status: 200, body: { ok: true } });
      const after = (await get(code)).body;
      expect(after.waiting).toEqual([]);
      expect(after.paid).toEqual([]);
      expect((await post(code, `/waiting/${slip.id}/dismiss`)).status).toBe(404);
    });

    it('update-name saves the receiver as the group name; any other slip is a 409', async () => {
      const { code, groupCode } = await setupSession();
      const receiver = await waitingSlip(code, groupCode, { reason: 'receiver', receiverName: 'สมหญิง ใจเย็น', receiverTail: '5953' });
      expect(await post(code, `/waiting/${receiver.id}/update-name`)).toMatchObject({ status: 200, body: { ok: true } });
      const group = await kit.prisma.group.findUniqueOrThrow({ where: { code: groupCode } });
      expect(JSON.parse(group.payAccount!)).toMatchObject({ name: 'สมหญิง ใจเย็น' });

      const other = await waitingSlip(code, groupCode, { reason: 'amount' });
      const res = await post(code, `/waiting/${other.id}/update-name`);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'NAME_UPDATE_NOT_APPLICABLE' });
      expect((await post(code, '/waiting/nope/update-name')).status).toBe(404);
    });
  });

  describe('duplicates', () => {
    it('dismiss removes the row; a second dismiss is 404', async () => {
      const { code, groupCode, ids } = await setupSession();
      const dup = await kit.prisma.slipDuplicate.create({
        data: {
          groupId: groupCode, sessionId: code, reference: `REF${randomUUID()}`, lineUserId: lineUser().userId,
          displayName: 'Dup', originalPlayerIds: JSON.stringify([ids[0]]),
        },
      });
      expect((await get(code)).body.duplicates).toHaveLength(1);
      expect(await post(code, `/duplicates/${dup.id}/dismiss`)).toMatchObject({ status: 200, body: { ok: true } });
      expect((await get(code)).body.duplicates).toEqual([]);
      expect((await post(code, `/duplicates/${dup.id}/dismiss`)).status).toBe(404);
    });
  });

  describe('links', () => {
    it('links a player, repoints it, and removes it with null', async () => {
      const { code, ids } = await setupSession();
      await post(code, '/links', { playerId: ids[0], lineUserId: 'Uone' }).expect(200);
      expect((await get(code)).body.links).toEqual([expect.objectContaining({ playerId: ids[0], linkedBy: 'host' })]);
      await post(code, '/links', { playerId: ids[0], lineUserId: 'Utwo' }).expect(200);
      expect((await get(code)).body.links).toHaveLength(1);
      expect(await post(code, '/links', { playerId: ids[0], lineUserId: null })).toMatchObject({ status: 200, body: { ok: true } });
      expect((await get(code)).body.links).toEqual([]);
    });

    it('409s an account linked to another player and a player outside the group; 400s a malformed body', async () => {
      const { code, ids } = await setupSession();
      await post(code, '/links', { playerId: ids[0], lineUserId: 'Uone' }).expect(200);
      const taken = await post(code, '/links', { playerId: ids[1], lineUserId: 'Uone' });
      expect(taken.status).toBe(409);
      expect(taken.body).toMatchObject({ code: 'ACCOUNT_ALREADY_LINKED' });
      const outside = await post(code, '/links', { playerId: 'nobody', lineUserId: 'Uthree' });
      expect(outside.status).toBe(409);
      expect(outside.body).toMatchObject({ code: 'PLAYER_NOT_IN_GROUP' });
      await post(code, '/links', { playerId: ids[1] }).expect(400);
      await post(code, '/links', { lineUserId: 'Ux' }).expect(400);
    });
  });
});
