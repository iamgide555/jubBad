import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GroupsService } from './groups.service.js';
import { GroupLevelsService } from './group-levels.service.js';
import { PlansService } from '../plans/plans.service.js';

// Ownership filtering is exercised elsewhere (the auth boundary spec); an
// admin caller sees every group regardless of owner, which is what keeps
// these tests about the listing/ordering logic rather than about who owns
// what.
const ADMIN_CALLER = { id: 'list-groups-test-admin', role: 'admin' };

describe('GroupsService.listGroups', () => {
  let service: GroupsService;
  let prisma: PrismaService;
  const codes: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [GroupsService, GroupLevelsService, PlansService],
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
    const row = (await service.listGroups(ADMIN_CALLER)).find((g) => g.code === code);
    expect(row).toMatchObject({ code, name: 'Counts', sessionCount: 1, playerCount: 3 });
  });

  it('orders by most recent activity, so the group in play tonight is first', async () => {
    const older = await makeGroup('Older', [{ createdAt: new Date('2026-01-01') }]);
    const newer = await makeGroup('Newer', [{ createdAt: new Date('2026-06-01') }]);

    const listed = (await service.listGroups(ADMIN_CALLER)).map((g) => g.code);
    expect(listed.indexOf(newer)).toBeLessThan(listed.indexOf(older));
  });

  it('includes a group that has no sessions yet', async () => {
    // A group is created the moment a roster is parsed into it, before any
    // session exists. Sorting by session date must not drop those.
    const empty = await makeGroup('Fresh');
    const row = (await service.listGroups(ADMIN_CALLER)).find((g) => g.code === empty);
    expect(row).toMatchObject({ code: empty, sessionCount: 0, lastSessionAt: null });
  });

  it('gives the last session code so the list can jump straight into it', async () => {
    const code = await makeGroup('Resume', [{ createdAt: new Date('2026-03-03') }]);
    const row = (await service.listGroups(ADMIN_CALLER)).find((g) => g.code === code);
    expect(typeof row?.lastSessionCode).toBe('string');
  });

  describe('owner info', () => {
    const userIds: string[] = [];
    afterEach(async () => {
      await prisma.group.deleteMany({ where: { ownerId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
    });

    async function makeUser(email: string, role = 'host') {
      const user = await prisma.user.create({
        data: { email: `${randomUUID()}-${email}`, passwordHash: 'x', role },
      });
      userIds.push(user.id);
      return user;
    }
    async function ownedGroup(ownerId: string | null, name: string) {
      const code = randomUUID();
      codes.push(code);
      await prisma.group.create({ data: { code, name, ownerId } });
      return code;
    }

    it('tells an admin which groups are theirs and who owns the rest', async () => {
      const admin = await makeUser('admin@x.test', 'admin');
      const host = await makeUser('host@x.test');
      const mine = await ownedGroup(admin.id, 'Mine');
      const theirs = await ownedGroup(host.id, 'Theirs');
      const orphan = await ownedGroup(null, 'Orphan');

      const rows = await service.listGroups({ id: admin.id, role: 'admin' });
      expect(rows.find((g) => g.code === mine)).toMatchObject({ mine: true, ownerEmail: admin.email });
      expect(rows.find((g) => g.code === theirs)).toMatchObject({ mine: false, ownerEmail: host.email });
      expect(rows.find((g) => g.code === orphan)).toMatchObject({ mine: false, ownerEmail: null });
    });

    it('never gives a host the owner fields, not even for their own groups', async () => {
      const host = await makeUser('host@x.test');
      const mine = await ownedGroup(host.id, 'Mine');

      const rows = await service.listGroups({ id: host.id, role: 'host' });
      expect(rows.map((g) => g.code)).toEqual([mine]);
      expect(Object.keys(rows[0])).not.toContain('mine');
      expect(Object.keys(rows[0])).not.toContain('ownerEmail');
    });
  });

  it('marks the group past the owner plan cap as paused, and no other', async () => {
    const owner = await prisma.user.create({
      data: { email: `lg-${randomUUID()}@example.test`, passwordHash: 'x', role: 'host', plan: 'free' },
    });
    try {
      const older = await makeGroup('Older', [{ createdAt: new Date('2026-09-01') }]);
      const newer = await makeGroup('Newer', [{ createdAt: new Date('2026-10-01') }]);
      const unowned = await makeGroup('Unowned', [{ createdAt: new Date('2026-08-01') }]);
      await prisma.group.updateMany({ where: { code: { in: [older, newer] } }, data: { ownerId: owner.id } });
      const rows = await service.listGroups(ADMIN_CALLER);
      const paused = (code: string) => rows.find((g) => g.code === code)?.paused;
      expect(paused(older)).toBe(true);
      expect(paused(newer)).toBe(false);
      expect(paused(unowned)).toBe(false);
    } finally {
      await prisma.group.updateMany({ where: { ownerId: owner.id }, data: { ownerId: null } });
      await prisma.user.delete({ where: { id: owner.id } });
    }
  });
});
