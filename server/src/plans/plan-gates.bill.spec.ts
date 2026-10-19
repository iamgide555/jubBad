import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DEFAULT_BILL_CONFIG } from '../../../engines/bill.ts';
import { GroupsModule } from '../groups/groups.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsModule } from '../sessions/sessions.module.js';

describe('plan gates on paid bill extras', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let freeId: string;
  let hostId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, GroupsModule, SessionsModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    const tag = randomUUID();
    freeId = (await prisma.user.create({ data: { email: `bg-free-${tag}@example.test`, passwordHash: 'x', role: 'host', plan: 'free' } })).id;
    hostId = (await prisma.user.create({ data: { email: `bg-host-${tag}@example.test`, passwordHash: 'x', role: 'host', plan: 'host' } })).id;
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

  /** A group with two sessions: an older one (optionally with a saved config) and a new one with none. */
  async function fixture(opts: { owner: string; olderConfig?: object; newConfig?: object }) {
    const code = randomUUID();
    const olderCode = randomUUID();
    const newCode = randomUUID();
    await prisma.group.create({ data: { code, name: 'BillGate', ownerId: opts.owner } });
    const p = await prisma.player.create({ data: { groupId: code, name: 'P0', aliases: '[]' } });
    await prisma.session.create({
      data: {
        code: olderCode, groupId: code, courtCount: 1, rawImportText: '', createdAt: new Date(Date.now() - 86_400_000),
        billConfig: opts.olderConfig ? JSON.stringify(opts.olderConfig) : null,
      },
    });
    await prisma.session.create({
      data: {
        code: newCode, groupId: code, courtCount: 1, rawImportText: '',
        billConfig: opts.newConfig ? JSON.stringify(opts.newConfig) : null,
      },
    });
    await prisma.sessionRoster.create({ data: { sessionId: newCode, playerId: p.id } });
    const cleanup = async () => {
      await prisma.sessionRoster.deleteMany({ where: { session: { groupId: code } } });
      await prisma.session.deleteMany({ where: { groupId: code } });
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    };
    return { code, newCode, playerId: p.id, cleanup };
  }

  const refused = { code: 'PLAN_REQUIRED', requiredPlan: 'host' };
  const body = (extra: object = {}) => ({ ...DEFAULT_BILL_CONFIG, model: 'fair', walkInFeeSatang: 0, ...extra });

  it('refuses a host fee, a walk-in fee, or ไม่มา on a free session and writes nothing', async () => {
    const f = await fixture({ owner: freeId });
    try {
      for (const extra of [{ hostFeeSatang: 2000 }, { walkInFeeSatang: 1000 }, { absentIds: [f.playerId] }]) {
        const res = await request(server).post(`/sessions/${f.newCode}/bill-config`).send(body(extra)).expect(403);
        expect(res.body).toMatchObject(refused);
      }
      expect((await prisma.session.findUniqueOrThrow({ where: { code: f.newCode } })).billConfig).toBeNull();
    } finally {
      await f.cleanup();
    }
  });

  it('lets a free session save a fair config with no extras', async () => {
    const f = await fixture({ owner: freeId });
    try {
      await request(server).post(`/sessions/${f.newCode}/bill-config`).send(body({ absentIds: [] })).expect(201);
      await request(server).post(`/sessions/${f.newCode}/bill-config`).send(body()).expect(201);
    } finally {
      await f.cleanup();
    }
  });

  it('lets a host owner save every extra', async () => {
    const f = await fixture({ owner: hostId });
    try {
      const res = await request(server)
        .post(`/sessions/${f.newCode}/bill-config`)
        .send(body({ hostFeeSatang: 2000, walkInFeeSatang: 1000, absentIds: [f.playerId] }))
        .expect(201);
      expect(res.body.config).toMatchObject({ hostFeeSatang: 2000, walkInFeeSatang: 1000 });
    } finally {
      await f.cleanup();
    }
  });

  it('strips a host fee carried over from an earlier paid session on a free session', async () => {
    const f = await fixture({ owner: freeId, olderConfig: { ...DEFAULT_BILL_CONFIG, model: 'fair', hostFeeSatang: 2000, walkInFeeSatang: 1000 } });
    try {
      const res = await request(server).get(`/sessions/${f.newCode}/bill`).expect(200);
      expect(res.body.configSource).toBe('previous');
      expect(res.body.config).toMatchObject({ model: 'fair', hostFeeSatang: 0, walkInFeeSatang: 0, absentIds: [] });
      // The bill itself is computed from the stripped config, not only the echoed one.
      expect(res.body.result.rows.every((r: { hostFeeSatang?: number }) => !r.hostFeeSatang)).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it('keeps the carried-over host fee for a host owner', async () => {
    const f = await fixture({ owner: hostId, olderConfig: { ...DEFAULT_BILL_CONFIG, model: 'fair', hostFeeSatang: 2000 } });
    try {
      const res = await request(server).get(`/sessions/${f.newCode}/bill`).expect(200);
      expect(res.body.configSource).toBe('previous');
      expect(res.body.config.hostFeeSatang).toBe(2000);
    } finally {
      await f.cleanup();
    }
  });

  it('shows a free session the default config with no walk-in fee', async () => {
    const f = await fixture({ owner: freeId });
    try {
      const res = await request(server).get(`/sessions/${f.newCode}/bill`).expect(200);
      expect(res.body.configSource).toBe('default');
      expect(res.body.config).toMatchObject({ hostFeeSatang: 0, walkInFeeSatang: 0 });
    } finally {
      await f.cleanup();
    }
  });

  it('leaves a saved host fee alone on a free session (running state)', async () => {
    const f = await fixture({ owner: freeId, newConfig: { ...DEFAULT_BILL_CONFIG, model: 'fair', hostFeeSatang: 2000 } });
    try {
      const res = await request(server).get(`/sessions/${f.newCode}/bill`).expect(200);
      expect(res.body.configSource).toBe('saved');
      expect(res.body.config.hostFeeSatang).toBe(2000);
    } finally {
      await f.cleanup();
    }
  });
});
