import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { GroupsModule } from '../groups/groups.module.js';
import { GroupsService } from '../groups/groups.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';

describe('LINE tables and group deletion', () => {
  let prisma: PrismaService;
  let groups: GroupsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, GroupsModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    groups = moduleRef.get(GroupsService);
  });

  it('deleting a group removes its link codes and stored roster messages', async () => {
    const code = `LINE${randomUUID().slice(0, 8)}`;
    await prisma.group.create({ data: { code, name: 'line cascade', lineGroupId: `C${randomUUID()}` } });
    await prisma.lineLinkCode.create({
      data: { groupId: code, codeHash: randomUUID(), expiresAt: new Date(Date.now() + 60_000) },
    });
    await prisma.lineRosterMessage.create({
      data: { groupId: code, text: '1. a', postedAt: new Date(), lineMessageId: randomUUID() },
    });

    await groups.deleteGroup(code);

    expect(await prisma.lineLinkCode.count({ where: { groupId: code } })).toBe(0);
    expect(await prisma.lineRosterMessage.count({ where: { groupId: code } })).toBe(0);
  });

  it('refuses a second group linked to the same LINE group', async () => {
    const lineGroupId = `C${randomUUID()}`;
    const a = `LINE${randomUUID().slice(0, 8)}`;
    const b = `LINE${randomUUID().slice(0, 8)}`;
    await prisma.group.create({ data: { code: a, lineGroupId } });
    await expect(prisma.group.create({ data: { code: b, lineGroupId } })).rejects.toThrow();
    await groups.deleteGroup(a);
  });

  it('a new group defaults the summary card on and a new session has not sent one', async () => {
    const code = `LINE${randomUUID().slice(0, 8)}`;
    await prisma.group.create({ data: { code, name: 'summary defaults' } });
    const group = await prisma.group.findUniqueOrThrow({ where: { code } });
    expect(group.lineSummaryDefault).toBe(true);
    const session = await prisma.session.create({
      data: { code: `S${randomUUID().slice(0, 8)}`, groupId: code, rawImportText: '' },
    });
    expect(session.lineSummarySentAt).toBeNull();
    await groups.deleteGroup(code);
  });

  describe('host DM link', () => {
    const tag = randomUUID().slice(0, 8);
    const mkUser = (lineUserId?: string) =>
      prisma.user.create({
        data: { email: `dm-${tag}-${randomUUID().slice(0, 6)}@example.com`, passwordHash: 'x', lineUserId },
      });
    const created: string[] = [];
    afterAll(async () => {
      await prisma.user.deleteMany({ where: { id: { in: created } } });
    });

    it('lineUserId is unique across users', async () => {
      const lineUserId = `U${randomUUID()}`;
      const a = await mkUser(lineUserId);
      created.push(a.id);
      await expect(mkUser(lineUserId)).rejects.toMatchObject({ code: 'P2002' });
      expect(a.lineLinkedAt).toBeNull();
    });

    it('a stored roster message defaults to not direct', async () => {
      const code = `LINE${randomUUID().slice(0, 8)}`;
      await prisma.group.create({ data: { code, name: 'direct default' } });
      const row = await prisma.lineRosterMessage.create({
        data: { groupId: code, text: '1. a', postedAt: new Date(), lineMessageId: randomUUID() },
      });
      expect(row.direct).toBe(false);
      await groups.deleteGroup(code);
    });

    it('allows one pending roster per host', async () => {
      const u = await mkUser();
      created.push(u.id);
      const data = { userId: u.id, text: '1. a', lineMessageId: randomUUID(), postedAt: new Date() };
      await prisma.linePendingRoster.create({ data });
      await expect(
        prisma.linePendingRoster.create({ data: { ...data, lineMessageId: randomUUID() } }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('deleting a user removes its link codes and pending roster', async () => {
      const u = await mkUser();
      await prisma.lineUserLinkCode.create({
        data: { userId: u.id, codeHash: randomUUID(), expiresAt: new Date(Date.now() + 60_000) },
      });
      await prisma.linePendingRoster.create({
        data: { userId: u.id, text: '1. a', lineMessageId: randomUUID(), postedAt: new Date() },
      });

      await prisma.user.delete({ where: { id: u.id } });

      expect(await prisma.lineUserLinkCode.count({ where: { userId: u.id } })).toBe(0);
      expect(await prisma.linePendingRoster.count({ where: { userId: u.id } })).toBe(0);
    });
  });
});
