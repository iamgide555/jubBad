import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { computeRatings } from '../../../engines/elo.ts';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GroupsModule } from './groups.module.js';

describe('GroupsController', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let server: ReturnType<INestApplication['getHttpServer']>;

  let testAdminId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, GroupsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);

    // Group.ownerId has a real foreign key to User, so the caller this
    // middleware injects has to be a real row, not just an object shape.
    const testAdmin = await prisma.user.create({
      data: { email: `groups-controller-test-admin-${randomUUID()}@example.test`, passwordHash: 'test', role: 'admin' },
    });
    testAdminId = testAdmin.id;

    // This module has no AuthModule, so nothing ever sets req.user — the
    // controller now reads it for the create-or-own check in parse() and the
    // per-owner filter in list(). Standing in for AuthGuard here with a fixed
    // admin caller keeps this file about group/roster logic, not auth; admin
    // bypasses both checks, matching the unfiltered behaviour these tests
    // already assume.
    app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { id: testAdminId, role: 'admin' };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    // supertest calls listen() itself for every request when the server is not
    // already listening. Under a few hundred requests that churn intermittently
    // produced "socket hang up" and bogus 501s that looked like app failures.
    // Listening once here keeps a single server for the file.
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: testAdminId } });
    await app.close();
  });

  it('returns 404 for a group that does not exist', async () => {
    await request(server).get(`/groups/${randomUUID()}`).expect(404);
  });

  it('creates, reads, renames a group, and lists its players', async () => {
    const code = randomUUID();
    await prisma.group.create({ data: { code, name: 'Original Name' } });
    const player = await prisma.player.create({
      data: { groupId: code, name: 'Alice', aliases: '[]' },
    });

    try {
      const getRes = await request(server).get(`/groups/${code}`).expect(200);
      expect(getRes.body).toEqual({ code, name: 'Original Name', lastSessionCode: null });

      const putRes = await request(server)
        .put(`/groups/${code}`)
        .send({ name: 'Renamed' })
        .expect(200);
      expect(putRes.body).toEqual({ code, name: 'Renamed' });

      const playersRes = await request(server)
        .get(`/groups/${code}/players`)
        .expect(200);
      expect(playersRes.body).toEqual([{ id: player.id, name: 'Alice', aliases: [] }]);
    } finally {
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  it('rejects an empty name on rename', async () => {
    const code = randomUUID();
    await prisma.group.create({ data: { code, name: 'X' } });
    try {
      await request(server).put(`/groups/${code}`).send({ name: '' }).expect(400);
    } finally {
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  it('parses a roster message, upserting the group but never renaming it on re-parse', async () => {
    const code = randomUUID();
    // Verified directly against parseLineRosterMessage before writing this test:
    // header.venue and header.timeSlots[0].courtCount are null for this exact
    // input (the parser doesn't recognize "Court A"/"2 courts" in this phrasing)
    // - this test asserts the real output, not an assumed one.
    const rawText = '8/9/26 Court A\n19.00-20.00 2 courts\n1. Alice\n2. Bob';

    const firstRes = await request(server)
      .post(`/groups/${code}/parse`)
      .send({ groupName: 'First Name', rawText })
      .expect(201);

    expect(firstRes.body.header).toEqual({
      isoDate: '2026-09-08',
      venue: null,
      courtCount: null,
    });
    expect(firstRes.body.rosterReviews).toEqual([
      { inputName: 'Alice', match: { type: 'new' } },
      { inputName: 'Bob', match: { type: 'new' } },
    ]);
    expect(firstRes.body.waitlistReviews).toEqual([]);
    expect(firstRes.body.warnings).toEqual([
      'The date "8/9/26" has an ambiguous two-digit year — read as 2026-09-08, please confirm the session date.',
    ]);
    expect(firstRes.body.unrecognizedLines).toEqual([]);

    try {
      const group = await prisma.group.findUniqueOrThrow({ where: { code } });
      expect(group.name).toBe('First Name');

      await request(server)
        .post(`/groups/${code}/parse`)
        .send({ groupName: 'Second Name', rawText })
        .expect(201);

      const groupAfter = await prisma.group.findUniqueOrThrow({ where: { code } });
      expect(groupAfter.name).toBe('First Name');
    } finally {
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  it('rejects an empty roster message on parse', async () => {
    await request(server)
      .post(`/groups/${randomUUID()}/parse`)
      .send({ groupName: 'X', rawText: '' })
      .expect(400);
  });
  it('lists a group\'s sessions newest first with a match count', async () => {
    const code = randomUUID();
    await prisma.group.create({ data: { code, name: 'G' } });
    const older = randomUUID();
    const newer = randomUUID();
    await prisma.session.create({
      data: {
        code: older,
        groupId: code,
        date: '2026-09-01',
        venue: 'Old Gym',
        courtCount: 2,
        rawImportText: '',
        createdAt: new Date('2026-09-01T10:00:00.000Z'),
        endedAt: new Date('2026-09-01T12:00:00.000Z'),
      },
    });
    await prisma.session.create({
      data: {
        code: newer,
        groupId: code,
        date: '2026-09-08',
        courtCount: 1,
        rawImportText: '',
        createdAt: new Date('2026-09-08T10:00:00.000Z'),
      },
    });
    await prisma.pairing.create({
      data: {
        // This proposal must not count in archive history.
        sessionId: newer,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify(['p1', 'p2']),
        teamB: JSON.stringify(['p3', 'p4']),
      },
    });
    await prisma.pairing.create({
      data: {
        sessionId: older,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify(['p1', 'p2']),
        teamB: JSON.stringify(['p3', 'p4']),
        confirmedAt: new Date(),
        endedAt: new Date(),
        winner: 'A',
      },
    });

    try {
      const res = await request(server).get(`/groups/${code}/sessions`).expect(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].code).toBe(newer);
      expect(res.body[0].endedAt).toBeNull();
      expect(res.body[1].code).toBe(older);
      expect(res.body[1].venue).toBe('Old Gym');
      expect(res.body[1].matchCount).toBe(1);
      expect(res.body[0].matchCount).toBe(0);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: { in: [older, newer] } } });
      await prisma.session.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  it('404s listing sessions for an unknown group', async () => {
    await request(server).get(`/groups/${randomUUID()}/sessions`).expect(404);
  });

  it('reports a player\'s record, best partner and most-faced opponent', async () => {
    const code = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code, name: 'G' } });
    const [me, ally, foe, other] = await Promise.all(
      ['Me', 'Ally', 'Foe', 'Other'].map((name) =>
        prisma.player.create({ data: { groupId: code, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: code, courtCount: 1, rawImportText: '' },
    });
    // Me + Ally beat Foe + Other twice; Me + Other lose to Foe + Ally once.
    const played = [
      { a: [me.id, ally.id], b: [foe.id, other.id], w: 'A' },
      { a: [me.id, ally.id], b: [foe.id, other.id], w: 'A' },
      { a: [me.id, other.id], b: [foe.id, ally.id], w: 'B' },
    ];
    for (const [i, m] of played.entries()) {
      await prisma.pairing.create({
        data: {
          sessionId: sessionCode,
          courtNumber: 1,
          matchNumber: i + 1,
          teamA: JSON.stringify(m.a),
          teamB: JSON.stringify(m.b),
          confirmedAt: new Date(Date.now() + i * 1000),
          endedAt: new Date(),
          winner: m.w,
        },
      });
    }
    // This match was played but abandoned before a result. It belongs in
    // played/partner/opponent totals, but must not create an Elo or win/loss.
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 4,
        teamA: JSON.stringify([me.id, ally.id]),
        teamB: JSON.stringify([foe.id, other.id]),
        confirmedAt: new Date(Date.now() + 4_000),
        endedAt: new Date(),
      },
    });

    try {
      const res = await request(server)
        .get(`/groups/${code}/players/${me.id}/stats`)
        .expect(200);
      expect(res.body.name).toBe('Me');
      expect(res.body.played).toBe(4);
      expect(res.body.won).toBe(2);
      expect(res.body.winRate).toBeCloseTo(2 / 3, 5);
      expect(res.body.bestPartner.playerId).toBe(ally.id);
      expect(res.body.mostFacedOpponent.playerId).toBe(foe.id);
      expect(res.body.mostFacedOpponent.played).toBe(4);
      const decisiveRating = computeRatings(
        played.map((match) => ({
          teamA: match.a as [string, string],
          teamB: match.b as [string, string],
          winner: match.w as 'A' | 'B',
        }))
      );
      expect(res.body.rating).toBe(Math.round(decisiveRating.get(me.id)!));
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  /**
   * Best partner is a win rate, but only above a floor of 5 decisive games
   * together. Without the floor this fixture would crown Flawless on 2-from-2
   * at 100%. With it, Flawless is not eligible at all and Frequent wins on
   * 33% — a worse rate, but the only one measured over enough games to mean
   * anything. This pins the floor: delete it and this test crowns Flawless.
   */
  it('ignores a perfect record set over too few games together', async () => {
    const code = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code, name: 'G' } });
    const [me, frequent, flawless, foeA, foeB] = await Promise.all(
      ['Me', 'Frequent', 'Flawless', 'FoeA', 'FoeB'].map((name) =>
        prisma.player.create({ data: { groupId: code, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: code, courtCount: 1, rawImportText: '' },
    });
    // With Frequent: 2 wins from 6 (33%). With Flawless: 2 wins from 2 (100%).
    const matches = [
      ...Array.from({ length: 2 }, () => ({ mate: frequent.id, win: true })),
      ...Array.from({ length: 4 }, () => ({ mate: frequent.id, win: false })),
      ...Array.from({ length: 2 }, () => ({ mate: flawless.id, win: true })),
    ];
    for (const [i, m] of matches.entries()) {
      await prisma.pairing.create({
        data: {
          sessionId: sessionCode,
          courtNumber: 1,
          matchNumber: i + 1,
          teamA: JSON.stringify([me.id, m.mate]),
          teamB: JSON.stringify([foeA.id, foeB.id]),
          confirmedAt: new Date(Date.now() + i * 1000),
          endedAt: new Date(),
          winner: m.win ? 'A' : 'B',
        },
      });
    }

    try {
      const res = await request(server)
        .get(`/groups/${code}/players/${me.id}/stats`)
        .expect(200);
      expect(res.body.bestPartner.playerId).toBe(frequent.id);
      expect(res.body.bestPartner.winRate).toBeCloseTo(2 / 6, 5);
      expect(res.body.bestPartner.provisional).toBe(false);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  it('reports a player who has never played without inventing partners', async () => {
    const code = randomUUID();
    await prisma.group.create({ data: { code, name: 'G' } });
    const player = await prisma.player.create({
      data: { groupId: code, name: 'New', aliases: '[]' },
    });

    try {
      const res = await request(server)
        .get(`/groups/${code}/players/${player.id}/stats`)
        .expect(200);
      expect(res.body.played).toBe(0);
      expect(res.body.winRate).toBeNull();
      expect(res.body.bestPartner).toBeNull();
      expect(res.body.mostFacedOpponent).toBeNull();
    } finally {
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  it('404s player stats for someone outside the group', async () => {
    const code = randomUUID();
    await prisma.group.create({ data: { code, name: 'G' } });
    try {
      await request(server)
        .get(`/groups/${code}/players/${randomUUID()}/stats`)
        .expect(404);
    } finally {
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  it('exports a group as JSON with its players, sessions and matches', async () => {
    const code = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code, name: 'Export Me' } });
    const player = await prisma.player.create({
      data: { groupId: code, name: 'Alice', aliases: JSON.stringify(['Alicia']) },
    });
    await prisma.session.create({
      data: { code: sessionCode, groupId: code, courtCount: 1, rawImportText: 'raw' },
    });
    await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: player.id } });
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([player.id, 'x']),
        teamB: JSON.stringify(['y', 'z']),
        confirmedAt: new Date(),
        endedAt: new Date(),
        winner: 'A',
      },
    });

    try {
      const res = await request(server).get(`/groups/${code}/export`).expect(200);
      expect(res.body.group.name).toBe('Export Me');
      expect(res.body.players).toHaveLength(1);
      // Aliases come back as a real array, not the JSON string the DB holds.
      expect(res.body.players[0].aliases).toEqual(['Alicia']);
      expect(res.body.sessions).toHaveLength(1);
      expect(res.body.sessions[0].rosterPlayerIds).toEqual([player.id]);
      expect(res.body.sessions[0].matches).toHaveLength(1);
      expect(res.body.sessions[0].matches[0].teamA).toEqual([player.id, 'x']);
      expect(typeof res.body.exportedAt).toBe('string');
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  it('deletes a group and everything under it', async () => {
    const code = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code, name: 'Delete Me' } });
    const player = await prisma.player.create({
      data: { groupId: code, name: 'Alice', aliases: '[]' },
    });
    await prisma.session.create({
      data: { code: sessionCode, groupId: code, courtCount: 1, rawImportText: '' },
    });
    await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: player.id } });
    await prisma.waitlist.create({
      data: { sessionId: sessionCode, playerId: player.id, position: 0 },
    });
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([player.id, 'x']),
        teamB: JSON.stringify(['y', 'z']),
      },
    });

    await request(server).delete(`/groups/${code}`).expect(200);

    expect(await prisma.group.findUnique({ where: { code } })).toBeNull();
    expect(await prisma.player.findMany({ where: { groupId: code } })).toEqual([]);
    expect(await prisma.session.findMany({ where: { groupId: code } })).toEqual([]);
    expect(await prisma.pairing.findMany({ where: { sessionId: sessionCode } })).toEqual([]);
    expect(await prisma.sessionRoster.findMany({ where: { sessionId: sessionCode } })).toEqual([]);
    expect(await prisma.waitlist.findMany({ where: { sessionId: sessionCode } })).toEqual([]);
  });

  it('404s deleting a group that does not exist', async () => {
    await request(server).delete(`/groups/${randomUUID()}`).expect(404);
  });

  /**
   * Builds a group where `me` partners each named mate for a run of matches,
   * so a test only has to state the win/loss shape it cares about.
   */
  const partnerFixture = async (runs: { name: string; wins: number; losses: number }[]) => {
    const code = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code, name: 'G' } });
    const me = await prisma.player.create({
      data: { groupId: code, name: 'Me', aliases: '[]' },
    });
    const foeA = await prisma.player.create({
      data: { groupId: code, name: 'FoeA', aliases: '[]' },
    });
    const foeB = await prisma.player.create({
      data: { groupId: code, name: 'FoeB', aliases: '[]' },
    });
    await prisma.session.create({
      data: { code: sessionCode, groupId: code, courtCount: 1, rawImportText: '' },
    });

    const mates = new Map<string, string>();
    let matchNumber = 0;
    for (const run of runs) {
      const mate = await prisma.player.create({
        data: { groupId: code, name: run.name, aliases: '[]' },
      });
      mates.set(run.name, mate.id);
      const outcomes = [
        ...Array.from({ length: run.wins }, () => true),
        ...Array.from({ length: run.losses }, () => false),
      ];
      for (const win of outcomes) {
        matchNumber += 1;
        await prisma.pairing.create({
          data: {
            sessionId: sessionCode,
            courtNumber: 1,
            matchNumber,
            teamA: JSON.stringify([me.id, mate.id]),
            teamB: JSON.stringify([foeA.id, foeB.id]),
            confirmedAt: new Date(Date.now() + matchNumber * 1000),
            endedAt: new Date(),
            winner: win ? 'A' : 'B',
          },
        });
      }
    }

    const cleanup = async () => {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    };
    return { code, me, foes: [foeA.id, foeB.id] as const, mates, cleanup };
  };

  it('prefers the better rate once both partners clear the floor', async () => {
    // Steady: 5 of 8 (62%). Sharp: 5 of 6 (83%) on fewer games. Under the old
    // wins-then-games-played rule these tie on 5 wins and Steady takes it.
    const { code, me, mates, cleanup } = await partnerFixture([
      { name: 'Steady', wins: 5, losses: 3 },
      { name: 'Sharp', wins: 5, losses: 1 },
    ]);
    try {
      const res = await request(server)
        .get(`/groups/${code}/players/${me.id}/stats`)
        .expect(200);
      expect(res.body.bestPartner.playerId).toBe(mates.get('Sharp'));
      expect(res.body.bestPartner.winRate).toBeCloseTo(5 / 6, 5);
    } finally {
      await cleanup();
    }
  });

  it('breaks an equal rate towards the pair that has played more', async () => {
    const { code, me, mates, cleanup } = await partnerFixture([
      { name: 'Proven', wins: 6, losses: 3 },
      { name: 'Newer', wins: 4, losses: 2 },
    ]);
    try {
      const res = await request(server)
        .get(`/groups/${code}/players/${me.id}/stats`)
        .expect(200);
      expect(res.body.bestPartner.winRate).toBeCloseTo(2 / 3, 5);
      expect(res.body.bestPartner.playerId).toBe(mates.get('Proven'));
    } finally {
      await cleanup();
    }
  });

  it('falls back to most wins together, flagged provisional, below the floor', async () => {
    // Nobody has 5 games with anyone yet, which is every new group for its
    // first few nights. Showing nothing would leave the panel empty, so the
    // old count stands in and says so.
    const { code, me, mates, cleanup } = await partnerFixture([
      { name: 'Some', wins: 2, losses: 1 },
      { name: 'Fewer', wins: 1, losses: 0 },
    ]);
    try {
      const res = await request(server)
        .get(`/groups/${code}/players/${me.id}/stats`)
        .expect(200);
      expect(res.body.bestPartner.playerId).toBe(mates.get('Some'));
      expect(res.body.bestPartner.provisional).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('does not let an abandoned match count against a pairing rate', async () => {
    const { code, me, foes, mates, cleanup } = await partnerFixture([
      { name: 'Solid', wins: 5, losses: 1 },
    ]);
    try {
      const before = await request(server)
        .get(`/groups/${code}/players/${me.id}/stats`)
        .expect(200);
      expect(before.body.bestPartner.winRate).toBeCloseTo(5 / 6, 5);

      const session = await prisma.session.findFirstOrThrow({ where: { groupId: code } });
      await prisma.pairing.create({
        data: {
          sessionId: session.code,
          courtNumber: 1,
          matchNumber: 99,
          teamA: JSON.stringify([me.id, mates.get('Solid')!]),
          teamB: JSON.stringify(foes),
          confirmedAt: new Date(),
          endedAt: new Date(),
          winner: null,
        },
      });

      const after = await request(server)
        .get(`/groups/${code}/players/${me.id}/stats`)
        .expect(200);
      expect(after.body.bestPartner.winRate).toBeCloseTo(5 / 6, 5);
      expect(after.body.bestPartner.played).toBe(7);
    } finally {
      await cleanup();
    }
  });

});
