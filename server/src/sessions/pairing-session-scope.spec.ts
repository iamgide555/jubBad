import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsModule } from './sessions.module.js';

/**
 * The pairing routes are declared as /sessions/:code/pairings/:id/..., but the
 * handlers only ever read :id — the session in the URL was never checked
 * against the session the pairing actually belongs to.
 *
 * So a request naming session A could confirm, finish, or swap a player in
 * session B. Reachable in ordinary use from a tab left open on last week's
 * session, where every button points at a session code that is no longer the
 * one those pairings live in.
 */
describe('pairing routes are scoped to the session in the URL', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;

  const groupCode = randomUUID();
  const sessionA = randomUUID().slice(0, 8);
  const sessionB = randomUUID().slice(0, 8);
  let players: string[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, SessionsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    prisma = app.get(PrismaService);

    await prisma.group.create({ data: { code: groupCode, name: 'Scope' } });
    const created = await Promise.all(
      ['A', 'B', 'C', 'D', 'E'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    players = created.map((p) => p.id);

    for (const code of [sessionA, sessionB]) {
      await prisma.session.create({
        data: { code, groupId: groupCode, courtCount: 1, rawImportText: '' },
      });
      await Promise.all(
        players.map((playerId) =>
          prisma.sessionRoster.create({ data: { sessionId: code, playerId } })
        )
      );
    }
  });

  afterAll(async () => {
    await prisma.pairing.deleteMany({ where: { sessionId: { in: [sessionA, sessionB] } } });
    await prisma.sessionRoster.deleteMany({ where: { sessionId: { in: [sessionA, sessionB] } } });
    await prisma.session.deleteMany({ where: { groupId: groupCode } });
    await prisma.player.deleteMany({ where: { groupId: groupCode } });
    await prisma.group.deleteMany({ where: { code: groupCode } });
  });

  /** A fresh proposed pairing that belongs to session A. */
  async function pairingInA() {
    await prisma.pairing.deleteMany({ where: { sessionId: sessionA } });
    return prisma.pairing.create({
      data: {
        sessionId: sessionA,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([players[0], players[1]]),
        teamB: JSON.stringify([players[2], players[3]]),
      },
    });
  }

  it('refuses to confirm a pairing through another session', async () => {
    const pairing = await pairingInA();
    await request(server).post(`/sessions/${sessionB}/pairings/${pairing.id}/confirm`).expect(404);

    const after = await prisma.pairing.findUniqueOrThrow({ where: { id: pairing.id } });
    expect(after.confirmedAt).toBeNull();
  });

  it('refuses to finish a pairing through another session', async () => {
    const pairing = await pairingInA();
    await prisma.pairing.update({
      where: { id: pairing.id },
      data: { confirmedAt: new Date() },
    });

    await request(server)
      .post(`/sessions/${sessionB}/pairings/${pairing.id}/finish`)
      .send({ scoreA: 21, scoreB: 15, winner: 'A' })
      .expect(404);

    const after = await prisma.pairing.findUniqueOrThrow({ where: { id: pairing.id } });
    expect(after.endedAt).toBeNull();
    expect(after.winner).toBeNull();
  });

  it('refuses to swap a player through another session', async () => {
    const pairing = await pairingInA();
    await request(server)
      .post(`/sessions/${sessionB}/pairings/${pairing.id}/swap`)
      .send({ playerId: players[0] })
      .expect(404);

    const after = await prisma.pairing.findUniqueOrThrow({ where: { id: pairing.id } });
    expect(JSON.parse(after.teamA)).toContain(players[0]);
  });

  it('still works through the pairing’s own session', async () => {
    const pairing = await pairingInA();
    await request(server)
      .post(`/sessions/${sessionA}/pairings/${pairing.id}/confirm`)
      .expect(201);

    const after = await prisma.pairing.findUniqueOrThrow({ where: { id: pairing.id } });
    expect(after.confirmedAt).not.toBeNull();
  });

  it('reports an unknown pairing the same way as one from another session', async () => {
    // Same 404 either way: whether a pairing exists elsewhere is not something
    // the answer should reveal.
    await request(server)
      .post(`/sessions/${sessionA}/pairings/${randomUUID()}/confirm`)
      .expect(404);
  });
});
