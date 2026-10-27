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

  it('planForUser reads the user own plan, and a missing user resolves to club', async () => {
    const free = await makeUser({ plan: 'free' });
    const host = await makeUser({ plan: 'host', planRenewsAt: new Date(Date.now() + 24 * 3600 * 1000) });
    const lapsed = await makeUser({ plan: 'host', planRenewsAt: new Date(Date.now() - 24 * 3600 * 1000) });
    const admin = await makeUser({ role: 'admin', plan: 'free' });
    expect(await plans.planForUser(free.id)).toBe('free');
    expect(await plans.planForUser(host.id)).toBe('host');
    expect(await plans.planForUser(lapsed.id)).toBe('free');
    expect(await plans.planForUser(admin.id)).toBe('club');
    expect(await plans.planForUser(randomUUID())).toBe('club');
  });

  it('requireUserPlan refuses a free user with PLAN_REQUIRED and passes a high enough plan', async () => {
    const free = await makeUser({ plan: 'free' });
    const host = await makeUser({ plan: 'host' });
    const err = await plans.requireUserPlan(free.id, 'host').catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toEqual({ code: 'PLAN_REQUIRED', requiredPlan: 'host' });
    await expect(plans.requireUserPlan(host.id, 'host')).resolves.toBeUndefined();
    await expect(plans.requireUserPlan(host.id, 'club')).rejects.toBeInstanceOf(ForbiddenException);
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
    expect(res.body).toEqual({ plan: 'free', renewsAt: null, lapsedAt: null, paused: false, archiveHidden: 0 });
  });

  it('GET /groups/:code/plan reports the renewal date as ISO', async () => {
    const renewsAt = new Date(Date.now() + 5 * 24 * 3600 * 1000);
    const owner = await makeUser({ plan: 'host', planRenewsAt: renewsAt });
    const code = await makeGroup(owner.id);
    const res = await request(server).get(`/groups/${code}/plan`).expect(200);
    expect(res.body).toEqual({
      plan: 'host',
      renewsAt: renewsAt.toISOString(),
      lapsedAt: null,
      paused: false,
      archiveHidden: 0,
    });
  });

  async function sessionIn(groupId: string, createdAt: Date) {
    const code = randomUUID();
    await prisma.session.create({ data: { code, groupId, rawImportText: '', createdAt } });
    sessionCodes.push(code);
    return code;
  }
  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 3600 * 1000);

  it('pausedGroupCodes never pauses a group with a night in progress, even when another group has a newer session', async () => {
    const owner = await makeUser({ plan: 'free' });
    const running = await makeGroup(owner.id);
    const other = await makeGroup(owner.id);
    await sessionIn(running, daysAgo(2)); // still open: endedAt is null
    const finished = await sessionIn(other, daysAgo(1));
    await prisma.session.update({ where: { code: finished }, data: { endedAt: daysAgo(1) } });
    expect([...(await plans.pausedGroupCodes(owner.id))]).toEqual([other]);
  });

  it('pausedGroupCodes pauses the older-ranked group of a free owner', async () => {
    const owner = await makeUser({ plan: 'free' });
    const a = await makeGroup(owner.id);
    const b = await makeGroup(owner.id);
    await sessionIn(a, daysAgo(20));
    await sessionIn(b, daysAgo(2));
    expect([...(await plans.pausedGroupCodes(owner.id))]).toEqual([a]);
  });

  it('pausedGroupCodes unpauses the next group once the usable one is deleted', async () => {
    const owner = await makeUser({ plan: 'free' });
    const a = await makeGroup(owner.id);
    const b = await makeGroup(owner.id);
    await sessionIn(a, daysAgo(20));
    const bSession = await sessionIn(b, daysAgo(2));
    await prisma.session.delete({ where: { code: bSession } });
    await prisma.group.delete({ where: { code: b } });
    expect((await plans.pausedGroupCodes(owner.id)).size).toBe(0);
  });

  it('pausedGroupCodes with no sessions anywhere pauses only the older group', async () => {
    const owner = await makeUser({ plan: 'free' });
    const older = await makeGroup(owner.id);
    await prisma.group.update({ where: { code: older }, data: { createdAt: daysAgo(30) } });
    await makeGroup(owner.id);
    expect([...(await plans.pausedGroupCodes(owner.id))]).toEqual([older]);
  });

  it('pausedGroupCodes pauses nothing for a host owner with 2 groups or an admin with 12', async () => {
    const host = await makeUser({ plan: 'host' });
    await makeGroup(host.id);
    await makeGroup(host.id);
    expect((await plans.pausedGroupCodes(host.id)).size).toBe(0);
    const admin = await makeUser({ role: 'admin', plan: 'free' });
    for (let i = 0; i < 12; i++) await makeGroup(admin.id);
    expect((await plans.pausedGroupCodes(admin.id)).size).toBe(0);
  });

  it('isGroupPaused is false for an ownerless or missing group', async () => {
    expect(await plans.isGroupPaused(await makeGroup(null))).toBe(false);
    expect(await plans.isGroupPaused(randomUUID())).toBe(false);
  });

  it('describeGroup reports a lapse, a pause and the hidden archive count', async () => {
    const renewsAt = daysAgo(10);
    const owner = await makeUser({ plan: 'host', planRenewsAt: renewsAt });
    const code = await makeGroup(owner.id);
    await sessionIn(code, daysAgo(60));
    await sessionIn(code, daysAgo(40));
    await sessionIn(code, daysAgo(3));
    const info = await plans.describeGroup(code);
    expect(info).toEqual({
      plan: 'free',
      renewsAt: renewsAt.toISOString(),
      lapsedAt: renewsAt.toISOString(),
      paused: false,
      archiveHidden: 2,
    });
  });

  it('describeCaller reports the cap and counts for a free user, and no limit for an admin', async () => {
    const free = await makeUser({ plan: 'free' });
    await makeGroup(free.id);
    await makeGroup(free.id);
    expect(await plans.describeCaller({ id: free.id, role: 'host' })).toMatchObject({
      plan: 'free',
      groupCount: 2,
      groupLimit: 1,
      lapsedAt: null,
    });
    const admin = await makeUser({ role: 'admin', plan: 'free' });
    expect(await plans.describeCaller({ id: admin.id, role: 'admin' })).toMatchObject({
      plan: 'club',
      groupLimit: null,
    });
  });

  it('describeCaller takes the contact link from UPGRADE_CONTACT_URL, https only', async () => {
    const owner = await makeUser({ plan: 'free' });
    const before = process.env.UPGRADE_CONTACT_URL;
    try {
      process.env.UPGRADE_CONTACT_URL = 'https://line.me/R/ti/p/@jubbad';
      expect((await plans.describeCaller({ id: owner.id, role: 'host' })).upgradeUrl).toBe('https://line.me/R/ti/p/@jubbad');
      process.env.UPGRADE_CONTACT_URL = 'javascript:alert(1)';
      expect((await plans.describeCaller({ id: owner.id, role: 'host' })).upgradeUrl).toBeNull();
      delete process.env.UPGRADE_CONTACT_URL;
      expect((await plans.describeCaller({ id: owner.id, role: 'host' })).upgradeUrl).toBeNull();
    } finally {
      if (before === undefined) delete process.env.UPGRADE_CONTACT_URL;
      else process.env.UPGRADE_CONTACT_URL = before;
    }
  });

  it('GET /groups/:code/plan 404s for an unknown group', async () => {
    await request(server).get(`/groups/${randomUUID()}/plan`).expect(404);
  });
});
