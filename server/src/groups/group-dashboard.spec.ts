import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GroupDashboardService } from './group-dashboard.service.js';
import { DASHBOARD_SESSION_LIMIT } from './dashboard-standings.js';

describe('GroupDashboardService', () => {
  let service: GroupDashboardService;
  let prisma: PrismaService;
  const codes: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [GroupDashboardService],
    }).compile();
    service = moduleRef.get(GroupDashboardService);
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

  async function makeGroup(name: string | null = 'Dash') {
    const code = randomUUID();
    const token = randomUUID().replace(/-/g, '').slice(0, 22);
    codes.push(code);
    await prisma.group.create({ data: { code, name, shareToken: token } });
    return { code, token };
  }

  const makePlayer = (groupId: string, name: string) =>
    prisma.player.create({ data: { groupId, name, aliases: '[]' } }).then((p) => p.id);

  const makeSession = (
    groupId: string,
    over: { date?: string; venue?: string; createdAt?: Date; ended?: boolean } = {}
  ) => {
    const code = randomUUID().slice(0, 8);
    return prisma.session
      .create({
        data: {
          code,
          groupId,
          rawImportText: '',
          date: over.date ?? null,
          venue: over.venue ?? null,
          createdAt: over.createdAt ?? new Date(),
          endedAt: over.ended === false ? null : new Date(),
        },
      })
      .then(() => code);
  };

  let matchNumber = 0;
  const addMatch = (
    sessionId: string,
    teamA: (string | null)[],
    teamB: (string | null)[],
    confirmed = true
  ) =>
    prisma.pairing.create({
      data: {
        sessionId,
        courtNumber: 1,
        matchNumber: ++matchNumber,
        teamA: JSON.stringify(teamA),
        teamB: JSON.stringify(teamB),
        confirmedAt: confirmed ? new Date() : null,
      },
    });

  it('404s an unknown token', async () => {
    await expect(service.get('nope-nope-nope-nope-no')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s once the token is revoked, and once the group is gone', async () => {
    const { code, token } = await makeGroup();
    await expect(service.get(token)).resolves.toBeDefined();

    await prisma.group.update({ where: { code }, data: { shareToken: null } });
    await expect(service.get(token)).rejects.toBeInstanceOf(NotFoundException);

    await prisma.group.update({ where: { code }, data: { shareToken: token } });
    await prisma.group.delete({ where: { code } });
    await expect(service.get(token)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns empty lists for a group with no sessions', async () => {
    const { token } = await makeGroup('Empty');
    expect(await service.get(token)).toEqual({
      groupName: 'Empty',
      lastSessionDate: null,
      sessions: [],
      standings: [],
    });
  });

  it('builds sessions and participation standings from confirmed matches', async () => {
    const { code, token } = await makeGroup();
    const [a, b, c, d] = await Promise.all(
      ['Ann', 'Ben', 'Cat', 'Dan'].map((n) => makePlayer(code, n))
    );
    const older = await makeSession(code, { date: '2026-09-01', createdAt: new Date('2026-09-01') });
    const newer = await makeSession(code, {
      date: '2026-09-08',
      venue: 'Gym',
      createdAt: new Date('2026-09-08'),
    });
    await addMatch(older, [a, b], [c, d]);
    await addMatch(newer, [a, b], [c, d]);
    await addMatch(newer, [a, c], [b, d]);

    const dash = await service.get(token);
    expect(dash.lastSessionDate).toBe('2026-09-08');
    expect(dash.sessions.map((s) => [s.code, s.matchCount, s.playerCount, s.live])).toEqual([
      [newer, 2, 4, false],
      [older, 1, 4, false],
    ]);
    expect(dash.sessions[0].venue).toBe('Gym');
    expect(dash.standings).toEqual([
      { name: 'Ann', sessionsAttended: 2, gamesPlayed: 3 },
      { name: 'Ben', sessionsAttended: 2, gamesPlayed: 3 },
      { name: 'Cat', sessionsAttended: 2, gamesPlayed: 3 },
      { name: 'Dan', sessionsAttended: 2, gamesPlayed: 3 },
    ]);
  });

  it('ignores a proposed match, including a custom-mode draft with an empty seat', async () => {
    const { code, token } = await makeGroup();
    const [a, b] = await Promise.all(['Ann', 'Ben'].map((n) => makePlayer(code, n)));
    const s = await makeSession(code, { ended: false });
    await addMatch(s, [a, null], [b, null], false);
    const dash = await service.get(token);
    expect(dash.standings).toEqual([]);
    expect(dash.sessions).toEqual([expect.objectContaining({ code: s, matchCount: 0, live: true })]);
  });

  it('omits an ended session nobody played but lists a live one', async () => {
    const { code, token } = await makeGroup();
    await makeSession(code, { ended: true });
    const live = await makeSession(code, { ended: false });
    const dash = await service.get(token);
    expect(dash.sessions.map((s) => [s.code, s.live])).toEqual([[live, true]]);
  });

  it('lists only the newest 30 sessions', async () => {
    const { code, token } = await makeGroup();
    const a = await makePlayer(code, 'Ann');
    for (let i = 0; i < DASHBOARD_SESSION_LIMIT + 2; i++) {
      const s = await makeSession(code, { createdAt: new Date(2026, 0, 1 + i) });
      await addMatch(s, [a], [a]);
    }
    const dash = await service.get(token);
    expect(dash.sessions).toHaveLength(DASHBOARD_SESSION_LIMIT);
    expect(dash.standings[0].sessionsAttended).toBe(DASHBOARD_SESSION_LIMIT + 2);
  });

  it('leaks no player id, rating, level or contact data', async () => {
    const { code, token } = await makeGroup();
    const a = await prisma.player.create({
      data: { groupId: code, name: 'Ann', aliases: '[]', email: 'ann@example.test', phone: '0812345678', level: 'B' },
    });
    const s = await makeSession(code);
    await addMatch(s, [a.id], [a.id]);
    const dash = await service.get(token);
    const json = JSON.stringify(dash);
    expect(json).not.toContain(a.id);
    expect(json).not.toContain('ann@example.test');
    expect(json).not.toContain('0812345678');
    expect(json).not.toMatch(/rating|level|winRate/i);
    expect(Object.keys(dash).sort()).toEqual(['groupName', 'lastSessionDate', 'sessions', 'standings']);
    expect(Object.keys(dash.sessions[0]).sort()).toEqual([
      'code', 'createdAt', 'date', 'live', 'matchCount', 'playerCount', 'venue',
    ]);
  });
});
