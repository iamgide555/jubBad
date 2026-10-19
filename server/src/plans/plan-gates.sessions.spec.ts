import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { GroupsModule } from '../groups/groups.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { SessionsService } from '../sessions/sessions.service.js';

describe('plan gates on paid session controls', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionsService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let freeId: string;
  let hostId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, GroupsModule, SessionsModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    sessions = app.get(SessionsService);
    const tag = randomUUID();
    freeId = (await prisma.user.create({ data: { email: `sg-free-${tag}@example.test`, passwordHash: 'x', role: 'host', plan: 'free' } })).id;
    hostId = (await prisma.user.create({ data: { email: `sg-host-${tag}@example.test`, passwordHash: 'x', role: 'host', plan: 'host' } })).id;
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: freeId, role: 'host' };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });
  afterAll(async () => {
    await prisma.group.updateMany({ where: { ownerId: { in: [freeId, hostId] } }, data: { ownerId: null } });
    await prisma.user.deleteMany({ where: { id: { in: [freeId, hostId] } } });
    await app.close();
  });

  /** A group owned by `ownerId` with `players` roster players and one session in `mode`. */
  async function fixture(opts: { mode: string; players?: number; owner?: string; group?: object; noSession?: boolean }) {
    const code = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code, name: 'Gate', ownerId: opts.owner ?? freeId, ...opts.group } });
    const players = [];
    for (let i = 0; i < (opts.players ?? 4); i++) {
      players.push(await prisma.player.create({ data: { groupId: code, name: `P${i}`, aliases: '[]' } }));
    }
    if (!opts.noSession) {
      await prisma.session.create({
        data: { code: sessionCode, groupId: code, courtCount: 2, rawImportText: '', mode: opts.mode },
      });
    }
    for (const p of opts.noSession ? [] : players) await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    const cleanup = async () => {
      await prisma.queuedMatch.deleteMany({ where: { session: { groupId: code } } });
      await prisma.pairing.deleteMany({ where: { session: { groupId: code } } });
      await prisma.sessionRoster.deleteMany({ where: { session: { groupId: code } } });
      await prisma.waitlist.deleteMany({ where: { session: { groupId: code } } });
      await prisma.sessionCreation.deleteMany({ where: { groupId: code } });
      await prisma.session.deleteMany({ where: { groupId: code } });
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    };
    return { code, sessionCode, players, cleanup };
  }

  const refused = { code: 'PLAN_REQUIRED', requiredPlan: 'host' };

  it('refuses switching the session to balanced or level, and leaves the mode alone', async () => {
    const f = await fixture({ mode: 'variety' });
    try {
      for (const mode of ['balanced', 'level']) {
        const res = await request(server).post(`/sessions/${f.sessionCode}/mode`).send({ mode }).expect(403);
        expect(res.body).toMatchObject(refused);
      }
      expect((await prisma.session.findUniqueOrThrow({ where: { code: f.sessionCode } })).mode).toBe('variety');
    } finally {
      await f.cleanup();
    }
  });

  it('lets a free host switch to variety or custom', async () => {
    const f = await fixture({ mode: 'balanced' });
    try {
      await request(server).post(`/sessions/${f.sessionCode}/mode`).send({ mode: 'variety' }).expect(201);
      await request(server).post(`/sessions/${f.sessionCode}/mode`).send({ mode: 'custom' }).expect(201);
    } finally {
      await f.cleanup();
    }
  });

  it('refuses a per-court mode other than custom, and accepts custom', async () => {
    const f = await fixture({ mode: 'custom' });
    try {
      const res = await request(server).post(`/sessions/${f.sessionCode}/courts/1/mode`).send({ mode: 'level' }).expect(403);
      expect(res.body).toMatchObject(refused);
      await request(server).post(`/sessions/${f.sessionCode}/courts/1/mode`).send({ mode: 'custom' }).expect(201);
    } finally {
      await f.cleanup();
    }
  });

  it('refuses a court target other than auto, and accepts auto', async () => {
    const f = await fixture({ mode: 'custom' });
    try {
      const res = await request(server).post(`/sessions/${f.sessionCode}/courts/1/target`).send({ target: 'low' }).expect(403);
      expect(res.body).toMatchObject(refused);
      await request(server).post(`/sessions/${f.sessionCode}/courts/1/target`).send({ target: 'auto' }).expect(201);
    } finally {
      await f.cleanup();
    }
  });

  it('refuses queueing a lineup, add and replace, but leaves clearing open', async () => {
    const f = await fixture({ mode: 'custom' });
    try {
      const [a, b, c, d] = f.players.map((p) => p.id);
      const lineup = { teamA: [a, b], teamB: [c, d] };
      const res = await request(server).post(`/sessions/${f.sessionCode}/queue`).send(lineup).expect(403);
      expect(res.body).toMatchObject(refused);
      await request(server).post(`/sessions/${f.sessionCode}/queue/some-id`).send(lineup).expect(403);
      await request(server).delete(`/sessions/${f.sessionCode}/queue`).expect(200);
    } finally {
      await f.cleanup();
    }
  });

  it('accepts the same controls on a host plan', async () => {
    const f = await fixture({ mode: 'variety', owner: hostId });
    try {
      await request(server).post(`/sessions/${f.sessionCode}/mode`).send({ mode: 'balanced' }).expect(201);
      await request(server).post(`/sessions/${f.sessionCode}/courts/1/mode`).send({ mode: 'level' }).expect(201);
      await request(server).post(`/sessions/${f.sessionCode}/courts/1/target`).send({ target: 'low' }).expect(201);
    } finally {
      await f.cleanup();
    }
  });

  it('running state: a free group in balanced mode (set before a lapse) still proposes', async () => {
    const f = await fixture({ mode: 'balanced', players: 4 });
    try {
      await request(server).post(`/sessions/${f.sessionCode}/courts/1/propose`).send({}).expect(201);
    } finally {
      await f.cleanup();
    }
  });

  describe('player panel rating delta', () => {
    const deltaOf = async (owner: string) => {
      const f = await fixture({ mode: 'variety', players: 2, owner });
      try {
        await prisma.player.update({ where: { id: f.players[0].id }, data: { level: 'P', levelSetAt: new Date() } });
        const rows = await sessions.getPlayerPanel(f.sessionCode);
        return rows.find((r) => r.playerId === f.players[0].id)!;
      } finally {
        await f.cleanup();
      }
    };

    it('is null for a free owner even when the player has a level', async () => {
      const row = await deltaOf(freeId);
      expect(row.level).toBe('P');
      expect(row.ratingDelta).toBeNull();
    });

    it('is unchanged for a host owner', async () => {
      const row = await deltaOf(hostId);
      expect(row.level).toBe('P');
      expect(row.ratingDelta).toBe(0);
    });
  });

  describe('creation snapshots', () => {
    const create = async (code: string, ownerId: string) =>
      sessions.createSession(
        {
          groupCode: code,
          date: null,
          venue: null,
          courtCount: 1,
          rawImportText: 'x',
          idempotencyKey: randomUUID(),
          rosterReviews: [],
          waitlistReviews: [],
        } as never,
        { id: ownerId, role: 'host' }
      );

    it('snapshots shuttle tools and cross-session history off for a free owner', async () => {
      const f = await fixture({ mode: 'custom', players: 0, noSession: true, group: { shuttleToolsEnabled: true, crossSessionHistory: true } });
      try {
        const { code } = await create(f.code, freeId);
        const row = await prisma.session.findUniqueOrThrow({ where: { code } });
        expect(row.shuttleToolsEnabled).toBe(false);
        expect(row.crossSessionHistory).toBe(false);
      } finally {
        await f.cleanup();
      }
    });

    it('keeps both snapshots on for a host owner', async () => {
      const f = await fixture({ mode: 'custom', players: 0, noSession: true, owner: hostId, group: { shuttleToolsEnabled: true, crossSessionHistory: true } });
      try {
        const { code } = await create(f.code, hostId);
        const row = await prisma.session.findUniqueOrThrow({ where: { code } });
        expect(row.shuttleToolsEnabled).toBe(true);
        expect(row.crossSessionHistory).toBe(true);
      } finally {
        await f.cleanup();
      }
    });
  });
});
