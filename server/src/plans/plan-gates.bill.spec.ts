import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DEFAULT_BILL_CONFIG } from '../../../engines/bill.ts';
import { GroupsModule } from '../groups/groups.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CheckoutService } from '../sessions/checkout.service.js';
import { SessionsModule } from '../sessions/sessions.module.js';

describe('plan gates on paid bill extras', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let freeId: string;
  let hostId: string;
  let lapsedId: string;
  let longLapsedId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, GroupsModule, SessionsModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    const tag = randomUUID();
    freeId = (await prisma.user.create({ data: { email: `bg-free-${tag}@example.test`, passwordHash: 'x', role: 'host', plan: 'free' } })).id;
    hostId = (await prisma.user.create({ data: { email: `bg-host-${tag}@example.test`, passwordHash: 'x', role: 'host', plan: 'host' } })).id;
    // A host plan that ran out an hour ago, and one that ran out three days ago.
    lapsedId = (await prisma.user.create({ data: { email: `bg-lapsed-${tag}@example.test`, passwordHash: 'x', role: 'host', plan: 'host', planRenewsAt: new Date(Date.now() - 3_600_000) } })).id;
    longLapsedId = (await prisma.user.create({ data: { email: `bg-longlapsed-${tag}@example.test`, passwordHash: 'x', role: 'host', plan: 'host', planRenewsAt: new Date(Date.now() - 3 * 86_400_000) } })).id;
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
    await prisma.group.updateMany({ where: { ownerId: { in: [freeId, hostId, lapsedId, longLapsedId] } }, data: { ownerId: null } });
    await prisma.user.deleteMany({ where: { id: { in: [freeId, hostId, lapsedId, longLapsedId] } } });
    await app.close();
  });

  /** A group with two sessions: an older one (optionally with a saved config) and a new one with none. */
  async function fixture(opts: { players?: number; owner: string; olderConfig?: object; newConfig?: object; newCreatedAt?: Date; shuttleTools?: boolean }) {
    const code = randomUUID();
    const olderCode = randomUUID();
    const newCode = randomUUID();
    await prisma.group.create({ data: { code, name: 'BillGate', ownerId: opts.owner } });
    const extra = [];
    for (let i = 1; i < (opts.players ?? 1); i++) extra.push(await prisma.player.create({ data: { groupId: code, name: `P${i}`, aliases: '[]' } }));
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
        ...(opts.newCreatedAt ? { createdAt: opts.newCreatedAt } : {}),
        ...(opts.shuttleTools ? { shuttleToolsEnabled: true, shuttlePriceSatang: 12000 } : {}),
        billConfig: opts.newConfig ? JSON.stringify(opts.newConfig) : null,
      },
    });
    for (const x of [p, ...extra]) await prisma.sessionRoster.create({ data: { sessionId: newCode, playerId: x.id } });
    const cleanup = async () => {
      await prisma.sessionRoster.deleteMany({ where: { session: { groupId: code } } });
      await prisma.session.deleteMany({ where: { groupId: code } });
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    };
    return { code, newCode, playerId: p.id, otherId: extra[0]?.id ?? '', cleanup };
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
  describe('a host plan that lapses after the session was created', () => {
    const paid = { ...DEFAULT_BILL_CONFIG, model: 'fair', hostFeeSatang: 2000, walkInFeeSatang: 1000 };
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

    it('keeps the prefilled host and walk-in fee on the bill and lets them be re-posted', async () => {
      const f = await fixture({ owner: lapsedId, olderConfig: paid, newCreatedAt: hoursAgo(2) });
      try {
        const res = await request(server).get(`/sessions/${f.newCode}/bill`).expect(200);
        expect(res.body.configSource).toBe('previous');
        expect(res.body.config).toMatchObject({ hostFeeSatang: 2000, walkInFeeSatang: 1000 });
        // The gate sees the prefilled value as the stored one, so re-posting it is not "turning it on".
        await request(server)
          .post(`/sessions/${f.newCode}/bill-config`)
          .send(body({ hostFeeSatang: 2000, walkInFeeSatang: 1000 }))
          .expect(201);
      } finally {
        await f.cleanup();
      }
    });

    it('still strips the prefill when the plan had already lapsed at creation', async () => {
      const f = await fixture({ owner: longLapsedId, olderConfig: paid, newCreatedAt: hoursAgo(2) });
      try {
        const res = await request(server).get(`/sessions/${f.newCode}/bill`).expect(200);
        expect(res.body.configSource).toBe('previous');
        expect(res.body.config).toMatchObject({ hostFeeSatang: 0, walkInFeeSatang: 0 });
      } finally {
        await f.cleanup();
      }
    });

    it('quotes a checkout from the same config the bill shows', async () => {
      const perShuttle = { ...DEFAULT_BILL_CONFIG, model: 'perShuttle', startingFeeSatang: 2000, hostFeeSatang: 2000, walkInFeeSatang: 0 };
      const checkout = app.get(CheckoutService, { strict: false });
      const free = await fixture({ owner: longLapsedId, olderConfig: perShuttle, newCreatedAt: hoursAgo(2), shuttleTools: true });
      const kept = await fixture({ owner: lapsedId, olderConfig: perShuttle, newCreatedAt: hoursAgo(2), shuttleTools: true });
      try {
        const stripped = await checkout.preview(free.newCode, free.playerId, 'perShuttle');
        expect(stripped.breakdown.hostFeeSatang).toBe(0);
        const prefilled = await checkout.preview(kept.newCode, kept.playerId, 'perShuttle');
        expect(prefilled.breakdown.hostFeeSatang).toBe(2000);
      } finally {
        await free.cleanup();
        await kept.cleanup();
      }
    });
  });

  describe('a free session with saved paid values (running state)', () => {
    const saved = { ...DEFAULT_BILL_CONFIG, model: 'fair', hostFeeSatang: 2000, walkInFeeSatang: 1000 };
    const post = (code: string, extra: object) => request(server).post(`/sessions/${code}/bill-config`).send(body(extra));

    it('lets the stored values be re-posted unchanged', async () => {
      const f = await fixture({ owner: freeId, newConfig: saved });
      try {
        await post(f.newCode, { hostFeeSatang: 2000, walkInFeeSatang: 1000 }).expect(201);
      } finally {
        await f.cleanup();
      }
    });

    it('lets one paid value be cleared while the other stays', async () => {
      const f = await fixture({ owner: freeId, newConfig: saved });
      try {
        const res = await post(f.newCode, { hostFeeSatang: 0, walkInFeeSatang: 1000 }).expect(201);
        expect(res.body.config).toMatchObject({ hostFeeSatang: 0, walkInFeeSatang: 1000 });
        await post(f.newCode, { hostFeeSatang: 0, walkInFeeSatang: 0 }).expect(201);
      } finally {
        await f.cleanup();
      }
    });

    it('refuses a changed non-zero host or walk-in fee', async () => {
      const f = await fixture({ owner: freeId, newConfig: saved });
      try {
        const a = await post(f.newCode, { hostFeeSatang: 3000, walkInFeeSatang: 1000 }).expect(403);
        expect(a.body).toMatchObject(refused);
        const b = await post(f.newCode, { hostFeeSatang: 2000, walkInFeeSatang: 1500 }).expect(403);
        expect(b.body).toMatchObject(refused);
        const stored = JSON.parse((await prisma.session.findUniqueOrThrow({ where: { code: f.newCode } })).billConfig ?? '{}');
        expect(stored).toMatchObject({ hostFeeSatang: 2000, walkInFeeSatang: 1000 });
      } finally {
        await f.cleanup();
      }
    });

    it('refuses a new ไม่มา id, but lets stored ids be re-sent or reduced', async () => {
      const f = await fixture({ owner: freeId, players: 2, newConfig: { ...DEFAULT_BILL_CONFIG, model: 'fair', walkInFeeSatang: 0 } });
      try {
        await prisma.session.update({
          where: { code: f.newCode },
          data: { billConfig: JSON.stringify({ ...DEFAULT_BILL_CONFIG, model: 'fair', walkInFeeSatang: 0, absentIds: [f.playerId, f.otherId] }) },
        });
        const fresh = await fixture({ owner: freeId, players: 2, newConfig: { ...DEFAULT_BILL_CONFIG, model: 'fair', walkInFeeSatang: 0, absentIds: [] } });
        try {
          const res = await post(fresh.newCode, { absentIds: [fresh.otherId] }).expect(403);
          expect(res.body).toMatchObject(refused);
        } finally {
          await fresh.cleanup();
        }
        await post(f.newCode, { absentIds: [f.playerId, f.otherId] }).expect(201);
        const fewer = await post(f.newCode, { absentIds: [f.otherId] }).expect(201);
        expect(fewer.body.config.absentIds).toEqual([f.otherId]);
        await post(f.newCode, { absentIds: [] }).expect(201);
      } finally {
        await f.cleanup();
      }
    });

    it('still refuses a posted host fee when the config only came from a stripped prefill', async () => {
      const f = await fixture({ owner: freeId, olderConfig: saved });
      try {
        const res = await post(f.newCode, { hostFeeSatang: 2000 }).expect(403);
        expect(res.body).toMatchObject(refused);
      } finally {
        await f.cleanup();
      }
    });

    it('lets a host owner change any paid value', async () => {
      const f = await fixture({ owner: hostId, newConfig: saved });
      try {
        await post(f.newCode, { hostFeeSatang: 3000, walkInFeeSatang: 1500 }).expect(201);
      } finally {
        await f.cleanup();
      }
    });
  });
});
