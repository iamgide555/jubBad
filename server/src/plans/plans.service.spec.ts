import { randomUUID } from 'node:crypto';
import { ForbiddenException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GroupsModule } from '../groups/groups.module.js';
import { PlansService } from './plans.service.js';

describe('PlansService', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let plans: PlansService;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let adminId: string;
  const userIds: string[] = [];
  const groupCodes: string[] = [];
  const sessionCodes: string[] = [];

  async function makeUser(data: { role?: string; plan: string; planRenewsAt?: Date | null }) {
    const user = await prisma.user.create({
      data: { email: `plans-${randomUUID()}@example.test`, passwordHash: 'test', ...data },
    });
    userIds.push(user.id);
    return user;
  }

  async function makeGroup(ownerId: string | null) {
    const code = randomUUID();
    await prisma.group.create({ data: { code, name: 'Plans', ownerId } });
    groupCodes.push(code);
    return code;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, GroupsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    plans = app.get(PlansService);
    const admin = await prisma.user.create({
      data: { email: `plans-admin-${randomUUID()}@example.test`, passwordHash: 'test', role: 'admin' },
    });
    adminId = admin.id;
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: adminId, role: 'admin' };
      next();
    });
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { code: { in: sessionCodes } } });
    await prisma.group.deleteMany({ where: { code: { in: groupCodes } } });
    await prisma.user.deleteMany({ where: { id: { in: [...userIds, adminId] } } });
    await app.close();
  });

  it('planForGroup is free for a free host', async () => {
    const owner = await makeUser({ plan: 'free' });
    expect(await plans.planForGroup(await makeGroup(owner.id))).toBe('free');
  });

  it('planForGroup is free for a host plan that lapsed yesterday', async () => {
    const owner = await makeUser({ plan: 'host', planRenewsAt: new Date(Date.now() - 24 * 3600 * 1000) });
    expect(await plans.planForGroup(await makeGroup(owner.id))).toBe('free');
  });

  it('planForGroup is host for a host plan still in date', async () => {
    const owner = await makeUser({ plan: 'host', planRenewsAt: new Date(Date.now() + 24 * 3600 * 1000) });
    expect(await plans.planForGroup(await makeGroup(owner.id))).toBe('host');
  });

  it('planForGroup is club for an admin-owned group, an ownerless group and a missing group', async () => {
    const admin = await makeUser({ role: 'admin', plan: 'free' });
    expect(await plans.planForGroup(await makeGroup(admin.id))).toBe('club');
    expect(await plans.planForGroup(await makeGroup(null))).toBe('club');
    expect(await plans.planForGroup(randomUUID())).toBe('club');
  });

  it('requireGroupPlan refuses a free group with PLAN_REQUIRED', async () => {
    const owner = await makeUser({ plan: 'free' });
    const code = await makeGroup(owner.id);
    const err = await plans.requireGroupPlan(code, 'host').catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toEqual({ code: 'PLAN_REQUIRED', requiredPlan: 'host' });
  });

  it('requireGroupPlan passes when the plan is high enough', async () => {
    const owner = await makeUser({ plan: 'host' });
    const code = await makeGroup(owner.id);
    await expect(plans.requireGroupPlan(code, 'host')).resolves.toBeUndefined();
    await expect(plans.requireGroupPlan(code, 'club')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('requireSessionPlan resolves through the session group', async () => {
    const free = await makeUser({ plan: 'free' });
    const club = await makeUser({ plan: 'club' });
    const freeGroup = await makeGroup(free.id);
    const clubGroup = await makeGroup(club.id);
    const freeSession = randomUUID();
    const clubSession = randomUUID();
    await prisma.session.create({ data: { code: freeSession, groupId: freeGroup, rawImportText: '' } });
    await prisma.session.create({ data: { code: clubSession, groupId: clubGroup, rawImportText: '' } });
    sessionCodes.push(freeSession, clubSession);

    expect(await plans.planForSession(freeSession)).toBe('free');
    expect(await plans.planForSession(randomUUID())).toBe('club');
    const err = await plans.requireSessionPlan(freeSession, 'host').catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toEqual({ code: 'PLAN_REQUIRED', requiredPlan: 'host' });
    await expect(plans.requireSessionPlan(clubSession, 'club')).resolves.toBeUndefined();
  });

  it('GET /groups/:code/plan returns the owner plan even when the caller is an admin', async () => {
    const owner = await makeUser({ plan: 'free' });
    const code = await makeGroup(owner.id);
    const res = await request(server).get(`/groups/${code}/plan`).expect(200);
    expect(res.body).toEqual({ plan: 'free', renewsAt: null });
  });

  it('GET /groups/:code/plan reports the renewal date as ISO', async () => {
    const renewsAt = new Date(Date.now() + 5 * 24 * 3600 * 1000);
    const owner = await makeUser({ plan: 'host', planRenewsAt: renewsAt });
    const code = await makeGroup(owner.id);
    const res = await request(server).get(`/groups/${code}/plan`).expect(200);
    expect(res.body).toEqual({ plan: 'host', renewsAt: renewsAt.toISOString() });
  });

  it('GET /groups/:code/plan 404s for an unknown group', async () => {
    await request(server).get(`/groups/${randomUUID()}/plan`).expect(404);
  });
});
