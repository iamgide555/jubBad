import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import request from 'supertest';
import { DEFAULT_BILL_CONFIG } from '../../../engines/bill.ts';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { serializeBillConfig } from './bill-config.js';
import { serializeCheckoutBreakdown, serializeCheckoutSnapshot } from './checkout-pricing.js';
import { BillService } from './bill.service.js';
import { CheckoutService } from './checkout.service.js';
import { SessionLock } from './session-lock.js';
import { SessionsModule } from './sessions.module.js';
import { SessionsService } from './sessions.service.js';

describe('CheckoutController', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, SessionsModule] }).compile();
    app = moduleRef.createNestApplication();
    // No AuthModule here: a fixed admin caller stands in for AuthGuard, as in the other session specs.
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: 'checkout-spec-admin', role: 'admin' };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  const cfg = (over: Record<string, unknown> = {}) =>
    serializeBillConfig({ ...DEFAULT_BILL_CONFIG, walkInFeeSatang: 0, model: 'perShuttle', startingFeeSatang: 2000, ...over });

  /**
   * An advanced session with `n` roster players (P0..), a session shuttle price,
   * and helpers to log finished games with the shuttle numbers they used.
   */
  async function fixture(n: number, opts: { advanced?: boolean; priceSatang?: number | null; config?: string } = {}) {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    const advanced = opts.advanced ?? true;
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = [];
    for (let i = 0; i < n; i++) players.push(await prisma.player.create({ data: { groupId: groupCode, name: `P${i}`, aliases: '[]' } }));
    await prisma.session.create({
      data: {
        code: sessionCode, groupId: groupCode, courtCount: 2, rawImportText: '', shuttleToolsEnabled: advanced,
        shuttlePriceSatang: opts.priceSatang === undefined ? 12000 : opts.priceSatang,
        billConfig: opts.config ?? cfg(),
      },
    });
    for (const p of players) await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    const shuttles = new Map<number, string>();
    const shuttle = async (number: number) => {
      if (!shuttles.has(number)) shuttles.set(number, (await prisma.sessionShuttle.create({ data: { sessionId: sessionCode, number } })).id);
      return shuttles.get(number)!;
    };
    let matchNumber = 0;
    /** A finished game; `used` = shuttle numbers it used, `null` = log never recorded. */
    const finish = async (ids: string[], used: number[] | null) => {
      const pairing = await prisma.pairing.create({
        data: {
          sessionId: sessionCode, courtNumber: 1, matchNumber: ++matchNumber,
          teamA: JSON.stringify(ids.slice(0, ids.length / 2)), teamB: JSON.stringify(ids.slice(ids.length / 2)),
          confirmedAt: new Date(), endedAt: new Date(), winner: 'A', shuttleLogKnown: used !== null,
        },
      });
      for (const num of used ?? []) await prisma.pairingShuttleUse.create({ data: { pairingId: pairing.id, shuttleId: await shuttle(num) } });
      return pairing;
    };
    const pending = (ids: string[], confirmed: boolean) =>
      prisma.pairing.create({
        data: {
          sessionId: sessionCode, courtNumber: 2, matchNumber: ++matchNumber,
          teamA: JSON.stringify(ids.slice(0, 2)), teamB: JSON.stringify(ids.slice(2)),
          confirmedAt: confirmed ? new Date() : null,
        },
      });
    const cleanup = async () => {
      await prisma.sessionCheckout.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.pairingShuttleUse.deleteMany({ where: { pairing: { sessionId: sessionCode } } });
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionShuttle.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { groupId: groupCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    };
    const preview = (playerId: string, model: string) =>
      request(server).post(`/sessions/${sessionCode}/checkouts/${playerId}/preview`).send({ model });
    const confirm = (playerId: string, body: Record<string, unknown>) =>
      request(server).post(`/sessions/${sessionCode}/checkouts/${playerId}/confirm`).send(body);
    /** Preview then confirm, as the dialog does. */
    const settle = async (playerId: string, model = 'perGame', key: string = randomUUID()) => {
      const pv = await preview(playerId, model).expect(201);
      return confirm(playerId, { model, snapshotHash: pv.body.snapshotHash, idempotencyKey: key });
    };
    const list = () => request(server).get(`/sessions/${sessionCode}/checkouts`);
    const undo = (checkoutId: string) => request(server).post(`/sessions/${sessionCode}/checkouts/${checkoutId}/undo`).send({});
    const rosterRow = (playerId: string) =>
      prisma.sessionRoster.findUniqueOrThrow({ where: { sessionId_playerId: { sessionId: sessionCode, playerId } } });
    return { groupCode, sessionCode, players, finish, pending, preview, confirm, settle, list, undo, rosterRow, cleanup };
  }

  describe('checkout preview', () => {
    it('full: quotes the charge per distinct shuttle and reports the basis', async () => {
      const f = await fixture(7, { config: cfg({ shuttleCharge: 'full', perPlayerShuttleSatang: 3000 }) });
      try {
        const [p, a, b, c, d, e, g] = f.players.map((x) => x.id);
        await f.finish([p, a, b, c], [1]);
        await f.finish([p, d, e, g], [2, 3]);
        const res = await f.preview(p, 'perShuttle').expect(201);
        expect(res.body).toMatchObject({
          amountSatang: 2000 + 3 * 3000, shuttleCharge: 'full', chargeSatang: 3000,
          breakdown: { baseSatang: 2000, shuttleSatang: 9000 },
        });
      } finally {
        await f.cleanup();
      }
    });

    it('full with a blank charge follows the session price and says so', async () => {
      const f = await fixture(4, { config: cfg({ shuttleCharge: 'full', perPlayerShuttleSatang: null }) });
      try {
        const [p, a, b, c] = f.players.map((x) => x.id);
        await f.finish([p, a, b, c], [1]);
        const res = await f.preview(p, 'perShuttle').expect(201);
        expect(res.body).toMatchObject({ amountSatang: 2000 + 12000, shuttleCharge: 'full', chargeSatang: 12000 });
      } finally {
        await f.cleanup();
      }
    });

    it('shared reports its basis with no charge', async () => {
      const f = await fixture(4);
      try {
        const [p, a, b, c] = f.players.map((x) => x.id);
        await f.finish([p, a, b, c], [1]);
        const res = await f.preview(p, 'perShuttle').expect(201);
        expect(res.body).toMatchObject({ shuttleCharge: 'shared', chargeSatang: null });
      } finally {
        await f.cleanup();
      }
    });

    it('full: a leaver does not move another player\'s quote', async () => {
      const f = await fixture(7, { config: cfg({ shuttleCharge: 'full', perPlayerShuttleSatang: 3000 }) });
      try {
        const [p, a, b, c, d, e, g] = f.players.map((x) => x.id);
        await f.finish([p, a, b, c], [1]);
        await f.finish([d, e, g, a], [2]);
        const before = (await f.preview(e, 'perShuttle').expect(201)).body.amountSatang;
        expect((await f.settle(p, 'perShuttle')).status).toBe(201);
        const after = (await f.preview(e, 'perShuttle').expect(201)).body.amountSatang;
        expect(after).toBe(before);
      } finally {
        await f.cleanup();
      }
    });

    it('changing the charge makes an open quote stale', async () => {
      const f = await fixture(4, { config: cfg({ shuttleCharge: 'full', perPlayerShuttleSatang: 3000 }) });
      try {
        const [p, a, b, c] = f.players.map((x) => x.id);
        await f.finish([p, a, b, c], [1]);
        const pv = await f.preview(p, 'perShuttle').expect(201);
        await prisma.session.update({
          where: { code: f.sessionCode },
          data: { billConfig: cfg({ shuttleCharge: 'full', perPlayerShuttleSatang: 4000 }) },
        });
        const res = await f.confirm(p, { model: 'perShuttle', snapshotHash: pv.body.snapshotHash, idempotencyKey: randomUUID() });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('CHECKOUT_STALE');
      } finally {
        await f.cleanup();
      }
    });

    it('prices a shuttle reused across two finished games once, split game then player', async () => {
      const f = await fixture(8);
      try {
        const [p, a, b, c, d, e, g, h] = f.players.map((x) => x.id);
        await f.finish([p, a, b, c], [1]);
        await f.finish([d, e, g, h], [1]); // same physical shuttle, second game
        const res = await f.preview(p, 'perShuttle').expect(201);
        // 12000 once, 6000 per game, 1500 each; plus the 2000 starting fee.
        expect(res.body).toMatchObject({
          playerId: p, model: 'perShuttle', games: 1, amountSatang: 3500,
          breakdown: { baseSatang: 2000, shuttleSatang: 1500, hostFeeSatang: 0, walkInFeeSatang: 0, discountSatang: 0 },
        });
        expect(res.body.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        await f.cleanup();
      }
    });

    it('a player in both games gets both game shares; the starting fee applies once', async () => {
      const f = await fixture(7);
      try {
        const [p, a, b, c, d, e, g] = f.players.map((x) => x.id);
        await f.finish([p, a, b, c], [1]);
        await f.finish([p, d, e, g], [1]);
        const res = await f.preview(p, 'perShuttle').expect(201);
        expect(res.body.games).toBe(2);
        expect(res.body.breakdown.shuttleSatang).toBe(3000);
      } finally {
        await f.cleanup();
      }
    });

    it('zero games: only the starting fee, even with no shuttle price set', async () => {
      const f = await fixture(5, { priceSatang: null });
      try {
        const res = await f.preview(f.players[4].id, 'perShuttle').expect(201);
        expect(res.body).toMatchObject({ games: 0, amountSatang: 2000 });
      } finally {
        await f.cleanup();
      }
    });

    it('a game recorded as using no shuttle needs no price and adds nothing', async () => {
      const f = await fixture(4, { priceSatang: null });
      try {
        await f.finish(f.players.map((x) => x.id), []);
        const res = await f.preview(f.players[0].id, 'perShuttle').expect(201);
        expect(res.body).toMatchObject({ games: 1, amountSatang: 2000 });
      } finally {
        await f.cleanup();
      }
    });

    it('an unknown log in the player\'s own game blocks with an actionable code', async () => {
      const f = await fixture(4);
      try {
        await f.finish(f.players.map((x) => x.id), null);
        const res = await f.preview(f.players[0].id, 'perShuttle').expect(409);
        expect(res.body.code).toBe('UNKNOWN_SHUTTLE_USE');
      } finally {
        await f.cleanup();
      }
    });

    it('a missing price blocks when use is priced, while a price of 0 is valid', async () => {
      const f = await fixture(4, { priceSatang: null });
      try {
        await f.finish(f.players.map((x) => x.id), [1]);
        const blocked = await f.preview(f.players[0].id, 'perShuttle').expect(409);
        expect(blocked.body.code).toBe('MISSING_SHUTTLE_PRICE');
        await prisma.session.update({ where: { code: f.sessionCode }, data: { shuttlePriceSatang: 0 } });
        const free = await f.preview(f.players[0].id, 'perShuttle').expect(201);
        expect(free.body.amountSatang).toBe(2000);
      } finally {
        await f.cleanup();
      }
    });

    it('perGame uses the entry fee, rate and cap; buffet uses its flat price and excluded shuttles', async () => {
      const f = await fixture(4, { config: cfg({ model: 'fair', entryFeeSatang: 1000, perGameRateSatang: 2000, capSatang: 4000, buffetPriceSatang: 8000, buffetShuttlesIncluded: false }) });
      try {
        await f.finish(f.players.map((x) => x.id), [1]);
        await f.finish(f.players.map((x) => x.id), [2]);
        await f.finish(f.players.map((x) => x.id), [3]);
        const pg = await f.preview(f.players[0].id, 'perGame').expect(201);
        expect(pg.body).toMatchObject({ games: 3, amountSatang: 4000 }); // 1000 + 3*2000 capped
        const bf = await f.preview(f.players[0].id, 'buffet').expect(201);
        // three shuttles of 12000, each in one game of 4 -> 3000 per shuttle share.
        expect(bf.body.breakdown).toMatchObject({ baseSatang: 8000, shuttleSatang: 9000 });
        expect(bf.body.amountSatang).toBe(17000);
      } finally {
        await f.cleanup();
      }
    });

    it('refuses an early checkout priced as fair, and an unknown model, at the door', async () => {
      const f = await fixture(4);
      try {
        await f.preview(f.players[0].id, 'fair').expect(400);
        await f.preview(f.players[0].id, 'nonsense').expect(400);
      } finally {
        await f.cleanup();
      }
    });

    it('an ordinary session answers CHECKOUT_DISABLED from the API, not just the hidden UI', async () => {
      const f = await fixture(4, { advanced: false });
      try {
        const res = await f.preview(f.players[0].id, 'perGame').expect(400);
        expect(res.body.code).toBe('CHECKOUT_DISABLED');
      } finally {
        await f.cleanup();
      }
    });

    it('an ended session refuses with SESSION_ENDED', async () => {
      const f = await fixture(4);
      try {
        await prisma.session.update({ where: { code: f.sessionCode }, data: { endedAt: new Date() } });
        const res = await f.preview(f.players[0].id, 'perGame').expect(409);
        expect(res.body.code).toBe('SESSION_ENDED');
      } finally {
        await f.cleanup();
      }
    });

    it('a player not on this roster (or another group\'s player) is a 404, unknown session too', async () => {
      const f = await fixture(4);
      const other = await fixture(4);
      try {
        const res = await f.preview(other.players[0].id, 'perGame').expect(404);
        expect(res.body.code).toBe('PLAYER_NOT_ON_ROSTER');
        await request(server).post(`/sessions/${randomUUID()}/checkouts/${f.players[0].id}/preview`).send({ model: 'perGame' }).expect(404);
      } finally {
        await f.cleanup();
        await other.cleanup();
      }
    });

    it('a player on a pending or active court must be cleared first, with the court named', async () => {
      const f = await fixture(8);
      try {
        const ids = f.players.map((x) => x.id);
        const pend = await f.pending(ids.slice(0, 4), false);
        const res = await f.preview(ids[0], 'perGame').expect(409);
        expect(res.body).toMatchObject({ code: 'PLAYER_ON_COURT', courtNumber: 2 });
        // The lineup is untouched.
        expect((await prisma.pairing.findUniqueOrThrow({ where: { id: pend.id } })).teamA).toBe(JSON.stringify(ids.slice(0, 2)));
        await prisma.pairing.update({ where: { id: pend.id }, data: { confirmedAt: new Date() } });
        expect((await f.preview(ids[1], 'perGame').expect(409)).body.code).toBe('PLAYER_ON_COURT');
        await f.preview(ids[7], 'perGame').expect(201);
      } finally {
        await f.cleanup();
      }
    });

    it('a player already checked out cannot be quoted again; an undone receipt does not block', async () => {
      const f = await fixture(4);
      try {
        const rec = (key: string, extra: Record<string, unknown> = {}) => ({
          sessionId: f.sessionCode, playerId: f.players[0].id, model: 'perGame', amountSatang: 100, idempotencyKey: key,
          breakdown: serializeCheckoutBreakdown({ baseSatang: 100, shuttleSatang: 0, hostFeeSatang: 0, walkInFeeSatang: 0, discountSatang: 0 }),
          snapshot: serializeCheckoutSnapshot({ version: 1, hash: 'h', games: 0, shuttleIds: [], shuttlePriceSatang: null, walkIn: false }),
          ...extra,
        });
        await prisma.sessionCheckout.create({ data: rec('undone', { undoneAt: new Date() }) });
        await f.preview(f.players[0].id, 'perGame').expect(201);
        await prisma.sessionCheckout.create({ data: rec('live') });
        const res = await f.preview(f.players[0].id, 'perGame').expect(409);
        expect(res.body.code).toBe('PLAYER_CHECKED_OUT');
      } finally {
        await f.cleanup();
      }
    });

    it('previewing changes neither the roster nor the ledger', async () => {
      const f = await fixture(4);
      try {
        await f.finish(f.players.map((x) => x.id), [1]);
        const before = await prisma.sessionRoster.findMany({ where: { sessionId: f.sessionCode }, orderBy: { playerId: 'asc' } });
        await f.preview(f.players[0].id, 'perShuttle').expect(201);
        await f.preview(f.players[0].id, 'perGame').expect(201);
        expect(await prisma.sessionCheckout.count({ where: { sessionId: f.sessionCode } })).toBe(0);
        expect(await prisma.sessionRoster.findMany({ where: { sessionId: f.sessionCode }, orderBy: { playerId: 'asc' } })).toEqual(before);
      } finally {
        await f.cleanup();
      }
    });

    it('the snapshot hash is stable for identical inputs and moves with price, config, games and receipts', async () => {
      const f = await fixture(8);
      try {
        const [p, a, b, c, d, e, g, h] = f.players.map((x) => x.id);
        await f.finish([p, a, b, c], [1]);
        const h1 = (await f.preview(p, 'perShuttle').expect(201)).body.snapshotHash;
        expect((await f.preview(p, 'perShuttle').expect(201)).body.snapshotHash).toBe(h1);
        expect((await f.preview(p, 'perGame').expect(201)).body.snapshotHash).not.toBe(h1);
        await prisma.session.update({ where: { code: f.sessionCode }, data: { shuttlePriceSatang: 12100 } });
        const h2 = (await f.preview(p, 'perShuttle').expect(201)).body.snapshotHash;
        expect(h2).not.toBe(h1);
        await prisma.session.update({ where: { code: f.sessionCode }, data: { billConfig: cfg({ startingFeeSatang: 2500 }) } });
        const h3 = (await f.preview(p, 'perShuttle').expect(201)).body.snapshotHash;
        expect(h3).not.toBe(h2);
        await f.finish([d, e, g, h], [1]);
        const h4 = (await f.preview(p, 'perShuttle').expect(201)).body.snapshotHash;
        expect(h4).not.toBe(h3);
        await prisma.sessionCheckout.create({
          data: {
            sessionId: f.sessionCode, playerId: a, model: 'perGame', amountSatang: 500, idempotencyKey: 'x',
            breakdown: serializeCheckoutBreakdown({ baseSatang: 500, shuttleSatang: 0, hostFeeSatang: 0, walkInFeeSatang: 0, discountSatang: 0 }),
            snapshot: serializeCheckoutSnapshot({ version: 1, hash: 'h', games: 0, shuttleIds: [], shuttlePriceSatang: null, walkIn: false }),
          },
        });
        expect((await f.preview(p, 'perShuttle').expect(201)).body.snapshotHash).not.toBe(h4);
      } finally {
        await f.cleanup();
      }
    });
  });

  describe('checkout settlement', () => {
    it('confirming freezes the quoted amount and takes the player off the roster', async () => {
      const f = await fixture(5, { config: cfg({ model: 'fair', entryFeeSatang: 1000, perGameRateSatang: 2000 }) });
      try {
        await f.finish(f.players.slice(0, 4).map((x) => x.id), [1]);
        const pv = await f.preview(f.players[0].id, 'perGame').expect(201);
        const res = await f.confirm(f.players[0].id, { model: 'perGame', snapshotHash: pv.body.snapshotHash, idempotencyKey: 'k1' }).expect(201);
        expect(res.body).toMatchObject({ playerId: f.players[0].id, model: 'perGame', amountSatang: pv.body.amountSatang, breakdown: pv.body.breakdown });
        expect(res.body.id).toEqual(expect.any(String));
        expect(res.body.settledAt).toEqual(expect.any(String));
        expect((await f.rosterRow(f.players[0].id)).active).toBe(false);
        const row = await prisma.sessionCheckout.findUniqueOrThrow({ where: { id: res.body.id } });
        expect(row).toMatchObject({ amountSatang: pv.body.amountSatang, undoneAt: null, idempotencyKey: 'k1', model: 'perGame' });
        expect(JSON.parse(row.snapshot)).toMatchObject({ version: 1, hash: pv.body.snapshotHash, games: 1 });
      } finally {
        await f.cleanup();
      }
    });

    it('a pending or active court refuses settlement without touching the lineup; it succeeds once cleared', async () => {
      const f = await fixture(8);
      try {
        const ids = f.players.map((x) => x.id);
        const pend = await f.pending(ids.slice(0, 4), true);
        const res = await f.confirm(ids[0], { model: 'perGame', snapshotHash: 'a'.repeat(64), idempotencyKey: 'k' }).expect(409);
        expect(res.body).toMatchObject({ code: 'PLAYER_ON_COURT', courtNumber: 2 });
        expect((await prisma.pairing.findUniqueOrThrow({ where: { id: pend.id } })).teamA).toBe(JSON.stringify(ids.slice(0, 2)));
        expect((await f.rosterRow(ids[0])).active).toBe(true);
        await prisma.pairing.update({ where: { id: pend.id }, data: { endedAt: new Date(), winner: null } }); // "no result"
        await f.settle(ids[0]).then((r) => expect(r.status).toBe(201));
      } finally {
        await f.cleanup();
      }
    });

    it.each([
      ['shuttle price', (f: Awaited<ReturnType<typeof fixture>>) => prisma.session.update({ where: { code: f.sessionCode }, data: { shuttlePriceSatang: 13000 } })],
      ['bill config', (f: Awaited<ReturnType<typeof fixture>>) => prisma.session.update({ where: { code: f.sessionCode }, data: { billConfig: cfg({ startingFeeSatang: 2500 }) } })],
      ['walk-in mark', (f: Awaited<ReturnType<typeof fixture>>) => prisma.sessionRoster.updateMany({ where: { sessionId: f.sessionCode, playerId: f.players[1].id }, data: { walkIn: true } })],
      ['a billing override', (f: Awaited<ReturnType<typeof fixture>>) =>
        prisma.session.update({ where: { code: f.sessionCode }, data: { billConfig: cfg({ overrides: [{ playerId: f.players[0].id, amountSatang: 1 }] }) } })],
    ])('a changed %s between preview and confirm is CHECKOUT_STALE with no side effects', async (_name, change) => {
      const f = await fixture(5);
      try {
        await f.finish(f.players.slice(0, 4).map((x) => x.id), [1]);
        const pv = await f.preview(f.players[0].id, 'perShuttle').expect(201);
        await change(f);
        const res = await f.confirm(f.players[0].id, { model: 'perShuttle', snapshotHash: pv.body.snapshotHash, idempotencyKey: 'k' }).expect(409);
        expect(res.body.code).toBe('CHECKOUT_STALE');
        expect(await prisma.sessionCheckout.count({ where: { sessionId: f.sessionCode } })).toBe(0);
        expect((await f.rosterRow(f.players[0].id)).active).toBe(true);
      } finally {
        await f.cleanup();
      }
    });

    it('a game finished, or a shuttle use corrected, between preview and confirm is stale', async () => {
      const f = await fixture(8);
      try {
        const ids = f.players.map((x) => x.id);
        const g = await f.finish(ids.slice(0, 4), [1]);
        const pv = await f.preview(ids[0], 'perShuttle').expect(201);
        await f.finish(ids.slice(4), [2]);
        expect((await f.confirm(ids[0], { model: 'perShuttle', snapshotHash: pv.body.snapshotHash, idempotencyKey: 'a' })).body.code).toBe('CHECKOUT_STALE');
        const pv2 = await f.preview(ids[0], 'perShuttle').expect(201);
        await prisma.pairingShuttleUse.deleteMany({ where: { pairingId: g.id } });
        await prisma.pairing.update({ where: { id: g.id }, data: { revision: { increment: 1 } } });
        expect((await f.confirm(ids[0], { model: 'perShuttle', snapshotHash: pv2.body.snapshotHash, idempotencyKey: 'b' })).body.code).toBe('CHECKOUT_STALE');
        expect(await prisma.sessionCheckout.count({ where: { sessionId: f.sessionCode } })).toBe(0);
      } finally {
        await f.cleanup();
      }
    });

    it('an earlier settlement between preview and confirm makes the other leaver\'s quote stale', async () => {
      const f = await fixture(8);
      try {
        const ids = f.players.map((x) => x.id);
        await f.finish(ids.slice(0, 4), [1]);
        const pvA = await f.preview(ids[0], 'perShuttle').expect(201);
        await f.settle(ids[1], 'perShuttle').then((r) => expect(r.status).toBe(201));
        const res = await f.confirm(ids[0], { model: 'perShuttle', snapshotHash: pvA.body.snapshotHash, idempotencyKey: 'late' }).expect(409);
        expect(res.body.code).toBe('CHECKOUT_STALE');
      } finally {
        await f.cleanup();
      }
    });

    it('retrying the same key returns the same receipt and never a second ledger entry', async () => {
      const f = await fixture(5);
      try {
        const first = await f.settle(f.players[0].id, 'perGame', 'retry-key').then((r) => r.body);
        const again = await f.confirm(f.players[0].id, { model: 'perGame', snapshotHash: 'd'.repeat(64) /* ignored on a replay */, idempotencyKey: 'retry-key' }).expect(201);
        expect(again.body.id).toBe(first.id);
        expect(again.body.amountSatang).toBe(first.amountSatang);
        expect(await prisma.sessionCheckout.count({ where: { sessionId: f.sessionCode } })).toBe(1);
        // The same key for someone else is a client bug, not a replay.
        const clash = await f.confirm(f.players[1].id, { model: 'perGame', snapshotHash: 'b'.repeat(64), idempotencyKey: 'retry-key' }).expect(409);
        expect(clash.body.code).toBe('CHECKOUT_KEY_REUSED');
        expect((await f.rosterRow(f.players[1].id)).active).toBe(true);
      } finally {
        await f.cleanup();
      }
    });

    it('two different keys racing for one player leave one active receipt and one inactive roster row', async () => {
      const f = await fixture(5);
      try {
        const pv = await f.preview(f.players[0].id, 'perGame').expect(201);
        const body = (idempotencyKey: string) => ({ model: 'perGame', snapshotHash: pv.body.snapshotHash, idempotencyKey });
        const results = await Promise.all(Array.from({ length: 5 }, (_, i) => f.confirm(f.players[0].id, body(`race-${i}`))));
        expect(results.filter((r) => r.status === 201)).toHaveLength(1);
        for (const r of results.filter((x) => x.status !== 201)) expect(r.body.code).toBe('PLAYER_CHECKED_OUT');
        expect(await prisma.sessionCheckout.count({ where: { sessionId: f.sessionCode, undoneAt: null } })).toBe(1);
        expect((await f.rosterRow(f.players[0].id)).active).toBe(false);
      } finally {
        await f.cleanup();
      }
    });

    it('a failed write leaves both the ledger and the roster unchanged', async () => {
      const f = await fixture(5);
      try {
        const pv = await f.preview(f.players[0].id, 'perGame').expect(201);
        const real = prisma.$transaction.bind(prisma) as (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
        const spy = vi.spyOn(prisma, '$transaction').mockImplementationOnce(((fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
          real((tx) =>
            fn(
              new Proxy(tx as Record<string, unknown>, {
                get(target, prop) {
                  if (prop === 'sessionRoster') {
                    return new Proxy(target[prop] as Record<string, unknown>, {
                      get(rt, rp) {
                        if (rp === 'updateMany' || rp === 'update') return () => { throw new Error('disk full'); };
                        return rt[rp as string];
                      },
                    });
                  }
                  return target[prop as string];
                },
              })
            )
          )) as never);
        try {
          await f.confirm(f.players[0].id, { model: 'perGame', snapshotHash: pv.body.snapshotHash, idempotencyKey: 'boom' }).expect(500);
        } finally {
          spy.mockRestore();
        }
        expect(await prisma.sessionCheckout.count({ where: { sessionId: f.sessionCode } })).toBe(0);
        expect((await f.rosterRow(f.players[0].id)).active).toBe(true);
        // The player can still be settled afterwards.
        await f.settle(f.players[0].id).then((r) => expect(r.status).toBe(201));
      } finally {
        await f.cleanup();
      }
    });

    it('an ordinary session answers CHECKOUT_DISABLED for confirm, list and undo', async () => {
      const f = await fixture(4, { advanced: false });
      try {
        const body = { model: 'perGame', snapshotHash: 'a'.repeat(64), idempotencyKey: 'k' };
        expect((await f.confirm(f.players[0].id, body).expect(400)).body.code).toBe('CHECKOUT_DISABLED');
        expect((await f.list().expect(400)).body.code).toBe('CHECKOUT_DISABLED');
      } finally {
        await f.cleanup();
      }
    });

    it('rejects fair, a missing key and a malformed hash before touching anything', async () => {
      const f = await fixture(4);
      try {
        const ok = { model: 'perGame', snapshotHash: 'a'.repeat(64), idempotencyKey: 'k' };
        await f.confirm(f.players[0].id, { ...ok, model: 'fair' }).expect(400);
        await f.confirm(f.players[0].id, { model: ok.model, snapshotHash: ok.snapshotHash }).expect(400);
        await f.confirm(f.players[0].id, { ...ok, idempotencyKey: '' }).expect(400);
        await f.confirm(f.players[0].id, { ...ok, snapshotHash: 'short' }).expect(400);
      } finally {
        await f.cleanup();
      }
    });

    it('the list shows current receipts only, stays readable after the session ends, and a settled amount survives later price and config edits', async () => {
      const f = await fixture(5);
      try {
        await f.finish(f.players.slice(0, 4).map((x) => x.id), [1]);
        const a = (await f.settle(f.players[0].id, 'perShuttle')).body;
        const b = (await f.settle(f.players[1].id, 'perShuttle')).body;
        await f.undo(b.id).expect(201);
        await prisma.session.update({ where: { code: f.sessionCode }, data: { shuttlePriceSatang: 99900, billConfig: cfg({ startingFeeSatang: 9000 }) } });
        await prisma.session.update({ where: { code: f.sessionCode }, data: { endedAt: new Date() } });
        const res = await f.list().expect(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0]).toMatchObject({ id: a.id, playerId: f.players[0].id, model: 'perShuttle', amountSatang: a.amountSatang, breakdown: a.breakdown });
        expect(res.body[0].settledAt).toEqual(expect.any(String));
        expect(res.body[0]).not.toHaveProperty('snapshot');
        expect(res.body[0]).not.toHaveProperty('idempotencyKey');
        const late = await f.confirm(f.players[2].id, { model: 'perGame', snapshotHash: 'e'.repeat(64), idempotencyKey: 'after-end' }).expect(409);
        expect(late.body.code).toBe('SESSION_ENDED');
      } finally {
        await f.cleanup();
      }
    });

    it('shares one lock between sessions, bill and checkout writes', async () => {
      const lock = app.get(SessionLock);
      for (const svc of [app.get(SessionsService), app.get(BillService), app.get(CheckoutService)]) {
        expect((svc as unknown as { lock: SessionLock }).lock).toBe(lock);
      }
    });
  });

  describe('checkout roster', () => {
    const settled = async (n = 5) => {
      const f = await fixture(n);
      const receipt = (await f.settle(f.players[0].id)).body;
      return { f, receipt, leaver: f.players[0].id };
    };

    it('the ordinary rest toggle cannot bring a settled leaver back, either direction', async () => {
      const { f, leaver } = await settled();
      try {
        for (const active of [true, false]) {
          const res = await request(server).post(`/sessions/${f.sessionCode}/roster/${leaver}/active`).send({ active }).expect(409);
          expect(res.body.code).toBe('PLAYER_CHECKED_OUT');
        }
        expect((await f.rosterRow(leaver)).active).toBe(false);
      } finally {
        await f.cleanup();
      }
    });

    it('a resting player is not the same as a settled one: the toggle still works for them', async () => {
      const f = await fixture(5);
      try {
        const id = f.players[1].id;
        await request(server).post(`/sessions/${f.sessionCode}/roster/${id}/active`).send({ active: false }).expect(201);
        await request(server).post(`/sessions/${f.sessionCode}/roster/${id}/active`).send({ active: true }).expect(201);
        expect((await f.rosterRow(id)).active).toBe(true);
      } finally {
        await f.cleanup();
      }
    });

    it('manual seating and confirming a proposal that holds a settled leaver are refused', async () => {
      const { f, leaver } = await settled(8);
      try {
        const ids = f.players.map((x) => x.id);
        const draft = await f.pending([ids[1], ids[2], ids[3], ids[4]], false);
        const seat = await request(server)
          .post(`/sessions/${f.sessionCode}/pairings/${draft.id}/seats`)
          .send({ team: 'A', index: 0, playerId: leaver }).expect(409);
        expect(['PLAYER_UNAVAILABLE', 'PLAYER_CHECKED_OUT']).toContain(seat.body.code);
        // A stale proposal that still names them cannot start either.
        const stale = await prisma.pairing.update({
          where: { id: draft.id },
          data: { teamA: JSON.stringify([leaver, ids[2]]), pendingSince: new Date() },
        });
        const confirm = await request(server)
          .post(`/sessions/${f.sessionCode}/pairings/${stale.id}/confirm`)
          .send({ shuttle: { kind: 'new' } }).expect(409);
        expect(confirm.body.code).toBe('PLAYER_UNAVAILABLE');
      } finally {
        await f.cleanup();
      }
    });

    it('auto-confirm never starts a proposal that still names a settled leaver', async () => {
      const { f, leaver } = await settled(8);
      try {
        const ids = f.players.map((x) => x.id);
        const draft = await f.pending([leaver, ids[1], ids[2], ids[3]], false);
        await prisma.pairing.update({ where: { id: draft.id }, data: { pendingSince: new Date(Date.now() - 120_000) } });
        const confirmed = await app.get(SessionsService).autoConfirmDue(new Date(Date.now() + 600_000));
        expect(confirmed).not.toContain(draft.id);
        expect((await prisma.pairing.findUniqueOrThrow({ where: { id: draft.id } })).confirmedAt).toBeNull();
      } finally {
        await f.cleanup();
      }
    });

    it('adding the settled leaver again as a walk-in is a duplicate and changes nothing', async () => {
      const { f, leaver } = await settled();
      try {
        const res = await request(server).post(`/sessions/${f.sessionCode}/roster`).send({ playerId: leaver }).expect(409);
        expect(res.body.code).toBe('ROSTER_DUPLICATE');
        expect((await f.rosterRow(leaver)).active).toBe(false);
      } finally {
        await f.cleanup();
      }
    });

    it('court fills never seat a settled leaver', async () => {
      const f = await fixture(9);
      try {
        const leaver = f.players[0].id;
        await f.settle(leaver).then((r) => expect(r.status).toBe(201));
        await request(server).post(`/sessions/${f.sessionCode}/courts/fill`).send({}).expect(201);
        const open = await prisma.pairing.findMany({ where: { sessionId: f.sessionCode } });
        expect(open.length).toBeGreaterThan(0);
        for (const p of open) expect(`${p.teamA}${p.teamB}`).not.toContain(leaver);
      } finally {
        await f.cleanup();
      }
    });
  });

  describe('checkout undo', () => {
    it('marks the receipt undone, restores availability with the rotation credit and keeps the audit row', async () => {
      const f = await fixture(5);
      try {
        const ids = f.players.map((x) => x.id);
        await f.finish(ids.slice(0, 4), [1]);
        await f.finish(ids.slice(0, 4), [1]);
        const leaver = ids[4]; // zero games while the others are on two
        const receipt = (await f.settle(leaver)).body;
        const before = await f.rosterRow(leaver);
        const res = await f.undo(receipt.id).expect(201);
        expect(res.body).toMatchObject({ ok: true, playerId: leaver });
        const row = await prisma.sessionCheckout.findUniqueOrThrow({ where: { id: receipt.id } });
        expect(row.undoneAt).not.toBeNull();
        const after = await f.rosterRow(leaver);
        expect(after.active).toBe(true);
        expect(after.gamesOffset).toBe(2); // brought level with the most-played active player
        expect(after.gamesOffset).toBeGreaterThanOrEqual(before.gamesOffset);
        expect(after.activatedAt!.getTime()).toBeGreaterThanOrEqual((before.activatedAt ?? new Date(0)).getTime());
        expect((await f.list().expect(200)).body).toEqual([]);
        expect(await prisma.sessionCheckout.count({ where: { sessionId: f.sessionCode } })).toBe(1);
      } finally {
        await f.cleanup();
      }
    });

    it('a second undo, an unknown id, another session\'s receipt and undo after the end are all refused', async () => {
      const f = await fixture(5);
      const other = await fixture(5);
      try {
        const mine = (await f.settle(f.players[0].id)).body;
        const theirs = (await other.settle(other.players[0].id)).body;
        await f.undo(mine.id).expect(201);
        expect((await f.undo(mine.id).expect(409)).body.code).toBe('CHECKOUT_UNDONE');
        expect((await f.undo('does-not-exist').expect(404)).body.code).toBe('CHECKOUT_NOT_FOUND');
        expect((await f.undo(theirs.id).expect(404)).body.code).toBe('CHECKOUT_NOT_FOUND');
        expect((await other.rosterRow(other.players[0].id)).active).toBe(false);
        const live = (await f.settle(f.players[1].id)).body;
        await prisma.session.update({ where: { code: f.sessionCode }, data: { endedAt: new Date() } });
        expect((await f.undo(live.id).expect(409)).body.code).toBe('SESSION_ENDED');
        expect((await f.rosterRow(f.players[1].id)).active).toBe(false);
      } finally {
        await f.cleanup();
        await other.cleanup();
      }
    });

    it('after an undo the same player can be checked out again under a new key', async () => {
      const f = await fixture(5);
      try {
        const first = (await f.settle(f.players[0].id, 'perGame', 'one')).body;
        await f.undo(first.id).expect(201);
        const second = (await f.settle(f.players[0].id, 'perGame', 'two')).body;
        expect(second.id).not.toBe(first.id);
        expect(await prisma.sessionCheckout.count({ where: { sessionId: f.sessionCode } })).toBe(2);
        expect(await prisma.sessionCheckout.count({ where: { sessionId: f.sessionCode, undoneAt: null } })).toBe(1);
        expect((await f.rosterRow(f.players[0].id)).active).toBe(false);
        // Replaying the first, undone key does not resurrect it.
        const replay = await f.confirm(f.players[0].id, { model: 'perGame', snapshotHash: 'c'.repeat(64), idempotencyKey: 'one' }).expect(409);
        expect(replay.body.code).toBe('CHECKOUT_UNDONE');
        expect(await prisma.sessionCheckout.count({ where: { sessionId: f.sessionCode, undoneAt: null } })).toBe(1);
      } finally {
        await f.cleanup();
      }
    });
  });

  describe('checkout bill', () => {
    const bill = (code: string) => request(server).get(`/sessions/${code}/bill`);
    const setCfg = (code: string, over: Record<string, unknown>) =>
      prisma.session.update({ where: { code }, data: { billConfig: cfg(over) } });

    it('a settled leaver is one settled row, absent from still-due, with exact totals', async () => {
      const f = await fixture(8, { config: cfg({ model: 'perShuttle', startingFeeSatang: 3000 }) });
      try {
        const ids = f.players.map((x) => x.id);
        await f.finish(ids.slice(0, 4), [1]);
        await f.finish(ids.slice(4), [1]);
        const r = (await f.settle(ids[0], 'perShuttle')).body;
        expect(r.amountSatang).toBe(4500);
        const b = (await bill(f.sessionCode).expect(200)).body;
        expect(b.settled).toEqual([expect.objectContaining({ id: r.id, playerId: ids[0], name: 'P0', model: 'perShuttle', amountSatang: 4500 })]);
        expect(b.result.rows.map((x: { playerId: string }) => x.playerId)).not.toContain(ids[0]);
        expect(b.result.rows).toHaveLength(7);
        expect(b.result.totals).toMatchObject({ settledTotalSatang: 4500, stillDueSatang: 7 * 4500, collectedSatang: 8 * 4500, excessCreditSatang: 0, uncoveredCostSatang: 0 });
        expect(b.readyToCopy).toBe(true);
      } finally {
        await f.cleanup();
      }
    });

    it('the receipt keeps its model and amount when the final model, price or config change; removedIds cannot resurrect it', async () => {
      const f = await fixture(8, { config: cfg({ model: 'perShuttle', startingFeeSatang: 3000 }) });
      try {
        const ids = f.players.map((x) => x.id);
        await f.finish(ids.slice(0, 4), [1]);
        await f.finish(ids.slice(4), [1]);
        const r = (await f.settle(ids[0], 'perShuttle')).body;
        await setCfg(f.sessionCode, { model: 'perGame', entryFeeSatang: 1000, perGameRateSatang: 500, removedIds: [ids[0]], overrides: [{ playerId: ids[0], amountSatang: 1 }] });
        await prisma.session.update({ where: { code: f.sessionCode }, data: { shuttlePriceSatang: 50000 } });
        const b = (await bill(f.sessionCode).expect(200)).body;
        expect(b.settled[0]).toMatchObject({ id: r.id, model: 'perShuttle', amountSatang: 4500 });
        expect(b.result.rows.map((x: { playerId: string }) => x.playerId)).not.toContain(ids[0]);
        expect(b.result.totals.settledTotalSatang).toBe(4500);
      } finally {
        await f.cleanup();
      }
    });

    it('a later reuse of the same physical shuttle changes nothing already settled and is still charged once', async () => {
      const f = await fixture(12, { config: cfg({ model: 'perShuttle', startingFeeSatang: 3000 }) });
      try {
        const ids = f.players.map((x) => x.id);
        await f.finish(ids.slice(0, 4), [1]);
        const r = (await f.settle(ids[0], 'perShuttle')).body;
        await f.finish(ids.slice(4, 8), [1]);
        await f.finish(ids.slice(8), [1]);
        const b = (await bill(f.sessionCode).expect(200)).body;
        expect(b.settled[0].amountSatang).toBe(r.amountSatang);
        // The shuttle is paid once in total: a's frozen 3000 plus what the rest owe for it.
        const dueShuttle = b.result.rows.reduce((n: number, x: { shuttleSatang: number }) => n + x.shuttleSatang, 0);
        expect(r.breakdown.shuttleSatang + dueShuttle).toBe(12000);
        expect(b.result.totals.excessCreditSatang).toBe(0);
      } finally {
        await f.cleanup();
      }
    });

    it('a correction that cuts the cost below what was paid shows an excess and blocks copying', async () => {
      const f = await fixture(5, { config: cfg({ model: 'fair', courtFeeSatang: 1000 }) });
      try {
        const ids = f.players.map((x) => x.id);
        await f.finish(ids.slice(0, 4), []);
        await setCfg(f.sessionCode, { model: 'perGame', entryFeeSatang: 5000 });
        await f.settle(ids[0], 'perGame');
        await prisma.session.update({ where: { code: f.sessionCode }, data: { shuttleCount: 0 } });
        await setCfg(f.sessionCode, { model: 'fair', courtFeeSatang: 1000 });
        const b = (await bill(f.sessionCode).expect(200)).body;
        expect(b.result.totals.excessCreditSatang).toBe(4000);
        expect(b.result.warnings).toContain('EXCESS_CREDIT');
        expect(b.readyToCopy).toBe(false);
        expect(b.result.rows.every((x: { amountSatang: number }) => x.amountSatang >= 0)).toBe(true);
      } finally {
        await f.cleanup();
      }
    });

    it('everyone left with the cost unpaid reports an uncovered cost, not readyToCopy', async () => {
      const f = await fixture(4, { config: cfg({ model: 'fair', courtFeeSatang: 10000 }) });
      try {
        const ids = f.players.map((x) => x.id);
        await f.finish(ids, []);
        await prisma.session.update({ where: { code: f.sessionCode }, data: { shuttleCount: 0 } });
        for (const id of ids) await f.settle(id, 'perShuttle');
        const b = (await bill(f.sessionCode).expect(200)).body;
        expect(b.result.rows).toEqual([]);
        expect(b.result.totals.uncoveredCostSatang).toBe(10000 - 4 * 2000);
        expect(b.readyToCopy).toBe(false);
      } finally {
        await f.cleanup();
      }
    });

    it('an unknown finished game blocks a perShuttle bill; zero price and zero games are valid', async () => {
      const f = await fixture(4, { priceSatang: 0 });
      try {
        let b = (await bill(f.sessionCode).expect(200)).body;
        expect(b.readyToCopy).toBe(true);
        await f.finish(f.players.map((x) => x.id), null);
        b = (await bill(f.sessionCode).expect(200)).body;
        expect(b.result.warnings).toContain('UNKNOWN_SHUTTLE_USE');
        expect(b.readyToCopy).toBe(false);
      } finally {
        await f.cleanup();
      }
    });

    it('an ordinary session bill has no settled rows and zero settlement totals', async () => {
      const f = await fixture(4, { advanced: false, config: cfg({ model: 'perGame' }) });
      try {
        const b = (await bill(f.sessionCode).expect(200)).body;
        expect(b.settled).toEqual([]);
        expect(b.result.totals).toMatchObject({ settledTotalSatang: 0, excessCreditSatang: 0, uncoveredCostSatang: 0 });
      } finally {
        await f.cleanup();
      }
    });

    it('a player removed from the bill must be restored before they can be checked out', async () => {
      const f = await fixture(4, { config: cfg({ removedIds: [] }) });
      try {
        await setCfg(f.sessionCode, { removedIds: [f.players[0].id] });
        expect((await f.preview(f.players[0].id, 'perGame').expect(409)).body.code).toBe('PLAYER_REMOVED_FROM_BILL');
        await setCfg(f.sessionCode, { removedIds: [] });
        await f.preview(f.players[0].id, 'perGame').expect(201);
      } finally {
        await f.cleanup();
      }
    });

    it('owner-only: the public session read and summary carry no checkout data', async () => {
      const f = await fixture(5);
      try {
        await f.settle(f.players[0].id);
        for (const path of [`/sessions/${f.sessionCode}`, `/sessions/${f.sessionCode}/summary`]) {
          const res = await request(server).get(path).expect(200);
          expect(JSON.stringify(res.body)).not.toMatch(/checkout|amountSatang|idempotency/i);
        }
      } finally {
        await f.cleanup();
      }
    });
  });
});
