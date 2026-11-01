import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { vi } from 'vitest';
import { GroupsModule } from '../groups/groups.module.js';
import { GroupsService } from '../groups/groups.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LineAccountsService, UNLINKED_RETENTION_DAYS, type LineProfile } from './line-accounts.service.js';

describe('LineAccountsService.touch', () => {
  let prisma: PrismaService;
  let accounts: LineAccountsService;
  const groupCodes: string[] = [];
  const lineUserIds: string[] = [];

  async function makeGroup(): Promise<string> {
    const code = `la-${randomUUID().slice(0, 10)}`;
    groupCodes.push(code);
    await prisma.group.create({ data: { code, name: code } });
    return code;
  }

  function profile(displayName: string | null = null, pictureUrl: string | null = null): LineProfile {
    const lineUserId = `U${randomUUID().replace(/-/g, '')}`;
    lineUserIds.push(lineUserId);
    return { lineUserId, displayName, pictureUrl };
  }

  const account = (lineUserId: string) => prisma.lineAccount.findUniqueOrThrow({ where: { lineUserId } });
  const memberships = (lineUserId: string) =>
    prisma.lineAccountGroup.findMany({ where: { lineAccount: { lineUserId } }, orderBy: { firstSeenAt: 'asc' } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule], providers: [LineAccountsService] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    accounts = moduleRef.get(LineAccountsService);
  });

  afterAll(async () => {
    await prisma.group.deleteMany({ where: { code: { in: groupCodes } } });
    await prisma.lineAccount.deleteMany({ where: { lineUserId: { in: lineUserIds } } });
  });

  afterEach(() => vi.restoreAllMocks());

  it('touch creates the account and the group membership with the given source', async () => {
    const groupId = await makeGroup();
    const p = profile('Nok', 'https://p/nok');
    const now = new Date('2026-11-01T10:00:00Z');
    const id = await accounts.touch(groupId, p, 'roster', now);

    expect(await account(p.lineUserId)).toMatchObject({ id, displayName: 'Nok', pictureUrl: 'https://p/nok', profileAt: now });
    expect(await memberships(p.lineUserId)).toEqual([
      expect.objectContaining({ groupId, lineAccountId: id, source: 'roster', firstSeenAt: now, lastSeenAt: now }),
    ]);
  });

  it('touch again updates lastSeenAt, keeps firstSeenAt and the first source', async () => {
    const groupId = await makeGroup();
    const p = profile('Nok');
    const first = new Date('2026-11-01T10:00:00Z');
    const later = new Date('2026-11-02T10:00:00Z');
    const id = await accounts.touch(groupId, p, 'slip', first);
    expect(await accounts.touch(groupId, p, 'host', later)).toBe(id);

    expect(await memberships(p.lineUserId)).toEqual([
      expect.objectContaining({ groupId, source: 'slip', firstSeenAt: first, lastSeenAt: later }),
    ]);
  });

  it('touch with null name/picture never blanks stored values', async () => {
    const groupId = await makeGroup();
    const p = profile('A', 'https://a');
    const first = new Date('2026-11-01T10:00:00Z');
    await accounts.touch(groupId, p, 'slip', first);
    await accounts.touch(groupId, { ...p, displayName: null, pictureUrl: null }, 'roster', new Date('2026-11-02T10:00:00Z'));

    expect(await account(p.lineUserId)).toMatchObject({ displayName: 'A', pictureUrl: 'https://a', profileAt: first });
  });

  it('touch with a new name updates it and profileAt', async () => {
    const groupId = await makeGroup();
    const p = profile('A', 'https://a');
    await accounts.touch(groupId, p, 'slip', new Date('2026-11-01T10:00:00Z'));
    const later = new Date('2026-11-02T10:00:00Z');
    await accounts.touch(groupId, { ...p, displayName: 'B', pictureUrl: null }, 'roster', later);

    expect(await account(p.lineUserId)).toMatchObject({ displayName: 'B', pictureUrl: 'https://a', profileAt: later });
  });

  it('the same LINE user in two groups is one LineAccount with two memberships', async () => {
    const g1 = await makeGroup();
    const g2 = await makeGroup();
    const p = profile('Nok');
    const id1 = await accounts.touch(g1, p, 'roster', new Date('2026-11-01T10:00:00Z'));
    const id2 = await accounts.touch(g2, p, 'claim', new Date('2026-11-02T10:00:00Z'));

    expect(id2).toBe(id1);
    expect(await prisma.lineAccount.count({ where: { lineUserId: p.lineUserId } })).toBe(1);
    expect((await memberships(p.lineUserId)).map((m) => [m.groupId, m.source])).toEqual([
      [g1, 'roster'],
      [g2, 'claim'],
    ]);
  });

  it('concurrent touches for a new user produce one account and one membership', async () => {
    const groupId = await makeGroup();
    const p = profile('Nok');
    const [a, b] = await Promise.all([accounts.touch(groupId, p, 'roster'), accounts.touch(groupId, p, 'slip')]);

    expect(a).toBe(b);
    expect(await prisma.lineAccount.count({ where: { lineUserId: p.lineUserId } })).toBe(1);
    expect(await memberships(p.lineUserId)).toHaveLength(1);
  });

  it('retries once after losing a unique race, and gives up on a second loss', async () => {
    const groupId = await makeGroup();
    const p = profile('Nok');
    const p2002 = () => new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
    const upsert = vi.spyOn(prisma.lineAccountGroup, 'upsert').mockRejectedValueOnce(p2002() as never);
    await accounts.touch(groupId, p, 'roster');
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(await memberships(p.lineUserId)).toHaveLength(1);

    upsert.mockRejectedValueOnce(p2002() as never).mockRejectedValueOnce(p2002() as never);
    await expect(accounts.touch(groupId, p, 'roster')).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it('retries once when a sweep removes the account between the two upserts (foreign key violation)', async () => {
    const groupId = await makeGroup();
    const p = profile('Nok');
    const p2003 = new Prisma.PrismaClientKnownRequestError('fk', { code: 'P2003', clientVersion: 'test' });
    const upsert = vi.spyOn(prisma.lineAccountGroup, 'upsert').mockRejectedValueOnce(p2003 as never);

    const id = await accounts.touch(groupId, p, 'roster');

    expect(upsert).toHaveBeenCalledTimes(2);
    expect((await account(p.lineUserId)).id).toBe(id);
    expect(await memberships(p.lineUserId)).toHaveLength(1);

    upsert.mockRejectedValueOnce(p2003 as never).mockRejectedValueOnce(p2003 as never);
    await expect(accounts.touch(groupId, p, 'roster')).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it('lastSeenAt never moves backwards: an older sighting is ignored, a newer one advances it', async () => {
    const groupId = await makeGroup();
    const p = profile('Nok');
    const first = new Date('2026-11-05T10:00:00Z');
    const older = new Date('2026-11-03T10:00:00Z');
    const newer = new Date('2026-11-09T10:00:00Z');
    await accounts.touch(groupId, p, 'slip', first);

    await accounts.touch(groupId, p, 'roster', older);
    expect(await memberships(p.lineUserId)).toEqual([expect.objectContaining({ source: 'slip', firstSeenAt: first, lastSeenAt: first })]);

    await accounts.touch(groupId, p, 'roster', newer);
    expect(await memberships(p.lineUserId)).toEqual([expect.objectContaining({ source: 'slip', firstSeenAt: first, lastSeenAt: newer })]);
  });

  it('an older-timed profile does not overwrite a newer-timed one', async () => {
    const groupId = await makeGroup();
    const p = profile('New name', 'https://new');
    const newer = new Date('2026-11-09T10:00:00Z');
    const older = new Date('2026-11-03T10:00:00Z');
    await accounts.touch(groupId, p, 'slip', newer);

    await accounts.touch(groupId, { ...p, displayName: 'Old name', pictureUrl: 'https://old' }, 'roster', older);

    expect(await account(p.lineUserId)).toMatchObject({ displayName: 'New name', pictureUrl: 'https://new', profileAt: newer });
  });

  it('an account created without a profile takes the first profile it is given, whenever it was posted', async () => {
    const groupId = await makeGroup();
    const p = profile();
    await accounts.touch(groupId, p, 'roster', new Date('2026-11-09T10:00:00Z'));
    const posted = new Date('2026-11-03T10:00:00Z');

    await accounts.touch(groupId, { ...p, displayName: 'Nok' }, 'roster', posted);

    expect(await account(p.lineUserId)).toMatchObject({ displayName: 'Nok', profileAt: posted });
  });
});

describe('LineAccountsService.sweep', () => {
  let prisma: PrismaService;
  let accounts: LineAccountsService;
  let groups: GroupsService;
  const groupCodes: string[] = [];
  const lineUserIds: string[] = [];
  const now = new Date('2027-01-01T00:00:00Z');
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

  async function makeGroup(): Promise<string> {
    const code = `sw-${randomUUID().slice(0, 10)}`;
    groupCodes.push(code);
    await prisma.group.create({ data: { code, name: code } });
    return code;
  }

  function profile(): LineProfile {
    const lineUserId = `U${randomUUID().replace(/-/g, '')}`;
    lineUserIds.push(lineUserId);
    return { lineUserId, displayName: 'Nok', pictureUrl: null };
  }

  async function link(groupId: string, lineUserId: string): Promise<void> {
    const player = await prisma.player.create({ data: { groupId, name: `p-${randomUUID().slice(0, 6)}`, aliases: '[]' } });
    await prisma.playerLineAccount.create({ data: { groupId, playerId: player.id, lineUserId, linkedBy: 'host' } });
  }

  const membershipCount = (groupId: string, lineUserId: string) =>
    prisma.lineAccountGroup.count({ where: { groupId, lineAccount: { lineUserId } } });
  const accountCount = (lineUserId: string) => prisma.lineAccount.count({ where: { lineUserId } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, GroupsModule],
      providers: [LineAccountsService],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    accounts = moduleRef.get(LineAccountsService);
    groups = moduleRef.get(GroupsService);
  });

  afterAll(async () => {
    // Groups with players need deleteGroup's full teardown; one test already deleted its group.
    for (const code of groupCodes) await groups.deleteGroup(code).catch(() => undefined);
    await prisma.lineAccount.deleteMany({ where: { lineUserId: { in: lineUserIds } } });
  });

  afterEach(() => vi.restoreAllMocks());

  it('UNLINKED_RETENTION_DAYS is 365', () => {
    expect(UNLINKED_RETENTION_DAYS).toBe(365);
  });

  it('sweep deletes an unlinked membership unseen for more than 365 days', async () => {
    const groupId = await makeGroup();
    const keeper = await makeGroup();
    const p = profile();
    await accounts.touch(groupId, p, 'roster', daysAgo(366));
    await accounts.touch(keeper, p, 'roster', now);

    const result = await accounts.sweep(now);

    expect(result.memberships).toBeGreaterThanOrEqual(1);
    expect(await membershipCount(groupId, p.lineUserId)).toBe(0);
    expect(await membershipCount(keeper, p.lineUserId)).toBe(1);
    expect(await accountCount(p.lineUserId)).toBe(1);
  });

  it('sweep keeps an unlinked membership seen 364 days ago', async () => {
    const groupId = await makeGroup();
    const p = profile();
    await accounts.touch(groupId, p, 'roster', daysAgo(364));

    await accounts.sweep(now);

    expect(await membershipCount(groupId, p.lineUserId)).toBe(1);
    expect(await accountCount(p.lineUserId)).toBe(1);
  });

  it('sweep does not delete a membership refreshed after it was selected as stale', async () => {
    const groupId = await makeGroup();
    const p = profile();
    await accounts.touch(groupId, p, 'roster', daysAgo(400));
    const stale = await prisma.lineAccountGroup.findMany({ where: { groupId }, select: { id: true, groupId: true, lineAccount: { select: { lineUserId: true } } } });
    await accounts.touch(groupId, p, 'roster', now);
    vi.spyOn(prisma.lineAccountGroup, 'findMany').mockResolvedValueOnce(stale as never);

    await accounts.sweep(now);

    expect(await membershipCount(groupId, p.lineUserId)).toBe(1);
    expect(await accountCount(p.lineUserId)).toBe(1);
  });

  it('sweep does not delete a membership linked after it was selected as stale', async () => {
    const groupId = await makeGroup();
    const p = profile();
    await accounts.touch(groupId, p, 'roster', daysAgo(400));
    const stale = await prisma.lineAccountGroup.findMany({ where: { groupId }, select: { id: true, groupId: true, lineAccount: { select: { lineUserId: true } } } });
    await link(groupId, p.lineUserId);
    vi.spyOn(prisma.lineAccountGroup, 'findMany').mockResolvedValueOnce(stale as never);

    await accounts.sweep(now);

    expect(await membershipCount(groupId, p.lineUserId)).toBe(1);
    expect(await prisma.playerLineAccount.count({ where: { groupId, lineUserId: p.lineUserId } })).toBe(1);
  });

  it('sweep keeps a linked membership however old', async () => {
    const groupId = await makeGroup();
    const p = profile();
    await accounts.touch(groupId, p, 'roster', daysAgo(2000));
    await link(groupId, p.lineUserId);

    await accounts.sweep(now);

    expect(await membershipCount(groupId, p.lineUserId)).toBe(1);
    expect(await accountCount(p.lineUserId)).toBe(1);
    expect(await prisma.playerLineAccount.count({ where: { groupId, lineUserId: p.lineUserId } })).toBe(1);
  });

  it('sweep treats a link in another group as not linking this group', async () => {
    const stale = await makeGroup();
    const other = await makeGroup();
    const p = profile();
    await accounts.touch(stale, p, 'roster', daysAgo(400));
    await accounts.touch(other, p, 'roster', now);
    await link(other, p.lineUserId);

    await accounts.sweep(now);

    expect(await membershipCount(stale, p.lineUserId)).toBe(0);
    expect(await membershipCount(other, p.lineUserId)).toBe(1);
    expect(await accountCount(p.lineUserId)).toBe(1);
  });

  it('sweep deletes a LineAccount left with no membership and no link', async () => {
    const groupId = await makeGroup();
    const p = profile();
    await accounts.touch(groupId, p, 'roster', daysAgo(366));

    const result = await accounts.sweep(now);

    expect(result.accounts).toBeGreaterThanOrEqual(1);
    expect(await accountCount(p.lineUserId)).toBe(0);
  });

  it('sweep keeps an account still a member of another group', async () => {
    const g1 = await makeGroup();
    const g2 = await makeGroup();
    const p = profile();
    await accounts.touch(g1, p, 'roster', now);
    await accounts.touch(g2, p, 'roster', daysAgo(10));

    await accounts.sweep(now);

    expect(await accountCount(p.lineUserId)).toBe(1);
    expect(await membershipCount(g1, p.lineUserId)).toBe(1);
    expect(await membershipCount(g2, p.lineUserId)).toBe(1);
  });

  it('sweep is safe to repeat', async () => {
    const groupId = await makeGroup();
    const p = profile();
    await accounts.touch(groupId, p, 'roster', daysAgo(366));

    await accounts.sweep(now);
    const second = await accounts.sweep(now);

    expect(second).toEqual({ memberships: 0, accounts: 0 });
  });

  it('deleting a group then sweeping removes the orphaned account', async () => {
    const groupId = await makeGroup();
    const p = profile();
    await accounts.touch(groupId, p, 'roster', now);
    expect(await accountCount(p.lineUserId)).toBe(1);

    await groups.deleteGroup(groupId);
    expect(await accountCount(p.lineUserId)).toBe(1);

    await accounts.sweep(now);

    expect(await accountCount(p.lineUserId)).toBe(0);
  });
});
