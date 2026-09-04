import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsModule } from './sessions.module.js';

describe('SessionsController', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, SessionsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a session, resolving new players and existing-player aliases', async () => {
    const groupCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const existing = await prisma.player.create({
      data: { groupId: groupCode, name: 'Bob', aliases: '[]' },
    });

    const res = await request(app.getHttpServer())
      .post('/sessions')
      .send({
        groupCode,
        date: '2026-09-04',
        venue: 'Court A',
        courtCount: 2,
        rawImportText: '1. Alice\n2. Bobby',
        rosterReviews: [
          { inputName: 'Alice', match: { type: 'new' }, decision: 'accept' },
          {
            inputName: 'Bobby',
            match: { type: 'fuzzy', playerId: existing.id, score: 0.8 },
            decision: 'accept',
          },
        ],
        waitlistReviews: [],
      })
      .expect(201);

    expect(typeof res.body.code).toBe('string');

    try {
      const session = await prisma.session.findUniqueOrThrow({ where: { code: res.body.code } });
      expect(session.groupId).toBe(groupCode);
      expect(session.venue).toBe('Court A');

      const roster = await prisma.sessionRoster.findMany({ where: { sessionId: res.body.code } });
      expect(roster).toHaveLength(2);

      const bobAfter = await prisma.player.findUniqueOrThrow({ where: { id: existing.id } });
      expect(JSON.parse(bobAfter.aliases)).toEqual(['Bobby']);

      const allPlayers = await prisma.player.findMany({ where: { groupId: groupCode } });
      expect(allPlayers).toHaveLength(2);
    } finally {
      await prisma.sessionRoster.deleteMany({ where: { sessionId: res.body.code } });
      await prisma.session.deleteMany({ where: { code: res.body.code } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('rejects a request with an unrecognized decision value', async () => {
    const groupCode = randomUUID();
    await request(app.getHttpServer())
      .post('/sessions')
      .send({
        groupCode,
        date: null,
        venue: null,
        courtCount: null,
        rawImportText: '1. Alice',
        rosterReviews: [{ inputName: 'Alice', match: { type: 'new' }, decision: 'maybe' }],
        waitlistReviews: [],
      })
      .expect(400);
  });

  it('returns 404 for a session that does not exist', async () => {
    await request(app.getHttpServer()).get(`/sessions/${randomUUID()}`).expect(404);
  });

  it('derives court status from Pairing rows', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: {
        code: sessionCode,
        groupId: groupCode,
        courtCount: 2,
        rawImportText: '',
      },
    });
    for (const p of players) {
      await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    }
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([players[0].id, players[1].id]),
        teamB: JSON.stringify([players[2].id, players[3].id]),
        confirmedAt: new Date(),
      },
    });

    try {
      const res = await request(app.getHttpServer()).get(`/sessions/${sessionCode}`).expect(200);
      expect(res.body.rosterPlayerIds).toHaveLength(4);
      expect(res.body.courts).toEqual([
        {
          courtNumber: 1,
          status: 'active',
          teamA: [players[0].id, players[1].id],
          teamB: [players[2].id, players[3].id],
        },
        { courtNumber: 2, status: 'idle' },
      ]);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });
});
