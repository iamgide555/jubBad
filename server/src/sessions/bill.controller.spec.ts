import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsModule } from './sessions.module.js';

describe('SessionsController (bill)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, SessionsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    // This module has no AuthModule, so nothing ever sets req.user — create()
    // now reads it for the ownership check in SessionsService.createSession.
    // Standing in for AuthGuard here with a fixed admin caller keeps this file
    // about session/pairing logic, not auth; admin bypasses the check,
    // matching the behaviour these tests already assume.
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: 'sessions-controller-test-admin', role: 'admin' };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    // supertest calls listen() itself for every request when the server is not
    // already listening. Under a few hundred requests that churn intermittently
    // produced "socket hang up" and bogus 501s that looked like app failures.
    // Listening once here keeps a single server for the file.
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  const fixture = async (playerCount: number) => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = [];
    for (let i = 0; i < playerCount; i++) {
      players.push(await prisma.player.create({ data: { groupId: groupCode, name: `P${i}`, aliases: '[]' } }));
    }
    await prisma.session.create({ data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' } });
    for (const p of players) await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    const finishMatch = (ids: string[], matchNumber: number) =>
      prisma.pairing.create({
        data: {
          sessionId: sessionCode, courtNumber: 1, matchNumber,
          teamA: JSON.stringify(ids.slice(0, ids.length / 2)),
          teamB: JSON.stringify(ids.slice(ids.length / 2)),
          confirmedAt: new Date(), endedAt: new Date(), winner: 'A',
        },
      });
    const cleanup = async () => {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { groupId: groupCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    };
    return { groupCode, sessionCode, players, finishMatch, cleanup };
  };

  describe('walk-in mark', () => {
    it('marks a player added mid-session as walk-in', async () => {
      const { sessionCode, cleanup } = await fixture(4);
      try {
        const res = await request(server).post(`/sessions/${sessionCode}/roster`).send({ name: 'Late' }).expect(201);
        const row = await prisma.sessionRoster.findUniqueOrThrow({
          where: { sessionId_playerId: { sessionId: sessionCode, playerId: res.body.playerId } },
        });
        expect(row.walkIn).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it('toggles walk-in on and off, also after the session ended', async () => {
      const { sessionCode, players, cleanup } = await fixture(4);
      try {
        await prisma.session.update({ where: { code: sessionCode }, data: { endedAt: new Date() } });
        const on = await request(server)
          .post(`/sessions/${sessionCode}/roster/${players[0].id}/walk-in`).send({ walkIn: true }).expect(201);
        expect(on.body).toEqual({ playerId: players[0].id, walkIn: true });
        const off = await request(server)
          .post(`/sessions/${sessionCode}/roster/${players[0].id}/walk-in`).send({ walkIn: false }).expect(201);
        expect(off.body.walkIn).toBe(false);
      } finally {
        await cleanup();
      }
    });

    it('404s for a player not on the roster, 400s on a bad body', async () => {
      const { sessionCode, players, cleanup } = await fixture(4);
      try {
        const res = await request(server)
          .post(`/sessions/${sessionCode}/roster/nope/walk-in`).send({ walkIn: true }).expect(404);
        expect(res.body.code).toBe('ROSTER_PLAYER_NOT_FOUND');
        await request(server)
          .post(`/sessions/${sessionCode}/roster/${players[0].id}/walk-in`).send({ walkIn: 'yes' }).expect(400);
      } finally {
        await cleanup();
      }
    });
  });

  describe('bill', () => {
    const baseConfig = {
      model: 'fair', courtFeeSatang: 20000, courtSplit: 'equal', shuttleSplit: 'byGames',
      perGameRateSatang: 0, entryFeeSatang: 0, capSatang: null, buffetPriceSatang: 0,
      buffetShuttlesIncluded: true, hostFeeSatang: 0, walkInFeeSatang: 2000, roundingBaht: 1,
      addedIds: [], removedIds: [], overrides: [],
    };

    it('returns defaults and an empty bill before anyone finished a match', async () => {
      const { sessionCode, cleanup } = await fixture(4);
      try {
        const res = await request(server).get(`/sessions/${sessionCode}/bill`).expect(200);
        expect(res.body.configSource).toBe('default');
        expect(res.body.config.walkInFeeSatang).toBe(2000);
        expect(res.body.result.rows).toEqual([]);
        expect(res.body.players).toHaveLength(4);
      } finally {
        await cleanup();
      }
    });

    it('bills only confirmed + finished matches and applies the walk-in fee', async () => {
      const { sessionCode, players, finishMatch, cleanup } = await fixture(6);
      try {
        const ids = players.slice(0, 4).map((p) => p.id);
        await finishMatch(ids, 1);
        // pending (unconfirmed) and active (unfinished) must not count. Different
        // court numbers: both are "open" (endedAt null), and the DB's partial
        // unique index allows at most one open pairing per session+court.
        await prisma.pairing.create({ data: { sessionId: sessionCode, courtNumber: 1, matchNumber: 2,
          teamA: JSON.stringify([players[4].id]), teamB: JSON.stringify([players[5].id]) } });
        await prisma.pairing.create({ data: { sessionId: sessionCode, courtNumber: 2, matchNumber: 3,
          teamA: JSON.stringify([players[4].id]), teamB: JSON.stringify([players[5].id]), confirmedAt: new Date() } });
        await prisma.sessionRoster.update({
          where: { sessionId_playerId: { sessionId: sessionCode, playerId: ids[3] } }, data: { walkIn: true },
        });
        const res = await request(server).post(`/sessions/${sessionCode}/bill-config`).send(baseConfig).expect(201);
        expect(res.body.configSource).toBe('saved');
        const amounts = Object.fromEntries(res.body.result.rows.map((r: { playerId: string; amountSatang: number }) => [r.playerId, r.amountSatang]));
        const regular = Math.min(...Object.values(amounts) as number[]);
        expect(Object.keys(amounts).sort()).toEqual([...ids].sort());
        expect(amounts[ids[3]] - regular).toBe(2000);
        expect(res.body.result.totals.collectedSatang).toBe(20000);
        const again = await request(server).get(`/sessions/${sessionCode}/bill`).expect(200);
        expect(again.body.config.courtFeeSatang).toBe(20000);
      } finally {
        await cleanup();
      }
    });

    it('prefills from the previous session without per-person entries', async () => {
      const { groupCode, sessionCode, players, cleanup } = await fixture(4);
      try {
        await prisma.session.update({ where: { code: sessionCode }, data: {
          createdAt: new Date(Date.now() - 86400000),
          billConfig: JSON.stringify({ ...baseConfig, hostFeeSatang: 1000, addedIds: [players[0].id] }),
        } });
        const next = randomUUID();
        await prisma.session.create({ data: { code: next, groupId: groupCode, courtCount: 1, rawImportText: '' } });
        const res = await request(server).get(`/sessions/${next}/bill`).expect(200);
        expect(res.body.configSource).toBe('previous');
        expect(res.body.config.hostFeeSatang).toBe(1000);
        expect(res.body.config.addedIds).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it('works after the session ended; rejects off-roster ids and bad bodies', async () => {
      const { sessionCode, cleanup } = await fixture(4);
      try {
        await prisma.session.update({ where: { code: sessionCode }, data: { endedAt: new Date() } });
        await request(server).post(`/sessions/${sessionCode}/bill-config`).send(baseConfig).expect(201);
        const off = await request(server).post(`/sessions/${sessionCode}/bill-config`)
          .send({ ...baseConfig, addedIds: ['stranger'] }).expect(400);
        expect(off.body.code).toBe('BILL_PLAYER_NOT_ON_ROSTER');
        await request(server).post(`/sessions/${sessionCode}/bill-config`).send({ ...baseConfig, hostFeeSatang: -1 }).expect(400);
        await request(server).post(`/sessions/${sessionCode}/bill-config`).send({ ...baseConfig, model: 'free' }).expect(400);
        await request(server).post(`/sessions/${sessionCode}/bill-config`).send({ ...baseConfig, roundingBaht: 3 }).expect(400);
      } finally {
        await cleanup();
      }
    });

    it('ignores a stale saved id for a player no longer on the roster', async () => {
      const { sessionCode, cleanup } = await fixture(4);
      try {
        await prisma.session.update({ where: { code: sessionCode }, data: {
          billConfig: JSON.stringify({ ...baseConfig, addedIds: ['gone'] }),
        } });
        const res = await request(server).get(`/sessions/${sessionCode}/bill`).expect(200);
        expect(res.body.config.addedIds).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it('404s for an unknown session', async () => {
      await request(server).get(`/sessions/${randomUUID()}/bill`).expect(404);
    });
  });
});
