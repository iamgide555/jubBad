import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DEFAULT_BILL_CONFIG } from '../../../engines/bill.ts';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { serializeBillConfig } from './bill-config.js';
import { serializeCheckoutBreakdown, serializeCheckoutSnapshot } from './checkout-pricing.js';
import { SessionsModule } from './sessions.module.js';

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
    return { groupCode, sessionCode, players, finish, pending, preview, cleanup };
  }

  describe('checkout preview', () => {
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
});
