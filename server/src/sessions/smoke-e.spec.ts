/**
 * Scale smoke for host feedback E (early checkout): 60 players, 8 courts, 40
 * finished games sharing physical shuttles, 20 sequential leavers across the
 * three early models, then races, undo, later reuse and the final bill.
 * Money is checked by conservation, not by re-implementing the formulas.
 */
import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DEFAULT_BILL_CONFIG } from '../../../engines/bill.ts';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { serializeBillConfig } from './bill-config.js';
import { SessionsModule } from './sessions.module.js';

describe('smoke E: early checkout at scale', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, SessionsModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: 'smoke-e-admin', role: 'admin' };
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

  const PRICE = 12000;
  const START = 3000;

  async function seed(advanced: boolean) {
    const groupCode = randomUUID();
    const code = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'smoke-e' } });
    const players: { id: string }[] = [];
    for (let i = 0; i < 60; i++) players.push(await prisma.player.create({ data: { groupId: groupCode, name: `P${i}`, aliases: '[]' } }));
    await prisma.session.create({
      data: {
        code, groupId: groupCode, courtCount: 8, rawImportText: '', shuttleToolsEnabled: advanced, shuttlePriceSatang: PRICE,
        billConfig: serializeBillConfig({ ...DEFAULT_BILL_CONFIG, walkInFeeSatang: 0, model: advanced ? 'perShuttle' : 'perGame', startingFeeSatang: START, entryFeeSatang: 1000, perGameRateSatang: 2000, buffetPriceSatang: 8000 }),
      },
    });
    for (const p of players) await prisma.sessionRoster.create({ data: { sessionId: code, playerId: p.id } });
    const shuttleIds = new Map<number, string>();
    const matchNo = new Map<number, number>();
    let games = 0;
    // One finished game on `court`; players are a rotating window so everyone plays several games.
    async function finish(court: number, shuttleNumbers: number[]) {
      const g = games++;
      const ids = [0, 1, 2, 3].map((k) => players[(g * 4 + k) % 60].id);
      const n = (matchNo.get(court) ?? 0) + 1;
      matchNo.set(court, n);
      const pairing = await prisma.pairing.create({
        data: {
          sessionId: code, courtNumber: court, matchNumber: n,
          teamA: JSON.stringify(ids.slice(0, 2)), teamB: JSON.stringify(ids.slice(2)),
          confirmedAt: new Date(), endedAt: new Date(), winner: 'A', shuttleLogKnown: advanced,
        },
      });
      if (advanced) {
        for (const num of shuttleNumbers) {
          if (!shuttleIds.has(num)) shuttleIds.set(num, (await prisma.sessionShuttle.create({ data: { sessionId: code, number: num } })).id);
          await prisma.pairingShuttleUse.create({ data: { pairingId: pairing.id, shuttleId: shuttleIds.get(num)! } });
        }
      }
      return ids;
    }
    // 8 courts x 5 rounds; each court keeps its own physical shuttle, and every 4th game opens a second one.
    for (let round = 0; round < 5; round++) {
      for (let court = 1; court <= 8; court++) await finish(court, round % 4 === 3 ? [court, 100 + court] : [court]);
    }
    const cleanup = async () => {
      await prisma.sessionCheckout.deleteMany({ where: { sessionId: code } });
      await prisma.pairingShuttleUse.deleteMany({ where: { pairing: { sessionId: code } } });
      await prisma.pairing.deleteMany({ where: { sessionId: code } });
      await prisma.sessionShuttle.deleteMany({ where: { sessionId: code } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: code } });
      await prisma.session.deleteMany({ where: { groupId: groupCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    };
    return { code, players, finish, cleanup, distinctShuttles: advanced ? shuttleIds.size : 0 };
  }

  const post = (code: string, path: string, body: object = {}) => request(server).post(`/sessions/${code}/${path}`).send(body);
  const bill = (code: string) => request(server).get(`/sessions/${code}/bill`).expect(200).then((r) => r.body);
  const settle = async (code: string, playerId: string, model: string, key = randomUUID()) => {
    const pv = await post(code, `checkouts/${playerId}/preview`, { model }).expect(201);
    const res = await post(code, `checkouts/${playerId}/confirm`, { model, snapshotHash: pv.body.snapshotHash, idempotencyKey: key });
    return { pv: pv.body, res };
  };

  it('20 sequential leavers across all three models; frozen amounts never move; the bill conserves money', async () => {
    const s = await seed(true);
    try {
      const models = ['perShuttle', 'perGame', 'buffet'];
      const frozen = new Map<string, number>();
      const t0 = Date.now();
      for (let i = 0; i < 20; i++) {
        const id = s.players[i * 3].id;
        const { pv, res } = await settle(s.code, id, models[i % 3]);
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body.amountSatang).toBe(pv.amountSatang);
        frozen.set(res.body.id, res.body.amountSatang);
      }
      const settleMs = Date.now() - t0;
      // Every earlier receipt is still exactly what it was.
      const list = (await request(server).get(`/sessions/${s.code}/checkouts`).expect(200)).body;
      expect(list).toHaveLength(20);
      for (const r of list) expect(r.amountSatang).toBe(frozen.get(r.id));

      // Later reuse of already-used physical shuttles, on every court, changes nothing already settled.
      for (let court = 1; court <= 8; court++) await s.finish(court, [court]);
      const t1 = Date.now();
      const b = await bill(s.code);
      const billMs = Date.now() - t1;
      for (const r of b.settled) expect(r.amountSatang).toBe(frozen.get(r.id));
      expect(b.settled).toHaveLength(20);
      expect(b.result.rows.every((r: { amountSatang: number }) => r.amountSatang >= 0)).toBe(true);
      const settledIds = new Set(b.settled.map((x: { playerId: string }) => x.playerId));
      expect(b.result.rows.some((r: { playerId: string }) => settledIds.has(r.playerId))).toBe(false);
      const t = b.result.totals;
      expect(t.collectedSatang).toBe(t.settledTotalSatang + t.stillDueSatang);
      expect(t.settledTotalSatang).toBe([...frozen.values()].reduce((a, c) => a + c, 0));
      expect(t.stillDueSatang).toBe(b.result.rows.reduce((a: number, r: { amountSatang: number }) => a + r.amountSatang, 0));

      // Shuttle conservation: money toward recorded shuttles covers the recorded cost once.
      const distinct = b.accounting.recordedFinishedShuttles;
      const cost = distinct * PRICE;
      const startingFees = b.result.rows.length * START + list.filter((r: { model: string }) => r.model === 'perShuttle').length * START;
      void startingFees;
      const dueShuttle = b.result.rows.reduce((a: number, r: { shuttleSatang: number }) => a + r.shuttleSatang, 0);
      const settledShuttleCredit = b.settled.reduce((a: number, r: { model: string; amountSatang: number }) => a + r.amountSatang - (r.model === 'perShuttle' ? START : 0), 0);
      expect(dueShuttle + Math.min(settledShuttleCredit, cost)).toBe(cost);
      expect(t.excessCreditSatang).toBe(Math.max(0, settledShuttleCredit - cost));
      console.log(
        `[smoke-e] 60 players, ${s.distinctShuttles} shuttle identities (${distinct} recorded), 20 checkouts in ${settleMs}ms, ` +
          `bill read ${billMs}ms; settled ${t.settledTotalSatang}, still due ${t.stillDueSatang}, collected ${t.collectedSatang}, ` +
          `shuttle cost ${cost}, due shuttle ${dueShuttle}, credit ${settledShuttleCredit}, excess ${t.excessCreditSatang}, warnings ${JSON.stringify(b.result.warnings)}`
      );
    } finally {
      await s.cleanup();
    }
  });

  it('concurrent leavers: one wins, the rest are stale and succeed on a fresh quote; a same-player race yields one receipt', async () => {
    const s = await seed(true);
    try {
      const ids = s.players.slice(0, 10).map((p) => p.id);
      const previews = await Promise.all(ids.map((id) => post(s.code, `checkouts/${id}/preview`, { model: 'perGame' }).expect(201).then((r) => r.body)));
      const results = await Promise.all(
        ids.map((id, i) => post(s.code, `checkouts/${id}/confirm`, { model: 'perGame', snapshotHash: previews[i].snapshotHash, idempotencyKey: randomUUID() }))
      );
      const ok = results.filter((r) => r.status === 201).length;
      const stale = results.filter((r) => r.status === 409 && r.body.code === 'CHECKOUT_STALE').length;
      expect(ok).toBe(1);
      expect(ok + stale).toBe(10);
      // Re-quote and retry the stale ones one by one: every one then succeeds.
      for (const id of ids) {
        if ((await prisma.sessionCheckout.count({ where: { sessionId: s.code, playerId: id, undoneAt: null } })) === 1) continue;
        const { res } = await settle(s.code, id, 'perGame');
        expect(res.status).toBe(201);
      }
      expect(await prisma.sessionCheckout.count({ where: { sessionId: s.code, undoneAt: null } })).toBe(10);

      const target = s.players[20].id;
      const pv = (await post(s.code, `checkouts/${target}/preview`, { model: 'buffet' }).expect(201)).body;
      const race = await Promise.all(
        Array.from({ length: 12 }, () => post(s.code, `checkouts/${target}/confirm`, { model: 'buffet', snapshotHash: pv.snapshotHash, idempotencyKey: randomUUID() }))
      );
      expect(race.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await prisma.sessionCheckout.count({ where: { sessionId: s.code, playerId: target, undoneAt: null } })).toBe(1);
      expect((await prisma.sessionRoster.findFirstOrThrow({ where: { sessionId: s.code, playerId: target } })).active).toBe(false);
      console.log(`[smoke-e] 10 concurrent distinct leavers: ${ok} landed, ${stale} stale (re-quoted ok); 12-way same-player race: 1 receipt`);
    } finally {
      await s.cleanup();
    }
  });

  it('undo returns a leaver with the rotation credit; refused after the end; public routes carry no money', async () => {
    const s = await seed(true);
    try {
      const id = s.players[5].id;
      const { res } = await settle(s.code, id, 'perShuttle');
      const undo = await post(s.code, `checkouts/${res.body.id}/undo`).expect(201);
      expect(undo.body).toMatchObject({ ok: true, playerId: id });
      const row = await prisma.sessionRoster.findFirstOrThrow({ where: { sessionId: s.code, playerId: id } });
      expect(row.active).toBe(true);
      const again = await settle(s.code, id, 'perGame');
      expect(again.res.status).toBe(201);
      for (const path of ['', '/summary']) {
        const body = JSON.stringify((await request(server).get(`/sessions/${s.code}${path}`).expect(200)).body);
        expect(body).not.toMatch(/checkout|idempotency|snapshotHash/i);
      }
      await prisma.session.update({ where: { code: s.code }, data: { endedAt: new Date() } });
      await post(s.code, `checkouts/${again.res.body.id}/undo`).expect(409);
      console.log(`[smoke-e] undo restored active=${row.active}, gamesOffset=${row.gamesOffset}; public routes carry no checkout data`);
    } finally {
      await s.cleanup();
    }
  });

  it('ordinary 60-player session refuses checkout at the API', async () => {
    const s = await seed(false);
    try {
      const res = await post(s.code, `checkouts/${s.players[0].id}/preview`, { model: 'perGame' }).expect(400);
      expect(res.body.code).toBe('CHECKOUT_DISABLED');
      const b = await bill(s.code);
      expect(b.settled).toEqual([]);
      expect(b.result.totals.settledTotalSatang).toBe(0);
    } finally {
      await s.cleanup();
    }
  });
});
