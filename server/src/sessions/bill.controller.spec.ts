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
});
