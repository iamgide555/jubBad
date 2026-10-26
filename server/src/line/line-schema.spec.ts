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
});
