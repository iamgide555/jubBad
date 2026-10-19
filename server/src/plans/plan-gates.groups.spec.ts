import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GroupsModule } from '../groups/groups.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';

const DAY_MS = 24 * 60 * 60 * 1000;

type Verb = 'get' | 'post' | 'put' | 'delete';

describe('plan gates on paid group routes', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let freeId: string;
  let hostId: string;
  let freeCode: string;
  let hostCode: string;
  let requestUserId: string;
  let freePlayerIds: string[];
  let freeRuleId: string;
  let freeOldSession: string;
  let freeRecentSession: string;
  let hostOldSession: string;
  let freeWinnerId: string;
  let hostWinnerId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, GroupsModule, SessionsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);

    const tag = randomUUID();
    const free = await prisma.user.create({
      data: { email: `gate-free-${tag}@example.test`, passwordHash: 'test', role: 'host', plan: 'free' },
    });
    const host = await prisma.user.create({
      data: { email: `gate-host-${tag}@example.test`, passwordHash: 'test', role: 'host', plan: 'host' },
    });
    freeId = free.id;
    hostId = host.id;
    freeCode = `gate-f-${tag}`;
    hostCode = `gate-h-${tag}`;
    await prisma.group.create({ data: { code: freeCode, name: 'Free group', ownerId: freeId } });
    await prisma.group.create({ data: { code: hostCode, name: 'Host group', ownerId: hostId } });

    const a = await prisma.player.create({ data: { groupId: freeCode, name: 'A', aliases: '[]' } });
    const b = await prisma.player.create({ data: { groupId: freeCode, name: 'B', aliases: '[]' } });
    freePlayerIds = [a.id, b.id];
    const [playerAId, playerBId] = [a.id, b.id].sort();
    const rule = await prisma.playerRule.create({
      data: { groupId: freeCode, playerAId, playerBId, kind: 'avoid' },
    });
    freeRuleId = rule.id;

    // A doubles match from 40 days ago (outside the free archive window) and an
    // empty session from 2 days ago, in each group.
    const seedArchive = async (groupCode: string, tag: string) => {
      const ids: string[] = [];
      for (const n of ['W1', 'W2', 'L1', 'L2']) {
        const p = await prisma.player.create({ data: { groupId: groupCode, name: n, aliases: '[]' } });
        ids.push(p.id);
      }
      const oldAt = new Date(Date.now() - 40 * DAY_MS);
      const oldCode = `${tag}-old-${randomUUID()}`;
      await prisma.session.create({
        data: { code: oldCode, groupId: groupCode, courtCount: 1, rawImportText: '', createdAt: oldAt },
      });
      await prisma.pairing.create({
        data: {
          sessionId: oldCode,
          courtNumber: 1,
          matchNumber: 1,
          teamA: JSON.stringify([ids[0], ids[1]]),
          teamB: JSON.stringify([ids[2], ids[3]]),
          confirmedAt: oldAt,
          endedAt: oldAt,
          winner: 'A',
        },
      });
      const recentCode = `${tag}-new-${randomUUID()}`;
      await prisma.session.create({
        data: {
          code: recentCode,
          groupId: groupCode,
          courtCount: 1,
          rawImportText: '',
          createdAt: new Date(Date.now() - 2 * DAY_MS),
        },
      });
      return { ids, oldCode, recentCode };
    };
    const seededFree = await seedArchive(freeCode, 'gate-f');
    const seededHost = await seedArchive(hostCode, 'gate-h');
    freeOldSession = seededFree.oldCode;
    freeRecentSession = seededFree.recentCode;
    hostOldSession = seededHost.oldCode;
    freeWinnerId = seededFree.ids[0];
    hostWinnerId = seededHost.ids[0];

    requestUserId = freeId;
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: requestUserId, role: 'host' };
      next();
    });
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterAll(async () => {
    await prisma.pairing.deleteMany({ where: { session: { groupId: { in: [freeCode, hostCode] } } } });
    await prisma.session.deleteMany({ where: { groupId: { in: [freeCode, hostCode] } } });
    await prisma.playerRule.deleteMany({ where: { groupId: { in: [freeCode, hostCode] } } });
    await prisma.player.deleteMany({ where: { groupId: { in: [freeCode, hostCode] } } });
    await prisma.group.deleteMany({ where: { code: { in: [freeCode, hostCode] } } });
    await prisma.user.deleteMany({ where: { id: { in: [freeId, hostId] } } });
    await app.close();
  });

  // Ids are deliberately nonexistent: a gated call must be refused before any lookup 404s.
  const gated: Array<[string, Verb, (code: string) => string, unknown?]> = [
    ['PUT levels', 'put', (c) => `/groups/${c}/levels`, { action: 'reset', expectedRevision: 0 }],
    ['POST share', 'post', (c) => `/groups/${c}/share`],
    ['POST shuttle-tools on', 'post', (c) => `/groups/${c}/shuttle-tools`, { enabled: true }],
    ['POST cross-session-history on', 'post', (c) => `/groups/${c}/cross-session-history`, { enabled: true }],
    [
      'POST rules',
      'post',
      (c) => `/groups/${c}/rules`,
      { playerAId: 'no-such-a', playerBId: 'no-such-b', kind: 'avoid' },
    ],
    ['PUT rules/:ruleId', 'put', (c) => `/groups/${c}/rules/no-such-rule`, { kind: 'avoid' }],
    ['GET player stats', 'get', (c) => `/groups/${c}/players/no-such-player/stats`],
  ];

  it.each(gated)('%s is refused on a free group', async (_name, verb, path, body) => {
    requestUserId = freeId;
    const res = await request(server)[verb](path(freeCode)).send(body as object);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'PLAN_REQUIRED', requiredPlan: 'host' });
  });

  it.each(gated)('%s is not refused on a host-plan group', async (_name, verb, path, body) => {
    requestUserId = hostId;
    const res = await request(server)[verb](path(hostCode)).send(body as object);
    expect(res.status).not.toBe(403);
  });

  it('lets a free group turn paid things off and use the free calls', async () => {
    requestUserId = freeId;
    await request(server).post(`/groups/${freeCode}/shuttle-tools`).send({ enabled: false }).expect(201);
    await request(server).post(`/groups/${freeCode}/cross-session-history`).send({ enabled: false }).expect(201);
    await request(server).delete(`/groups/${freeCode}/share`).expect(200);
    await request(server)
      .put(`/groups/${freeCode}/players/${freePlayerIds[0]}/level`)
      .send({ level: 'N', expectedLadderRevision: 0 })
      .expect(200);
    await request(server).delete(`/groups/${freeCode}/rules/${freeRuleId}`).expect(200);
  });

  describe('free-plan data shaping', () => {
    type ManagedRow = { id: string; rating: number | null; singlesRating: number | null; winRate: number | null };

    it('hides rating, singles rating and win rate on a free group', async () => {
      requestUserId = freeId;
      const res = await request(server).get(`/groups/${freeCode}/players/manage`).expect(200);
      const rows = res.body as ManagedRow[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.rating).toBeNull();
        expect(row.singlesRating).toBeNull();
        expect(row.winRate).toBeNull();
      }
    });

    it('shows ratings on a host-plan group from the same data', async () => {
      requestUserId = hostId;
      const res = await request(server).get(`/groups/${hostCode}/players/manage`).expect(200);
      const rows = res.body as ManagedRow[];
      const winner = rows.find((r) => r.id === hostWinnerId)!;
      expect(typeof winner.rating).toBe('number');
      expect(winner.rating).toBeGreaterThan(1200);
      expect(winner.winRate).toBe(1);
    });

    it('lists only the last 30 days of sessions on a free group', async () => {
      requestUserId = freeId;
      const res = await request(server).get(`/groups/${freeCode}/sessions`).expect(200);
      expect((res.body as Array<{ code: string }>).map((s) => s.code)).toEqual([freeRecentSession]);
    });

    it('lists the whole archive on a host-plan group', async () => {
      requestUserId = hostId;
      const res = await request(server).get(`/groups/${hostCode}/sessions`).expect(200);
      const codes = (res.body as Array<{ code: string }>).map((s) => s.code);
      expect(codes).toContain(hostOldSession);
      expect(codes).toHaveLength(2);
    });

    type Exported = {
      players: Array<{ id: string }>;
      sessions: Array<{ code: string; matches: unknown[] }>;
    };

    it('exports only the last 30 days of sessions and their matches on a free group, but every player', async () => {
      requestUserId = freeId;
      const res = await request(server).get(`/groups/${freeCode}/export`).expect(200);
      const body = res.body as Exported;
      expect(body.sessions.map((s) => s.code)).toEqual([freeRecentSession]);
      expect(body.sessions.flatMap((s) => s.matches)).toHaveLength(0);
      // Players are not windowed: the 40-day-old match's four players plus A and B.
      expect(body.players).toHaveLength(6);
    });

    it('exports the whole archive, with its matches, for a host-plan group', async () => {
      requestUserId = hostId;
      const res = await request(server).get(`/groups/${hostCode}/export`).expect(200);
      const body = res.body as Exported;
      expect(body.sessions.map((s) => s.code)).toContain(hostOldSession);
      expect(body.sessions).toHaveLength(2);
      expect(body.sessions.find((s) => s.code === hostOldSession)!.matches).toHaveLength(1);
    });

    it('still serves the public summary of a session older than 30 days on a free group', async () => {
      await request(server).get(`/sessions/${freeOldSession}/summary`).expect(200);
    });

    it('replays the full history once the owner upgrades, including the 40-day-old session', async () => {
      requestUserId = freeId;
      await prisma.user.update({ where: { id: freeId }, data: { plan: 'host' } });
      try {
        const res = await request(server).get(`/groups/${freeCode}/players/manage`).expect(200);
        const winner = (res.body as ManagedRow[]).find((r) => r.id === freeWinnerId)!;
        expect(winner.rating).not.toBe(1200);
        expect(winner.rating).toBeGreaterThan(1200);
        const sessions = await request(server).get(`/groups/${freeCode}/sessions`).expect(200);
        expect(sessions.body as unknown[]).toHaveLength(2);
      } finally {
        await prisma.user.update({ where: { id: freeId }, data: { plan: 'free' } });
      }
    });
  });
});
