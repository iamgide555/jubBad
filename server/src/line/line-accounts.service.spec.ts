import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { vi } from 'vitest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LineAccountsService, type LineProfile } from './line-accounts.service.js';

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
});
