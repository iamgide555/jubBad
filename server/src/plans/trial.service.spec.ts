import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PlansModule } from './plans.module.js';
import { TrialService } from './trial.service.js';

const NOW = new Date('2026-11-16T03:00:00Z');
const TRIAL_END = '2026-12-16T16:59:59.999Z';

describe('TrialService', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let trials: TrialService;
  const userIds: string[] = [];
  const lineIds: string[] = [];

  const line = () => {
    const id = `U${randomUUID().replace(/-/g, '')}`;
    lineIds.push(id);
    return id;
  };

  async function makeUser(data: { role?: string; plan?: string; planRenewsAt?: Date | null } = {}) {
    const user = await prisma.user.create({
      data: { email: `trial-${randomUUID()}@example.test`, passwordHash: 'test', plan: 'free', ...data },
    });
    userIds.push(user.id);
    return user;
  }

  const apply = (userId: string, lineUserId: string, now: Date = NOW) =>
    prisma.$transaction((tx) => trials.applyOnLink(tx, { userId, lineUserId }, now));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, PlansModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    trials = app.get(TrialService);
  });

  afterEach(async () => {
    await prisma.trialRecord.deleteMany({ where: { lineUserId: { in: lineIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    userIds.length = 0;
    lineIds.length = 0;
  });

  afterAll(() => app.close());

  it('gives a free account the trial', async () => {
    const user = await makeUser();
    const lineUserId = line();
    const until = await apply(user.id, lineUserId);
    expect(until?.toISOString()).toBe(TRIAL_END);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.plan).toBe('host');
    expect(row.planRenewsAt?.toISOString()).toBe(TRIAL_END);
    const record = await prisma.trialRecord.findUnique({ where: { lineUserId } });
    expect(record?.userId).toBe(user.id);
  });

  it('gives nothing when this LINE id has had a trial', async () => {
    const lineUserId = line();
    await apply((await makeUser()).id, lineUserId);
    const second = await makeUser();
    expect(await apply(second.id, lineUserId)).toBeNull();
    const row = await prisma.user.findUniqueOrThrow({ where: { id: second.id } });
    expect(row.plan).toBe('free');
    expect(row.planRenewsAt).toBeNull();
  });

  it('gives nothing when this account has had a trial', async () => {
    const user = await makeUser();
    await apply(user.id, line());
    const before = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await apply(user.id, line())).toBeNull();
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.planRenewsAt).toEqual(before.planRenewsAt);
  });

  it('gives nothing to a club account that never lapses', async () => {
    const user = await makeUser({ plan: 'club', planRenewsAt: null });
    const lineUserId = line();
    expect(await apply(user.id, lineUserId)).toBeNull();
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row).toMatchObject({ plan: 'club', planRenewsAt: null });
    expect(await prisma.trialRecord.findUnique({ where: { lineUserId } })).toBeNull();
  });

  it('gives nothing to an admin', async () => {
    const user = await makeUser({ role: 'admin', plan: 'free' });
    expect(await apply(user.id, line())).toBeNull();
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.plan).toBe('free');
  });

  it('gives the trial to an account whose paid plan has lapsed', async () => {
    const user = await makeUser({ plan: 'host', planRenewsAt: new Date('2026-10-01T00:00:00Z') });
    const until = await apply(user.id, line());
    expect(until?.toISOString()).toBe(TRIAL_END);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.planRenewsAt?.toISOString()).toBe(TRIAL_END);
  });

  it('keeps the record when the user is deleted, so the LINE id cannot earn another', async () => {
    const user = await makeUser();
    const lineUserId = line();
    await apply(user.id, lineUserId);
    await prisma.user.delete({ where: { id: user.id } });
    expect(await trials.availableForLine(lineUserId)).toBe(false);
    const record = await prisma.trialRecord.findUniqueOrThrow({ where: { lineUserId } });
    expect(record.userId).toBeNull();
  });

  it('availableForUser is false once linked, once used, or when not on free', async () => {
    const fresh = await makeUser();
    expect(await trials.availableForUser(fresh.id, NOW)).toBe(true);

    const linked = await makeUser();
    await prisma.user.update({ where: { id: linked.id }, data: { lineUserId: line() } });
    expect(await trials.availableForUser(linked.id, NOW)).toBe(false);

    const used = await makeUser();
    await apply(used.id, line());
    await prisma.user.update({ where: { id: used.id }, data: { plan: 'free', planRenewsAt: null } });
    expect(await trials.availableForUser(used.id, NOW)).toBe(false);

    const paid = await makeUser({ plan: 'club', planRenewsAt: null });
    expect(await trials.availableForUser(paid.id, NOW)).toBe(false);
  });
});
