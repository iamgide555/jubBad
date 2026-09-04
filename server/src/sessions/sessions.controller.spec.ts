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
});
