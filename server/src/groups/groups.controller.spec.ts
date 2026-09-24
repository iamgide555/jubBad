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

  it('accepts an empty roster message on parse, claiming the group with nothing to review', async () => {
    // The manual "add players yourself" flow (GroupEntry.startManual) reuses
    // this endpoint with rawText: '' purely to claim/create the group — see
    // the comment on ParseRosterDto.rawText.
    const code = randomUUID();
    const res = await request(server)
      .post(`/groups/${code}/parse`)
      .send({ groupName: 'Manual Group', rawText: '' })
      .expect(201);

    expect(res.body.rosterReviews).toEqual([]);
    expect(res.body.waitlistReviews).toEqual([]);
    expect(res.body.header).toEqual({ isoDate: null, venue: null, courtCount: null });

    try {
      const group = await prisma.group.findUniqueOrThrow({ where: { code } });
      expect(group.name).toBe('Manual Group');
      expect(group.ownerId).toBe(testAdminId);
    } finally {
      await prisma.group.deleteMany({ where: { code } });
    }
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

  it('exports a group with per-court formats and a singles match intact', async () => {
    const code = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code, name: 'G' } });
    const [a, b] = await Promise.all(
      ['A', 'B'].map((name) => prisma.player.create({ data: { groupId: code, name, aliases: '[]' } }))
    );
    await prisma.session.create({
      data: {
        code: sessionCode,
        groupId: code,
        courtCount: 2,
        rawImportText: '',
        courtFormats: JSON.stringify(['doubles', 'singles']),
      },
    });
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 2,
        matchNumber: 1,
        teamA: JSON.stringify([a.id]),
        teamB: JSON.stringify([b.id]),
        confirmedAt: new Date(),
        endedAt: new Date(),
        winner: 'A',
      },
    });

    try {
      const res = await request(server).get(`/groups/${code}/export`).expect(200);
      const session = res.body.sessions.find((s: { code: string }) => s.code === sessionCode);
      expect(session.courtFormats).toEqual(['doubles', 'singles']);
      expect(session.matches[0].teamA).toEqual([a.id]);
      expect(session.matches[0].teamB).toEqual([b.id]);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  it('exports a half-filled custom-mode draft with its empty seats intact, rather than throwing', async () => {
    const code = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code, name: 'G' } });
    const a = await prisma.player.create({ data: { groupId: code, name: 'A', aliases: '[]' } });
    await prisma.session.create({
      data: { code: sessionCode, groupId: code, courtCount: 1, rawImportText: '', mode: 'custom' },
    });
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([a.id, null]),
        teamB: JSON.stringify([null, null]),
      },
    });

    try {
      const res = await request(server).get(`/groups/${code}/export`).expect(200);
      const session = res.body.sessions.find((s: { code: string }) => s.code === sessionCode);
      expect(session.matches[0].teamA).toEqual([a.id, null]);
      expect(session.matches[0].teamB).toEqual([null, null]);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    }
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

  it('splits played/won/winRate by singles vs doubles, null when a format was never played', async () => {
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
    // Me+Ally beat Foe+Other twice (doubles), then Me loses to Foe one-on-one (singles).
    const rows = [
      { teamA: [me.id, ally.id], teamB: [foe.id, other.id], winner: 'A' as const, n: 1 },
      { teamA: [me.id, ally.id], teamB: [foe.id, other.id], winner: 'A' as const, n: 2 },
      { teamA: [me.id], teamB: [foe.id], winner: 'B' as const, n: 3 },
    ];
    for (const r of rows) {
      await prisma.pairing.create({
        data: {
          sessionId: sessionCode,
          courtNumber: 1,
          matchNumber: r.n,
          teamA: JSON.stringify(r.teamA),
          teamB: JSON.stringify(r.teamB),
          confirmedAt: new Date(Date.now() + r.n * 1000),
          endedAt: new Date(),
          winner: r.winner,
        },
      });
    }

    try {
      const meRes = await request(server)
        .get(`/groups/${code}/players/${me.id}/stats`)
        .expect(200);
      expect(meRes.body.doubles).toEqual({ played: 2, won: 2, winRate: 1 });
      expect(meRes.body.singles).toEqual({ played: 1, won: 0, winRate: 0 });
      // Combined totals stay exactly what they are today.
      expect(meRes.body.played).toBe(3);
      expect(meRes.body.won).toBe(2);

      const allyRes = await request(server)
        .get(`/groups/${code}/players/${ally.id}/stats`)
        .expect(200);
      expect(allyRes.body.doubles).toEqual({ played: 2, won: 2, winRate: 1 });
      expect(allyRes.body.singles).toBeNull();
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  it('reports partners and active group size over the last 30 days only', async () => {
    const code = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code, name: 'G' } });
    const [me, ally, old, foe, other, solo] = await Promise.all(
      ['Me', 'Ally', 'Old', 'Foe', 'Other', 'Solo'].map((name) =>
        prisma.player.create({ data: { groupId: code, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: code, courtCount: 1, rawImportText: '' },
    });
    const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

    // In window (29 days ago): Me partners Ally, doubles, vs Foe+Other.
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([me.id, ally.id]),
        teamB: JSON.stringify([foe.id, other.id]),
        confirmedAt: daysAgo(29),
        endedAt: daysAgo(29),
        winner: 'A',
      },
    });
    // Out of window (31 days ago): Me partners Old — must not count.
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 2,
        teamA: JSON.stringify([me.id, old.id]),
        teamB: JSON.stringify([foe.id, other.id]),
        confirmedAt: daysAgo(31),
        endedAt: daysAgo(31),
        winner: 'A',
      },
    });
    // In window (5 days ago): Me plays Solo in singles — Solo is active
    // recently but never a partner.
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 3,
        teamA: JSON.stringify([solo.id]),
        teamB: JSON.stringify([me.id]),
        confirmedAt: daysAgo(5),
        endedAt: daysAgo(5),
        winner: 'B',
      },
    });

    try {
      const res = await request(server)
        .get(`/groups/${code}/players/${me.id}/stats`)
        .expect(200);
      // Only Ally, from the in-window match — Old (out of window) excluded.
      expect(res.body.partnersLast30Days.distinct).toBe(1);
      // Ally, Foe, Other (match 1) and Solo (match 3) were active in the
      // window; Old (only in the out-of-window match) and Me are excluded.
      expect(res.body.partnersLast30Days.groupSize).toBe(4);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  it('omits singlesRating for a player who has never played singles', async () => {
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
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([me.id, ally.id]),
        teamB: JSON.stringify([foe.id, other.id]),
        confirmedAt: new Date(),
        endedAt: new Date(),
        winner: 'A',
      },
    });

    try {
      const res = await request(server).get(`/groups/${code}/players/${me.id}/stats`).expect(200);
      expect(res.body.singlesRating).toBeNull();
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  it('keeps singlesRating null when the only singles match was abandoned without a result', async () => {
    // Regression: hasSinglesMatch used to be computed by scanning every
    // singles appearance in `matches`, including a no-result one, while the
    // Elo track it read from (`ratings.singles`) only ever replays decisive
    // matches. A player whose only singles match had no winner got a
    // fabricated 1200 "rating" instead of the null this field promises.
    const code = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code, name: 'G' } });
    const [me, foe] = await Promise.all(
      ['Me', 'Foe'].map((name) => prisma.player.create({ data: { groupId: code, name, aliases: '[]' } }))
    );
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
        // No winner — played, but abandoned.
      },
    });

    try {
      const res = await request(server).get(`/groups/${code}/players/${me.id}/stats`).expect(200);
      expect(res.body.singlesRating).toBeNull();
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: code } });
      await prisma.group.deleteMany({ where: { code } });
    }
  });

  it('gives a player independent singles and doubles ratings', async () => {
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
    // Me loses every singles match against Foe, but wins every doubles match
    // partnered with Ally against Foe+Other — the two ratings must diverge.
    await Promise.all([
      prisma.pairing.create({
        data: {
          sessionId: sessionCode,
          courtNumber: 1,
          matchNumber: 1,
          teamA: JSON.stringify([me.id]),
          teamB: JSON.stringify([foe.id]),
          confirmedAt: new Date(),
          endedAt: new Date(),
          winner: 'B',
        },
      }),
      prisma.pairing.create({
        data: {
          sessionId: sessionCode,
          courtNumber: 1,
          matchNumber: 2,
          teamA: JSON.stringify([me.id, ally.id]),
          teamB: JSON.stringify([foe.id, other.id]),
          confirmedAt: new Date(),
          endedAt: new Date(),
          winner: 'A',
        },
      }),
    ]);

    try {
      const res = await request(server).get(`/groups/${code}/players/${me.id}/stats`).expect(200);
      expect(res.body.singlesRating).not.toBeNull();
      expect(res.body.singlesRating).toBeLessThan(1200);
      expect(res.body.rating).toBeGreaterThan(1200);
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

  describe('GET players/manage', () => {
    it('returns contact info and rating stats for every player in the group', async () => {
      const code = randomUUID();
      await prisma.group.create({ data: { code, name: 'G' } });
      const player = await prisma.player.create({
        data: { groupId: code, name: 'Me', aliases: '[]', age: 30, email: 'me@example.test', phone: '0812345678' },
      });

      try {
        const res = await request(server).get(`/groups/${code}/players/manage`).expect(200);
        expect(res.body).toEqual([
          {
            id: player.id,
            name: 'Me',
            aliases: [],
            age: 30,
            email: 'me@example.test',
            phone: '0812345678',
            level: null,
            rating: 1200,
            singlesRating: null,
            winRate: null,
          },
        ]);
      } finally {
        await prisma.player.deleteMany({ where: { groupId: code } });
        await prisma.group.deleteMany({ where: { code } });
      }
    });

    it('404s for a group that does not exist', async () => {
      await request(server).get(`/groups/${randomUUID()}/players/manage`).expect(404);
    });
  });

  describe('PUT players/:playerId', () => {
    it('updates name/age/email/phone', async () => {
      const code = randomUUID();
      await prisma.group.create({ data: { code, name: 'G' } });
      const player = await prisma.player.create({ data: { groupId: code, name: 'Old', aliases: '[]' } });

      try {
        const res = await request(server)
          .put(`/groups/${code}/players/${player.id}`)
          .send({ name: 'New', age: 25, email: 'new@example.test', phone: '0899999999' })
          .expect(200);
        expect(res.body).toMatchObject({
          id: player.id,
          name: 'New',
          age: 25,
          email: 'new@example.test',
          phone: '0899999999',
        });
        const stored = await prisma.player.findUnique({ where: { id: player.id } });
        expect(stored?.name).toBe('New');
      } finally {
        await prisma.player.deleteMany({ where: { groupId: code } });
        await prisma.group.deleteMany({ where: { code } });
      }
    });

    it('clears age/email/phone to null when the request omits them', async () => {
      const code = randomUUID();
      await prisma.group.create({ data: { code, name: 'G' } });
      const player = await prisma.player.create({
        data: { groupId: code, name: 'Old', aliases: '[]', age: 40, email: 'x@example.test', phone: '0811111111' },
      });

      try {
        await request(server).put(`/groups/${code}/players/${player.id}`).send({ name: 'Old' }).expect(200);
        const stored = await prisma.player.findUnique({ where: { id: player.id } });
        expect(stored?.age).toBeNull();
        expect(stored?.email).toBeNull();
        expect(stored?.phone).toBeNull();
      } finally {
        await prisma.player.deleteMany({ where: { groupId: code } });
        await prisma.group.deleteMany({ where: { code } });
      }
    });

    it('rejects an invalid email with 400', async () => {
      const code = randomUUID();
      await prisma.group.create({ data: { code, name: 'G' } });
      const player = await prisma.player.create({ data: { groupId: code, name: 'Old', aliases: '[]' } });

      try {
        await request(server)
          .put(`/groups/${code}/players/${player.id}`)
          .send({ name: 'Old', email: 'not-an-email' })
          .expect(400);
      } finally {
        await prisma.player.deleteMany({ where: { groupId: code } });
        await prisma.group.deleteMany({ where: { code } });
      }
    });

    it('rejects an out-of-range age with 400', async () => {
      const code = randomUUID();
      await prisma.group.create({ data: { code, name: 'G' } });
      const player = await prisma.player.create({ data: { groupId: code, name: 'Old', aliases: '[]' } });

      try {
        await request(server)
          .put(`/groups/${code}/players/${player.id}`)
          .send({ name: 'Old', age: 200 })
          .expect(400);
      } finally {
        await prisma.player.deleteMany({ where: { groupId: code } });
        await prisma.group.deleteMany({ where: { code } });
      }
    });

    it('404s for a player that belongs to a different group', async () => {
      const code = randomUUID();
      const otherCode = randomUUID();
      await prisma.group.create({ data: { code, name: 'G' } });
      await prisma.group.create({ data: { code: otherCode, name: 'Other' } });
      const foreign = await prisma.player.create({ data: { groupId: otherCode, name: 'Foreign', aliases: '[]' } });

      try {
        await request(server)
          .put(`/groups/${code}/players/${foreign.id}`)
          .send({ name: 'Hacked' })
          .expect(404);
      } finally {
        await prisma.player.deleteMany({ where: { groupId: { in: [code, otherCode] } } });
        await prisma.group.deleteMany({ where: { code: { in: [code, otherCode] } } });
      }
    });
  });

});
