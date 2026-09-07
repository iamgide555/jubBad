import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GroupsService } from './groups.service.js';

describe('GroupsService.listGroups', () => {
  let service: GroupsService;
  let prisma: PrismaService;
  const codes: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [GroupsService],
    }).compile();
    service = moduleRef.get(GroupsService);
    prisma = moduleRef.get(PrismaService);
  });

  afterEach(async () => {
    for (const code of codes.splice(0)) {
      await prisma.session.deleteMany({ where: { groupId: code } });
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  async function makeGroup(name: string, sessions: { createdAt: Date }[] = [], players = 0) {
    const code = randomUUID();
    codes.push(code);
    await prisma.group.create({ data: { code, name } });
    for (let i = 0; i < players; i++) {
      await prisma.player.create({ data: { groupId: code, name: `p${i}`, aliases: '[]' } });
    }
    for (const s of sessions) {
      await prisma.session.create({
        data: {
          code: randomUUID().slice(0, 8),
          groupId: code,
          rawImportText: '',
          createdAt: s.createdAt,
        },
      });
    }
    return code;
  }

  it('reports the counts the admin list needs, so it does not fetch each group', async () => {
    const code = await makeGroup('Counts', [{ createdAt: new Date('2026-01-01') }], 3);
    const row = (await service.listGroups()).find((g) => g.code === code);
    expect(row).toMatchObject({ code, name: 'Counts', sessionCount: 1, playerCount: 3 });
  });

  it('orders by most recent activity, so the group in play tonight is first', async () => {
    const older = await makeGroup('Older', [{ createdAt: new Date('2026-01-01') }]);
    const newer = await makeGroup('Newer', [{ createdAt: new Date('2026-06-01') }]);

    const listed = (await service.listGroups()).map((g) => g.code);
    expect(listed.indexOf(newer)).toBeLessThan(listed.indexOf(older));
  });

  it('includes a group that has no sessions yet', async () => {
    // A group is created the moment a roster is parsed into it, before any
    // session exists. Sorting by session date must not drop those.
    const empty = await makeGroup('Fresh');
    const row = (await service.listGroups()).find((g) => g.code === empty);
    expect(row).toMatchObject({ code: empty, sessionCount: 0, lastSessionAt: null });
  });

  it('gives the last session code so the list can jump straight into it', async () => {
    const code = await makeGroup('Resume', [{ createdAt: new Date('2026-03-03') }]);
    const row = (await service.listGroups()).find((g) => g.code === code);
    expect(typeof row?.lastSessionCode).toBe('string');
  });
});
