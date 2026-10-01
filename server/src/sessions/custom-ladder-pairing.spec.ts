import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { GroupsModule } from '../groups/groups.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsModule } from './sessions.module.js';

describe('custom ladder pairing', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let adminId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, GroupsModule, SessionsModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    adminId = (await prisma.user.create({ data: { email: `cl-admin-${randomUUID()}@example.test`, passwordHash: 'x', role: 'admin' } })).id;
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: adminId, role: 'admin' };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });
  afterAll(async () => {
    await prisma.group.updateMany({ where: { ownerId: adminId }, data: { ownerId: null } });
    await prisma.user.deleteMany({ where: { id: adminId } });
    await app.close();
  });

  const LADDER = [
    { id: 'l1', name: 'มือใหม่', startingElo: 1000 },
    { id: 'l2', name: 'กลาง', startingElo: 1200 },
    { id: 'l3', name: 'เก่ง', startingElo: 1400 },
  ];

  async function fixture(levels: (string | null)[], mode: string, ladder: object[] | null = LADDER) {
    const code = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code, name: 'CL', ownerId: adminId, levelLadder: ladder ? JSON.stringify(ladder) : null } });
    const players = [];
    for (const [i, level] of levels.entries()) {
      players.push(await prisma.player.create({ data: { groupId: code, name: `P${i}`, aliases: '[]', level, levelSeed: level ? 1200 : null, levelSetAt: level ? new Date(Date.now() - 3_600_000) : null } }));
    }
    await prisma.session.create({ data: { code: sessionCode, groupId: code, courtCount: 2, rawImportText: '', mode } });
    for (const p of players) await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    const cleanup = async () => {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { groupId: code } });
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    };
    return { code, sessionCode, players, cleanup };
  }

  it('custom ladder: level mode keeps bottom and top rungs on separate courts using the group order', async () => {
    const f = await fixture(['มือใหม่', 'มือใหม่', 'มือใหม่', 'มือใหม่', 'เก่ง', 'เก่ง', 'เก่ง', 'เก่ง'], 'level');
    try {
      const res = await request(server).post(`/sessions/${f.sessionCode}/courts/fill`).send({}).expect(201);
      expect(res.body.ok).not.toBe(false);
      const pairings = await prisma.pairing.findMany({ where: { sessionId: f.sessionCode } });
      expect(pairings).toHaveLength(2);
      const levelOf = new Map(f.players.map((p) => [p.id, p.level]));
      for (const p of pairings) {
        const ids = [...JSON.parse(p.teamA), ...JSON.parse(p.teamB)] as string[];
        expect(new Set(ids.map((id) => levelOf.get(id))).size, 'one rung per court').toBe(1);
      }
    } finally {
      await f.cleanup();
    }
  });

  it('custom ladder: the host-only session level read and the manage list show the custom names', async () => {
    const f = await fixture(['กลาง', null, 'เก่ง', null], 'variety');
    try {
      const levels = (await request(server).get(`/sessions/${f.sessionCode}/levels`).expect(200)).body;
      expect(levels[f.players[0].id]).toBe('กลาง');
      expect(levels[f.players[1].id]).toBeNull();
      const manage = (await request(server).get(`/groups/${f.code}/players/manage`).expect(200)).body;
      expect(manage.find((p: { id: string }) => p.id === f.players[2].id).level).toBe('เก่ง');
      const panel = (await request(server).get(`/sessions/${f.sessionCode}/players`).expect(200)).body;
      expect(panel.find((p: { playerId: string }) => p.playerId === f.players[0].id).level).toBe('กลาง');
    } finally {
      await f.cleanup();
    }
  });

  it('custom ladder: a stored label missing from the ladder stops pairing with an explicit error instead of weakening the band', async () => {
    const f = await fixture(['กลาง', 'กลาง', 'กลาง', 'ZZ'], 'level');
    try {
      const res = await request(server).post(`/sessions/${f.sessionCode}/courts/1/propose`).send({});
      expect(res.status).toBe(500);
      expect(res.body.code).toBe('LEVEL_DATA_INTEGRITY');
      expect(await prisma.pairing.count({ where: { sessionId: f.sessionCode } })).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  it('level anchor: the panel rating delta stays anchored to the saved seed after the group edits that level\'s seed', async () => {
    const f = await fixture(['กลาง', 'กลาง', 'เก่ง', 'เก่ง'], 'variety');
    try {
      await prisma.player.update({ where: { id: f.players[0].id }, data: { levelSeed: 1300 } });
      await prisma.group.update({ where: { code: f.code }, data: { levelLadder: JSON.stringify(LADDER.map((l) => (l.id === 'l2' ? { ...l, startingElo: 1250 } : l))) } });
      const panel = (await request(server).get(`/sessions/${f.sessionCode}/players`).expect(200)).body;
      const row = panel.find((p: { playerId: string }) => p.playerId === f.players[0].id);
      expect(row.level).toBe('กลาง');
      expect(row.ratingDelta).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  it('an ordinary default-ladder group pairs exactly as before in level mode', async () => {
    const f = await fixture(['BG', 'BG', 'N', 'N', 'S', 'S', 'P', 'P'], 'level', null);
    try {
      const res = await request(server).post(`/sessions/${f.sessionCode}/courts/fill`).send({}).expect(201);
      expect(res.body.ok).not.toBe(false);
      expect(await prisma.pairing.count({ where: { sessionId: f.sessionCode } })).toBe(2);
    } finally {
      await f.cleanup();
    }
  });
});
