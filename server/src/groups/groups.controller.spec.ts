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

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, GroupsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    // supertest calls listen() itself for every request when the server is not
    // already listening. Under a few hundred requests that churn intermittently
    // produced "socket hang up" and bogus 501s that looked like app failures.
    // Listening once here keeps a single server for the file.
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
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
      expect(res.body.mostWinsWith).toEqual({ playerId: ally.id, name: 'Ally', played: 3, won: 2 });
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
   * Finding 33: the field used to be called "best partner", which promises a
   * judgement the number does not make. It counts wins together and breaks
   * ties on games played, so a partner you have won 2 of 6 with outranks one
   * you have won 2 of 2 with. That is the intended rule — with this few
   * matches a win rate is mostly noise — and this test pins it so the name and
   * the arithmetic cannot drift apart again.
   */
  it('ranks partners by wins together, breaking ties on games played, not win rate', async () => {
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
      expect(res.body.mostWinsWith).toEqual({
        playerId: frequent.id,
        name: 'Frequent',
        played: 6,
        won: 2,
      });
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
      expect(res.body.mostWinsWith).toBeNull();
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
});
