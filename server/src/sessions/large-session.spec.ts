import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsModule } from './sessions.module.js';

/**
 * Shapes the small fixtures elsewhere in this suite never reach: a roster far
 * bigger than the courts can seat (so sit-out rotation actually has to work)
 * and more than five courts running at once, the way a big group's night
 * really goes. Everything here drives the real HTTP routes, one court at a
 * time, like the host's phone does.
 */
describe('big sessions: many courts, many players', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, SessionsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: 'large-session-test-admin', role: 'admin' };
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

  async function seed(playerCount: number, courtCount: number) {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'Big' } });
    await prisma.player.createMany({
      data: Array.from({ length: playerCount }, (_, i) => ({
        groupId: groupCode,
        name: `P${String(i + 1).padStart(2, '0')}`,
        aliases: '[]',
      })),
    });
    const players = await prisma.player.findMany({ where: { groupId: groupCode } });
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount, rawImportText: '' },
    });
    await prisma.sessionRoster.createMany({
      data: players.map((p) => ({ sessionId: sessionCode, playerId: p.id })),
    });
    const cleanup = async () => {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    };
    return { sessionCode, players, cleanup };
  }

  const seatsOf = (row: { teamA: string; teamB: string }): string[] => [
    ...JSON.parse(row.teamA),
    ...JSON.parse(row.teamB),
  ];

  it('a 4-player court walks through all three splits before repeating one (G3)', async () => {
    const { sessionCode, cleanup } = await seed(4, 1);
    try {
      const seen = new Set<string>();
      for (let i = 0; i < 3; i++) {
        const res = await request(server)
          .post(`/sessions/${sessionCode}/courts/1/propose`)
          .expect(201);
        expect(res.body.ok).toBe(true);
        const { teamA, teamB } = res.body.pairing as { teamA: string[]; teamB: string[] };
        const key = [[...teamA].sort().join('|'), [...teamB].sort().join('|')].sort().join(' vs ');
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
      expect(seen.size).toBe(3);

      // The row holds every split shown *before* the one now on screen (the
      // current split is re-added from teamA/teamB at the next reshuffle).
      const row = await prisma.pairing.findFirstOrThrow({ where: { sessionId: sessionCode } });
      expect(JSON.parse(row.shownSplits)).toHaveLength(2);
    } finally {
      await cleanup();
    }
  });

  it('a new match on the court starts with no shown-split memory', async () => {
    const { sessionCode, cleanup } = await seed(4, 1);
    try {
      for (let i = 0; i < 2; i++) {
        await request(server).post(`/sessions/${sessionCode}/courts/1/propose`).expect(201);
      }
      const first = await prisma.pairing.findFirstOrThrow({ where: { sessionId: sessionCode } });
      expect(JSON.parse(first.shownSplits)).toHaveLength(1);

      await request(server)
        .post(`/sessions/${sessionCode}/pairings/${first.id}/confirm`)
        .send({})
        .expect(201);
      await request(server)
        .post(`/sessions/${sessionCode}/pairings/${first.id}/finish`)
        .send({ winner: 'A' })
        .expect(201);

      await request(server).post(`/sessions/${sessionCode}/courts/1/propose`).expect(201);
      const next = await prisma.pairing.findFirstOrThrow({
        where: { sessionId: sessionCode, endedAt: null },
      });
      expect(next.id).not.toBe(first.id);
      expect(JSON.parse(next.shownSplits)).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it('runs 8 courts with 44 players for 6 rotations: no double-booking, sit-outs rotate fairly', async () => {
    const COURTS = 8;
    const { sessionCode, players, cleanup } = await seed(44, COURTS);
    const played = new Map<string, number>(players.map((p) => [p.id, 0]));
    try {
      for (let round = 0; round < 6; round++) {
        const fill = await request(server).post(`/sessions/${sessionCode}/courts/fill`).expect(201);
        expect(fill.body.ok).toBe(true);
        expect(fill.body.filled).toHaveLength(COURTS);

        const pending = await prisma.pairing.findMany({
          where: { sessionId: sessionCode, endedAt: null },
        });
        expect(pending).toHaveLength(COURTS);

        // Nobody may sit on two courts at once.
        const seated = pending.flatMap(seatsOf);
        expect(seated).toHaveLength(COURTS * 4);
        expect(new Set(seated).size).toBe(COURTS * 4);

        for (const row of pending) {
          await request(server)
            .post(`/sessions/${sessionCode}/pairings/${row.id}/confirm`)
            .send({})
            .expect(201);
        }
        for (const row of pending) {
          await request(server)
            .post(`/sessions/${sessionCode}/pairings/${row.id}/finish`)
            .send({ winner: round % 2 === 0 ? 'A' : 'B' })
            .expect(201);
          for (const id of seatsOf(row)) played.set(id, (played.get(id) ?? 0) + 1);
        }
      }

      // 32 of 44 seats per round × 6 rounds = 192 seat-games over 44 players:
      // everyone should have played 4 or 5 (never a long sit-out streak).
      const counts = [...played.values()];
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(2);
      expect(Math.min(...counts)).toBeGreaterThanOrEqual(3);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('reshuffling one court of a 10-court, 60-player session never seats anyone twice', async () => {
    const COURTS = 10;
    const { sessionCode, cleanup } = await seed(60, COURTS);
    try {
      await request(server).post(`/sessions/${sessionCode}/courts/fill`).expect(201);

      for (let i = 0; i < 5; i++) {
        await request(server).post(`/sessions/${sessionCode}/courts/4/propose`).expect(201);
        const pending = await prisma.pairing.findMany({
          where: { sessionId: sessionCode, endedAt: null },
        });
        expect(pending).toHaveLength(COURTS);
        const seated = pending.flatMap(seatsOf);
        expect(new Set(seated).size).toBe(COURTS * 4);
      }
    } finally {
      await cleanup();
    }
  }, 60_000);
});
