import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module.js';
import { LineModule } from '../line/line.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GroupsService } from './groups.service.js';
import { GroupLevelsService } from './group-levels.service.js';
import { PlansService } from '../plans/plans.service.js';

describe('GroupsService.listPlayersManage', () => {
  let service: GroupsService;
  let prisma: PrismaService;
  const codes: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, LineModule],
      providers: [GroupsService, GroupLevelsService, PlansService],
    }).compile();
    service = moduleRef.get(GroupsService);
    prisma = moduleRef.get(PrismaService);
  });

  afterEach(async () => {
    for (const code of codes.splice(0)) {
      await prisma.pairing.deleteMany({ where: { session: { groupId: code } } });
      await prisma.session.deleteMany({ where: { groupId: code } });
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  it('returns contact info untouched and null rating stats for a player with no matches', async () => {
    const code = randomUUID();
    codes.push(code);
    await prisma.group.create({ data: { code, name: 'G' } });
    const player = await prisma.player.create({
      data: { groupId: code, name: 'Solo', aliases: '[]' },
    });

    const rows = await service.listPlayersManage(code);

    expect(rows).toEqual([
      {
        id: player.id,
        name: 'Solo',
        aliases: [],
        age: null,
        email: null,
        phone: null,
        level: null,
        rating: 1200,
        singlesRating: null,
        winRate: null,
        lineAccount: null,
      },
    ]);
  });

  it('each player carries its linked LINE account or null', async () => {
    const code = randomUUID();
    const lineUserId = `U${randomUUID().replace(/-/g, '')}`;
    codes.push(code);
    await prisma.group.create({ data: { code, name: 'G' } });
    const [linked, hostLinked, bare] = await Promise.all([
      prisma.player.create({ data: { groupId: code, name: 'Linked', aliases: '[]' } }),
      prisma.player.create({ data: { groupId: code, name: 'HostLinked', aliases: '[]' } }),
      prisma.player.create({ data: { groupId: code, name: 'Bare', aliases: '[]' } }),
    ]);
    const hostLineUserId = `U${randomUUID().replace(/-/g, '')}`;
    const account = await prisma.lineAccount.create({
      data: { lineUserId, displayName: 'Somchai', pictureUrl: 'https://profile.example.test/a.jpg' },
    });
    const hostAccount = await prisma.lineAccount.create({
      data: { lineUserId: hostLineUserId, displayName: null, pictureUrl: null },
    });
    try {
      await prisma.playerLineAccount.create({
        data: { groupId: code, playerId: linked.id, lineUserId, linkedBy: 'self' },
      });
      await prisma.playerLineAccount.create({
        data: { groupId: code, playerId: hostLinked.id, lineUserId: hostLineUserId, linkedBy: 'host' },
      });

      const rows = await service.listPlayersManage(code);
      const byId = new Map(rows.map((r) => [r.id, r]));

      expect(byId.get(linked.id)!.lineAccount).toEqual({
        id: account.id,
        displayName: 'Somchai',
        pictureUrl: 'https://profile.example.test/a.jpg',
        linkedBy: 'self',
      });
      expect(byId.get(hostLinked.id)!.lineAccount).toEqual({
        id: hostAccount.id,
        displayName: null,
        pictureUrl: null,
        linkedBy: 'host',
      });
      expect(byId.get(bare.id)!.lineAccount).toBeNull();
      expect(JSON.stringify(rows)).not.toContain(lineUserId);
      expect(JSON.stringify(rows)).not.toContain(hostLineUserId);
    } finally {
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.lineAccount.deleteMany({ where: { id: { in: [account.id, hostAccount.id] } } });
    }
  });

  it('carries age/email/phone through, and computes rating/winRate from match history', async () => {
    const code = randomUUID();
    const sessionCode = randomUUID();
    codes.push(code);
    await prisma.group.create({ data: { code, name: 'G' } });
    const [me, foe] = await Promise.all([
      prisma.player.create({
        data: {
          groupId: code,
          name: 'Me',
          aliases: '[]',
          age: 30,
          email: 'me@example.test',
          phone: '0812345678',
        },
      }),
      prisma.player.create({ data: { groupId: code, name: 'Foe', aliases: '[]' } }),
    ]);
    await prisma.session.create({
      data: { code: sessionCode, groupId: code, courtCount: 1, rawImportText: '' },
    });
    // Singles match, Me beats Foe.
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([me.id]),
        teamB: JSON.stringify([foe.id]),
        confirmedAt: new Date(),
        endedAt: new Date(),
        winner: 'A',
      },
    });

    const rows = await service.listPlayersManage(code);
    const meRow = rows.find((r) => r.id === me.id)!;
    const foeRow = rows.find((r) => r.id === foe.id)!;

    expect(meRow.age).toBe(30);
    expect(meRow.email).toBe('me@example.test');
    expect(meRow.phone).toBe('0812345678');
    expect(meRow.winRate).toBe(1);
    expect(meRow.singlesRating).not.toBeNull();
    expect(meRow.rating).toBe(1200); // never played doubles

    expect(foeRow.age).toBeNull();
    expect(foeRow.winRate).toBe(0);
    expect(foeRow.singlesRating).not.toBeNull();
  });

  it('treats an abandoned (no-winner) match as played but not decisive for winRate', async () => {
    const code = randomUUID();
    const sessionCode = randomUUID();
    codes.push(code);
    await prisma.group.create({ data: { code, name: 'G' } });
    const [me, foe] = await Promise.all([
      prisma.player.create({ data: { groupId: code, name: 'Me', aliases: '[]' } }),
      prisma.player.create({ data: { groupId: code, name: 'Foe', aliases: '[]' } }),
    ]);
    await prisma.session.create({
      data: { code: sessionCode, groupId: code, courtCount: 1, rawImportText: '' },
    });
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([me.id]),
        teamB: JSON.stringify([foe.id]),
        confirmedAt: new Date(),
        endedAt: new Date(),
        // no winner: abandoned
      },
    });

    const rows = await service.listPlayersManage(code);
    const meRow = rows.find((r) => r.id === me.id)!;
    expect(meRow.winRate).toBeNull();
    expect(meRow.singlesRating).toBeNull(); // computeRatingTracks only replays decisive matches
  });
});
