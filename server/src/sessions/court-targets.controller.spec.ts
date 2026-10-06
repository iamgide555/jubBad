import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { GroupsModule } from '../groups/groups.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsModule } from './sessions.module.js';

describe('per-court target level', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let adminId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, GroupsModule, SessionsModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    adminId = (await prisma.user.create({ data: { email: `ct-admin-${randomUUID()}@example.test`, passwordHash: 'x', role: 'admin' } })).id;
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

  async function fixture(levels: (string | null)[], opts: { mode: string; courtModes?: string[]; courts?: number }) {
    const code = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code, name: 'CT', ownerId: adminId } });
    const players = [];
    for (const [i, level] of levels.entries()) {
      players.push(
        await prisma.player.create({
          data: {
            groupId: code,
            name: `P${i}`,
            aliases: '[]',
            level,
            levelSeed: level ? 1200 : null,
            levelSetAt: level ? new Date(Date.now() - 3_600_000) : null,
          },
        })
      );
    }
    await prisma.session.create({
      data: {
        code: sessionCode,
        groupId: code,
        courtCount: opts.courts ?? 2,
        rawImportText: '',
        mode: opts.mode,
        courtModes: opts.courtModes ? JSON.stringify(opts.courtModes) : null,
      },
    });
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

  const MIXED = ['N', 'N', 'N', 'N', 'P+', 'P+', 'P+', 'P+'];

  it('stores a court target, reads it back per court, and rejects junk', async () => {
    const f = await fixture(MIXED, { mode: 'level' });
    try {
      const set = await request(server).post(`/sessions/${f.sessionCode}/courts/2/target`).send({ target: 'high' }).expect(201);
      expect(set.body).toEqual({ code: f.sessionCode, courtNumber: 2, target: 'high' });
      const session = (await request(server).get(`/sessions/${f.sessionCode}`).expect(200)).body;
      expect(session.courts.map((c: { target: string }) => c.target)).toEqual(['auto', 'high']);
      await request(server).post(`/sessions/${f.sessionCode}/courts/1/target`).send({ target: 'pro' }).expect(400);
      await request(server).post(`/sessions/${f.sessionCode}/courts/9/target`).send({ target: 'low' }).expect(400);
    } finally {
      await f.cleanup();
    }
  });

  it('reads a stored target as auto on a court that is not in level mode', async () => {
    const f = await fixture(MIXED, { mode: 'variety' });
    try {
      await request(server).post(`/sessions/${f.sessionCode}/courts/1/target`).send({ target: 'high' }).expect(201);
      const session = (await request(server).get(`/sessions/${f.sessionCode}`).expect(200)).body;
      expect(session.courts[0].target).toBe('auto');
    } finally {
      await f.cleanup();
    }
  });

  it('refuses once the session has ended', async () => {
    const f = await fixture(MIXED, { mode: 'level' });
    try {
      await prisma.session.update({ where: { code: f.sessionCode }, data: { endedAt: new Date() } });
      await request(server).post(`/sessions/${f.sessionCode}/courts/1/target`).send({ target: 'low' }).expect(409);
    } finally {
      await f.cleanup();
    }
  });

  async function seatedLevels(f: Awaited<ReturnType<typeof fixture>>, court: number): Promise<Set<string | null>> {
    const row = await prisma.pairing.findFirstOrThrow({ where: { sessionId: f.sessionCode, courtNumber: court } });
    const levelOf = new Map(f.players.map((p) => [p.id, p.level]));
    return new Set([...JSON.parse(row.teamA), ...JSON.parse(row.teamB)].map((id: string) => levelOf.get(id) ?? null));
  }

  it('propose: a High court seats the pros and a Low court the beginners, requested out of order', async () => {
    const f = await fixture(MIXED, { mode: 'level' });
    try {
      await request(server).post(`/sessions/${f.sessionCode}/courts/1/target`).send({ target: 'low' }).expect(201);
      await request(server).post(`/sessions/${f.sessionCode}/courts/2/target`).send({ target: 'high' }).expect(201);
      // Court 2 first: the engine's first court is the requested one, not court 1.
      await request(server).post(`/sessions/${f.sessionCode}/courts/2/propose`).send({}).expect(201);
      await request(server).post(`/sessions/${f.sessionCode}/courts/1/propose`).send({}).expect(201);
      expect(await seatedLevels(f, 2)).toEqual(new Set(['P+']));
      expect(await seatedLevels(f, 1)).toEqual(new Set(['N']));
    } finally {
      await f.cleanup();
    }
  });

  it('fill-all: court targets hold across every idle court', async () => {
    const f = await fixture(MIXED, { mode: 'level' });
    try {
      await request(server).post(`/sessions/${f.sessionCode}/courts/1/target`).send({ target: 'high' }).expect(201);
      await request(server).post(`/sessions/${f.sessionCode}/courts/2/target`).send({ target: 'low' }).expect(201);
      await request(server).post(`/sessions/${f.sessionCode}/courts/fill`).send({}).expect(201);
      expect(await seatedLevels(f, 1)).toEqual(new Set(['P+']));
      expect(await seatedLevels(f, 2)).toEqual(new Set(['N']));
    } finally {
      await f.cleanup();
    }
  });

  it('a target on a non-level court is ignored: a custom session\'s variety court still proposes normally', async () => {
    const f = await fixture(MIXED, { mode: 'custom', courtModes: ['variety', 'variety'] });
    try {
      await request(server).post(`/sessions/${f.sessionCode}/courts/1/target`).send({ target: 'high' }).expect(201);
      const res = await request(server).post(`/sessions/${f.sessionCode}/courts/1/propose`).send({}).expect(201);
      expect(res.body.ok).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it('Auto everywhere behaves as before (a mixed roster with no targets still proposes full courts)', async () => {
    const f = await fixture(MIXED, { mode: 'level' });
    try {
      await request(server).post(`/sessions/${f.sessionCode}/courts/fill`).send({}).expect(201);
      expect(await prisma.pairing.count({ where: { sessionId: f.sessionCode } })).toBe(2);
    } finally {
      await f.cleanup();
    }
  });
});
