import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GroupsModule } from '../groups/groups.module.js';

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

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, GroupsModule],
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
    ['GET export', 'get', (c) => `/groups/${c}/export`],
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
});
