import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  bootSlipApp,
  lineUser,
  newRef,
  slipRead,
} from '../../../test/slip-http.fixture.js';
import { SlipImagesService } from './slip-images.service.js';
import { SlipPaymentsService, type LiffUser } from './slip-payments.service.js';

type Kit = Awaited<ReturnType<typeof bootSlipApp>>;
type Session = Awaited<ReturnType<Kit['setup']>>;

const HEADER = 'X-Line-Access-Token';
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489',
  'hex',
);

/** A bill whose collector is `ids[0]`, with one waiting slip (and its image) and one duplicate to act on. */
interface CollectorBill extends Session {
  access: string;
  user: LiffUser;
  waitingId: string;
  duplicateId: string;
  imageId: string;
}

describe('collector manage routes (public, LINE identity + card token)', () => {
  let kit: Kit;
  let hostId: string;
  let slips: SlipPaymentsService;
  let images: SlipImagesService;
  const users = new Map<string, LiffUser>();
  const withImages: string[] = [];

  beforeAll(async () => {
    kit = await bootSlipApp();
    hostId = (await kit.owner()).id;
    slips = kit.app.get(SlipPaymentsService);
    images = kit.app.get(SlipImagesService);
  });
  afterAll(async () => {
    for (const code of withImages) await images.purgeSession(code);
    await kit.cleanup();
  });

  beforeEach(() => {
    users.clear();
    kit.liff.verify
      .mockReset()
      .mockImplementation(async (t) => users.get(t) ?? null);
    kit.reader.read.mockReset();
    kit.resetThrottles();
  });

  /** A viewer LINE account whose access token verifies, as `[token, user]`. */
  function viewer(name = 'Boom'): [string, LiffUser] {
    const user = lineUser(name);
    const token = `tok-${randomUUID()}`;
    users.set(token, user);
    return [token, user];
  }

  async function collectorBill(ownerId = hostId): Promise<CollectorBill> {
    const s = await kit.setup(ownerId);
    const [access, user] = viewer('Boom');
    await kit.linkLine(s.groupCode, s.ids[0], user);
    await kit.setCollector(s.groupCode, s.ids[0]);
    const reference = newRef();
    const imageId = (await images.save(s.code, reference, PNG))!;
    withImages.push(s.code);
    const waiting = await kit.prisma.pendingSlip.create({
      data: {
        sessionId: s.code,
        groupId: s.groupCode,
        reference,
        lineUserId: lineUser('Sender').userId,
        displayName: 'Sender',
        reason: 'unmapped',
        amountSatang: await kit.owed(s.code, s.ids[1]),
      },
    });
    const duplicate = await kit.prisma.slipDuplicate.create({
      data: {
        groupId: s.groupCode,
        sessionId: s.code,
        reference: newRef(),
        lineUserId: lineUser('Twice').userId,
        displayName: 'Twice',
        originalPlayerIds: '[]',
      },
    });
    return {
      ...s,
      access,
      user,
      waitingId: waiting.id,
      duplicateId: duplicate.id,
      imageId,
    };
  }

  const m = (code: string) => `/sessions/${code}/slip-pay/manage`;
  const q = (token: string) => `?token=${encodeURIComponent(token)}`;
  const withAccess = (r: request.Test, access?: string) =>
    access === undefined ? r : r.set(HEADER, access);
  const get = (path: string, access?: string) =>
    withAccess(request(kit.server).get(path), access);
  const post = (path: string, access: string | undefined, body: object = {}) =>
    withAccess(request(kit.server).post(path), access).send(body);
  const role = (code: string, query: string, access?: string) =>
    get(`/sessions/${code}/slip-pay/role${query}`, access);
  const status = (code: string, query: string, access?: string) =>
    get(`/sessions/${code}/slip-pay/status${query}`, access);

  type Call = (
    b: CollectorBill,
    code: string,
    query: string,
    access: string | undefined,
  ) => request.Test;
  const routes: [string, Call][] = [
    ['GET manage', (_b, c, qs, a) => get(`${m(c)}${qs}`, a)],
    ['GET image', (b, c, qs, a) => get(`${m(c)}/images/${b.imageId}${qs}`, a)],
    [
      'POST tick',
      (b, c, qs, a) => post(`${m(c)}/tick${qs}`, a, { playerId: b.ids[1] }),
    ],
    [
      'POST untick',
      (b, c, qs, a) => post(`${m(c)}/untick${qs}`, a, { playerId: b.ids[1] }),
    ],
    [
      'POST resolve',
      (b, c, qs, a) =>
        post(`${m(c)}/waiting/${b.waitingId}/resolve${qs}`, a, {
          coversPlayerIds: [b.ids[1]],
          senderPlayerId: b.ids[1],
        }),
    ],
    [
      'POST waiting dismiss',
      (b, c, qs, a) => post(`${m(c)}/waiting/${b.waitingId}/dismiss${qs}`, a),
    ],
    [
      'POST duplicate dismiss',
      (b, c, qs, a) =>
        post(`${m(c)}/duplicates/${b.duplicateId}/dismiss${qs}`, a),
    ],
    [
      'POST close',
      (_b, c, qs, a) =>
        post(`${m(c)}/close${qs}`, a, { confirmDeleteImages: true }),
    ],
  ];

  /** Nothing a collector route could write happened on this bill. */
  async function untouched(b: CollectorBill) {
    expect(
      await kit.prisma.sessionPayment.count({ where: { sessionId: b.code } }),
    ).toBe(0);
    expect(
      (
        await kit.prisma.pendingSlip.findUniqueOrThrow({
          where: { id: b.waitingId },
        })
      ).resolvedAt,
    ).toBeNull();
    expect(
      (
        await kit.prisma.slipDuplicate.findUniqueOrThrow({
          where: { id: b.duplicateId },
        })
      ).dismissedAt,
    ).toBeNull();
    expect(
      (await kit.prisma.session.findUniqueOrThrow({ where: { code: b.code } }))
        .paymentCollectionClosedAt,
    ).toBeNull();
    expect(
      await kit.prisma.playerLineAccount.count({
        where: { groupId: b.groupCode },
      }),
    ).toBeLessThanOrEqual(2);
  }

  describe('every refusal is the same bare 404', () => {
    for (const [name, send] of routes) {
      it(`${name}: no header, bad header, bad/no/repeated token, unknown session, a non-collector`, async () => {
        const b = await collectorBill();
        const baseline = await send(b, b.code, q(b.token), undefined);
        expect(baseline.status).toBe(404);
        expect(Object.keys(baseline.body).sort()).toEqual([
          'message',
          'statusCode',
        ]);

        // A verified viewer linked to another player of the bill: known to the group, but not its collector.
        const [other, otherUser] = viewer('Other');
        await kit.linkLine(b.groupCode, b.ids[1], otherUser);
        const flipped = (b.token[0] === 'A' ? 'B' : 'A') + b.token.slice(1);
        const cases: [string, () => request.Test][] = [
          [
            'unverifiable header',
            () => send(b, b.code, q(b.token), 'not-a-real-token'),
          ],
          ['bad pay token', () => send(b, b.code, q(flipped), b.access)],
          ['empty pay token', () => send(b, b.code, '?token=', b.access)],
          ['no pay token', () => send(b, b.code, '', b.access)],
          [
            'repeated token',
            () =>
              send(b, b.code, `?token=${b.token}&token=${b.token}`, b.access),
          ],
          [
            'unknown session',
            () => send(b, 'no-such-session', q(b.token), b.access),
          ],
          ['verified non-collector', () => send(b, b.code, q(b.token), other)],
        ];
        for (const [label, pending] of cases) {
          const res = await pending();
          expect({ label, status: res.status, body: res.body }).toEqual({
            label,
            status: 404,
            body: baseline.body,
          });
        }
        await untouched(b);
      });

      it(`${name}: the collector is refused once unlinked, on a lapsed plan, or with a reconfirmed card's old token`, async () => {
        const unlinked = await collectorBill();
        await kit.prisma.playerLineAccount.deleteMany({
          where: { groupId: unlinked.groupCode },
        });
        const lapsed = await collectorBill((await kit.owner('free')).id);
        const reconfirmed = await collectorBill();
        await kit.confirm(
          reconfirmed.code,
          randomUUID().replace(/-/g, '').slice(0, 22),
        );

        const baseline = await send(
          unlinked,
          unlinked.code,
          q(unlinked.token),
          undefined,
        );
        for (const [label, b] of [
          ['unlinked', unlinked],
          ['lapsed', lapsed],
          ['reconfirmed', reconfirmed],
        ] as const) {
          const res = await send(b, b.code, q(b.token), b.access);
          expect({ label, status: res.status, body: res.body }).toEqual({
            label,
            status: 404,
            body: baseline.body,
          });
          await untouched(b);
        }
      });
    }

    it('counts a refused collector request against the viewer: the eleventh is 429, and so is their status read', async () => {
      const b = await collectorBill();
      const [other] = viewer('Other');
      for (let i = 0; i < 10; i++)
        expect((await get(`${m(b.code)}${q(b.token)}`, other)).status).toBe(
          404,
        );
      expect((await get(`${m(b.code)}${q(b.token)}`, other)).status).toBe(429);
      expect((await status(b.code, q(b.token), other)).status).toBe(429);
      // The collector's own budget is untouched.
      expect((await get(`${m(b.code)}${q(b.token)}`, b.access)).status).toBe(
        200,
      );
    });

    it('has no route for links or update-name', async () => {
      const b = await collectorBill();
      expect(
        (
          await post(`${m(b.code)}/links${q(b.token)}`, b.access, {
            playerId: b.ids[1],
            lineUserId: null,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await post(
            `${m(b.code)}/waiting/${b.waitingId}/update-name${q(b.token)}`,
            b.access,
          )
        ).status,
      ).toBe(404);
      await untouched(b);
    });
  });

  describe('GET manage', () => {
    it('shows the collector the review panel, without LINE ids, the card token or links', async () => {
      const b = await collectorBill();
      await slips.tick(b.code, b.ids[2]);
      const res = await get(`${m(b.code)}${q(b.token)}`, b.access).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(Object.keys(res.body).sort()).toEqual([
        'accountName',
        'collection',
        'date',
        'duplicates',
        'groupName',
        'links',
        'paid',
        'rows',
        'waiting',
      ]);
      expect(res.body).toMatchObject({
        groupName: 'ตีชิล',
        accountName: 'สมหญิง ใจดี',
        links: [],
      });
      expect(res.body.date).toEqual(expect.any(String));
      expect(res.body.rows).toHaveLength(4);
      for (const row of res.body.rows)
        expect(Object.keys(row).sort()).toEqual([
          'absent',
          'amountSatang',
          'name',
          'playerId',
        ]);
      expect(res.body.paid).toEqual([
        expect.objectContaining({ playerId: b.ids[2], source: 'host' }),
      ]);
      expect(res.body.waiting).toEqual([
        expect.objectContaining({
          id: b.waitingId,
          imageId: b.imageId,
          displayName: 'Sender',
        }),
      ]);
      expect(res.body.duplicates).toEqual([
        expect.objectContaining({ id: b.duplicateId, displayName: 'Twice' }),
      ]);
      expect(res.body.collection).toEqual({
        closedAt: null,
        canClose: false,
        imageCount: 1,
      });
      expect(res.text).not.toContain('lineUserId');
      const senders = await kit.prisma.pendingSlip.findMany({
        where: { sessionId: b.code },
        select: { lineUserId: true },
      });
      for (const secret of [
        b.token,
        b.user.userId,
        ...senders.map((s) => s.lineUserId),
        '123-4-56789-0',
      ]) {
        expect(res.text).not.toContain(secret);
      }
    });
  });

  describe('GET image', () => {
    it('serves the slip image to the collector, with the host route headers, and never without the header', async () => {
      const b = await collectorBill();
      const url = `${m(b.code)}/images/${b.imageId}${q(b.token)}`;
      const image = await get(url, b.access).expect(200);
      expect(image.headers['content-type']).toContain('image/png');
      expect(image.headers['cache-control']).toBe('no-store');
      expect(image.headers['x-content-type-options']).toBe('nosniff');
      expect(image.headers['content-security-policy']).toBe(
        "default-src 'none'",
      );
      expect(Buffer.from(image.body)).toEqual(PNG);
      expect((await get(url)).status).toBe(404);
      expect(
        (
          await get(
            `${m(b.code)}/images/${randomUUID()}${q(b.token)}`,
            b.access,
          )
        ).status,
      ).toBe(404);
    });
  });

  describe('writes', () => {
    it('ticks as the collector and unticks', async () => {
      const b = await collectorBill();
      expect(
        (
          await post(`${m(b.code)}/tick${q(b.token)}`, b.access, {
            playerId: b.ids[1],
          }).expect(200)
        ).body,
      ).toEqual({ ok: true });
      expect(await slips.getPaid(b.code)).toEqual([
        expect.objectContaining({ playerId: b.ids[1], source: 'collector' }),
      ]);
      expect(
        (
          await post(`${m(b.code)}/untick${q(b.token)}`, b.access, {
            playerId: b.ids[1],
          }).expect(200)
        ).body,
      ).toEqual({ ok: true });
      expect(await slips.getPaid(b.code)).toEqual([]);
    });

    it("passes the service's refusals through", async () => {
      const b = await collectorBill();
      const res = await post(`${m(b.code)}/tick${q(b.token)}`, b.access, {
        playerId: 'not-on-bill',
      });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'PLAYER_NOT_ON_BILL' });
      expect(
        (await post(`${m(b.code)}/tick${q(b.token)}`, b.access, {})).status,
      ).toBe(400);
    });

    it('resolves a waiting slip but never links its sender', async () => {
      const b = await collectorBill();
      const links = await kit.prisma.playerLineAccount.count();
      await post(
        `${m(b.code)}/waiting/${b.waitingId}/resolve${q(b.token)}`,
        b.access,
        {
          coversPlayerIds: [b.ids[1]],
          senderPlayerId: b.ids[1],
        },
      ).expect(200);
      expect(
        await kit.prisma.sessionPayment.findMany({
          where: { sessionId: b.code },
        }),
      ).toEqual([
        expect.objectContaining({ playerId: b.ids[1], source: 'slip' }),
      ]);
      expect(await kit.prisma.playerLineAccount.count()).toBe(links);
      expect(
        (
          await kit.prisma.pendingSlip.findUniqueOrThrow({
            where: { id: b.waitingId },
          })
        ).resolvedAt,
      ).not.toBeNull();
    });

    it('dismisses a waiting slip and a duplicate; a second dismiss is the service 404', async () => {
      const b = await collectorBill();
      await post(
        `${m(b.code)}/waiting/${b.waitingId}/dismiss${q(b.token)}`,
        b.access,
      ).expect(200);
      await post(
        `${m(b.code)}/duplicates/${b.duplicateId}/dismiss${q(b.token)}`,
        b.access,
      ).expect(200);
      expect(
        (
          await kit.prisma.pendingSlip.findUniqueOrThrow({
            where: { id: b.waitingId },
          })
        ).resolvedAt,
      ).not.toBeNull();
      expect(
        (
          await kit.prisma.slipDuplicate.findUniqueOrThrow({
            where: { id: b.duplicateId },
          })
        ).dismissedAt,
      ).not.toBeNull();
      expect(
        (
          await post(
            `${m(b.code)}/waiting/${b.waitingId}/dismiss${q(b.token)}`,
            b.access,
          )
        ).status,
      ).toBe(404);
    });

    it('closes collection when ready; a later tick is COLLECTION_CLOSED', async () => {
      const b = await collectorBill();
      const close = () =>
        post(`${m(b.code)}/close${q(b.token)}`, b.access, {
          confirmDeleteImages: true,
        });
      expect((await close()).body).toMatchObject({
        code: 'COLLECTION_NOT_READY',
      });
      expect(
        (await post(`${m(b.code)}/close${q(b.token)}`, b.access, {})).status,
      ).toBe(400);
      await post(
        `${m(b.code)}/waiting/${b.waitingId}/dismiss${q(b.token)}`,
        b.access,
      ).expect(200);
      await post(
        `${m(b.code)}/duplicates/${b.duplicateId}/dismiss${q(b.token)}`,
        b.access,
      ).expect(200);
      for (const id of b.ids)
        await post(`${m(b.code)}/tick${q(b.token)}`, b.access, {
          playerId: id,
        }).expect(200);
      expect((await close().expect(200)).body).toEqual({ ok: true });
      expect(
        (
          await kit.prisma.session.findUniqueOrThrow({
            where: { code: b.code },
          })
        ).paymentCollectionClosedAt,
      ).not.toBeNull();
      expect(
        await kit.prisma.slipImage.count({ where: { sessionId: b.code } }),
      ).toBe(0);
      const tick = await post(`${m(b.code)}/untick${q(b.token)}`, b.access, {
        playerId: b.ids[1],
      });
      expect(tick.status).toBe(409);
      expect(tick.body).toMatchObject({ code: 'COLLECTION_CLOSED' });
      // The retry after a failed image purge is the same call.
      await close().expect(200);
    });

    it('a slip the collector would act on is still read from the real upload path', async () => {
      // Guards the fixture's shortcut: a slip that arrives through the pay page shows in the collector's panel too.
      const b = await collectorBill();
      const [sender] = viewer('Payer');
      kit.reader.read.mockResolvedValue(slipRead(newRef(), 28400));
      await request(kit.server)
        .post(`/sessions/${b.code}/slip-pay/upload${q(b.token)}`)
        .set(HEADER, sender)
        .set('Content-Type', 'image/png')
        .send(PNG)
        .expect(200);
      const res = await get(`${m(b.code)}${q(b.token)}`, b.access).expect(200);
      expect(res.body.waiting).toHaveLength(2);
      expect(res.text).not.toContain(users.get(sender)!.userId);
    });
  });

  describe('GET role', () => {
    it('says yes to the collector', async () => {
      const b = await collectorBill();
      const res = await role(b.code, q(b.token), b.access).expect(200);
      expect(res.body).toEqual({ collector: true });
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('says no to anyone else without counting it against them', async () => {
      const b = await collectorBill();
      const [other] = viewer('Other');
      for (let i = 0; i < 20; i++)
        expect(
          (await role(b.code, q(b.token), other).expect(200)).body,
        ).toEqual({ collector: false });
      await status(b.code, q(b.token), other).expect(200);
    });

    it('is the uniform 404 when the status gate fails', async () => {
      const b = await collectorBill();
      const baseline = await role(b.code, q(b.token));
      expect(baseline.status).toBe(404);
      const lapsed = await collectorBill((await kit.owner('free')).id);
      for (const res of [
        await role(b.code, q(b.token), 'not-a-real-token'),
        await role(b.code, '?token=wrong', b.access),
        await role('no-such-session', q(b.token), b.access),
        await role(lapsed.code, q(lapsed.token), lapsed.access),
      ])
        expect({ status: res.status, body: res.body }).toEqual({
          status: 404,
          body: baseline.body,
        });
    });
  });

  it('leaves the read-only status projection as it was, for the collector too', async () => {
    const b = await collectorBill();
    const res = await status(b.code, q(b.token), b.access).expect(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'closedAt',
      'pendingSlipCount',
      'rows',
      'sessionDate',
    ]);
    for (const row of res.body.rows)
      expect(Object.keys(row).sort()).toEqual([
        'amountChangedSince',
        'amountSatang',
        'name',
        'paid',
        'pending',
      ]);
  });
});
