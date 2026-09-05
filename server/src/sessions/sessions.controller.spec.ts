import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsModule } from './sessions.module.js';
import { SessionsService } from './sessions.service.js';

describe('SessionsController', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: SessionsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, SessionsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    service = app.get(SessionsService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a session, resolving new players and existing-player aliases', async () => {
    const groupCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const existing = await prisma.player.create({
      data: { groupId: groupCode, name: 'Bob', aliases: '[]' },
    });

    const res = await request(app.getHttpServer())
      .post('/sessions')
      .send({
        groupCode,
        date: '2026-09-04',
        venue: 'Court A',
        courtCount: 2,
        rawImportText: '1. Alice\n2. Bobby',
        rosterReviews: [
          { inputName: 'Alice', match: { type: 'new' }, decision: 'accept' },
          {
            inputName: 'Bobby',
            match: { type: 'fuzzy', playerId: existing.id, score: 0.8 },
            decision: 'accept',
          },
        ],
        waitlistReviews: [],
      })
      .expect(201);

    expect(typeof res.body.code).toBe('string');

    try {
      const session = await prisma.session.findUniqueOrThrow({ where: { code: res.body.code } });
      expect(session.groupId).toBe(groupCode);
      expect(session.venue).toBe('Court A');

      const roster = await prisma.sessionRoster.findMany({ where: { sessionId: res.body.code } });
      expect(roster).toHaveLength(2);

      const bobAfter = await prisma.player.findUniqueOrThrow({ where: { id: existing.id } });
      expect(JSON.parse(bobAfter.aliases)).toEqual(['Bobby']);

      const allPlayers = await prisma.player.findMany({ where: { groupId: groupCode } });
      expect(allPlayers).toHaveLength(2);
    } finally {
      await prisma.sessionRoster.deleteMany({ where: { sessionId: res.body.code } });
      await prisma.session.deleteMany({ where: { code: res.body.code } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('rejects a request with an unrecognized decision value', async () => {
    const groupCode = randomUUID();
    await request(app.getHttpServer())
      .post('/sessions')
      .send({
        groupCode,
        date: null,
        venue: null,
        courtCount: null,
        rawImportText: '1. Alice',
        rosterReviews: [{ inputName: 'Alice', match: { type: 'new' }, decision: 'maybe' }],
        waitlistReviews: [],
      })
      .expect(400);
  });

  it('returns 404 for a session that does not exist', async () => {
    await request(app.getHttpServer()).get(`/sessions/${randomUUID()}`).expect(404);
  });

  it('derives court status from Pairing rows', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: {
        code: sessionCode,
        groupId: groupCode,
        courtCount: 2,
        rawImportText: '',
      },
    });
    for (const p of players) {
      await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    }
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([players[0].id, players[1].id]),
        teamB: JSON.stringify([players[2].id, players[3].id]),
        confirmedAt: new Date(),
      },
    });

    try {
      const res = await request(app.getHttpServer()).get(`/sessions/${sessionCode}`).expect(200);
      expect(res.body.rosterPlayerIds).toHaveLength(4);
      expect(res.body.courts).toEqual([
        {
          courtNumber: 1,
          status: 'active',
          pairingId: expect.any(String),
          teamA: [players[0].id, players[1].id],
          teamB: [players[2].id, players[3].id],
        },
        { courtNumber: 2, status: 'idle' },
      ]);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('proposes a match, reshuffles in place before confirm, and reports not-enough-players', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    for (const p of players) {
      await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    }

    try {
      const first = await request(app.getHttpServer())
        .post(`/sessions/${sessionCode}/courts/1/propose`)
        .expect(201);
      expect(first.body.ok).toBe(true);
      const firstPairingId = first.body.pairing.id;
      expect(first.body.pairing.matchNumber).toBe(1);

      const rowsAfterFirst = await prisma.pairing.findMany({ where: { sessionId: sessionCode } });
      expect(rowsAfterFirst).toHaveLength(1);

      const second = await request(app.getHttpServer())
        .post(`/sessions/${sessionCode}/courts/1/propose`)
        .expect(201);
      expect(second.body.ok).toBe(true);
      expect(second.body.pairing.id).toBe(firstPairingId);
      expect(second.body.pairing.matchNumber).toBe(1);

      const rowsAfterSecond = await prisma.pairing.findMany({ where: { sessionId: sessionCode } });
      expect(rowsAfterSecond).toHaveLength(1);

      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      const notEnough = await request(app.getHttpServer())
        .post(`/sessions/${sessionCode}/courts/1/propose`)
        .expect(201);
      expect(notEnough.body).toEqual({ ok: false, reason: 'not-enough-players' });
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('never assigns the same player to two courts proposed concurrently', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 2, rawImportText: '' },
    });
    for (const p of players) {
      await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    }

    try {
      // Driven through the service rather than supertest: two supertest
      // requests started together still reach the handler one after the
      // other, which hides the interleaving this guards against.
      const results = await Promise.all([service.propose(sessionCode, 1), service.propose(sessionCode, 2)]);
      const assigned = results.flatMap((r) => {
        expect(r.ok).toBe(true);
        return r.ok ? [...r.pairing.teamA, ...r.pairing.teamB] : [];
      });
      expect(assigned).toHaveLength(8);
      expect(new Set(assigned).size).toBe(8);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('reshuffle never immediately repeats the same team split', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    for (const p of players) {
      await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    }

    try {
      let previousKeys: string[] | null = null;
      for (let i = 0; i < 20; i++) {
        const res = await request(app.getHttpServer())
          .post(`/sessions/${sessionCode}/courts/1/propose`)
          .expect(201);
        expect(res.body.ok).toBe(true);
        const { teamA, teamB } = res.body.pairing as { teamA: string[]; teamB: string[] };
        const keys = [[...teamA].sort().join('|'), [...teamB].sort().join('|')].sort();
        if (previousKeys) {
          expect(keys).not.toEqual(previousKeys);
        }
        previousKeys = keys;
      }
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('avoids partners who were paired in an earlier session of the same group', async () => {
    const groupCode = randomUUID();
    const oldSessionCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const [a, b, c, d] = await Promise.all(
      ['A', 'B', 'C', 'D'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: {
        code: oldSessionCode,
        groupId: groupCode,
        courtCount: 1,
        rawImportText: '',
        endedAt: new Date(),
      },
    });
    // Two of the three possible splits of {A,B,C,D} are used up last week, so
    // the only split with no repeat partner is A+D vs B+C.
    for (const [i, [teamA, teamB]] of [
      [
        [a.id, b.id],
        [c.id, d.id],
      ],
      [
        [a.id, c.id],
        [b.id, d.id],
      ],
    ].entries()) {
      await prisma.pairing.create({
        data: {
          sessionId: oldSessionCode,
          courtNumber: 1,
          matchNumber: i + 1,
          teamA: JSON.stringify(teamA),
          teamB: JSON.stringify(teamB),
          confirmedAt: new Date(),
          endedAt: new Date(),
        },
      });
    }
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    for (const p of [a, b, c, d]) {
      await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    }

    try {
      const expected = [[a.id, d.id].sort().join('|'), [b.id, c.id].sort().join('|')].sort();
      // Repeated because with no cross-session history the engine picks one of
      // three splits at random — a single round would pass by luck.
      for (let i = 0; i < 8; i++) {
        const res = await request(app.getHttpServer())
          .post(`/sessions/${sessionCode}/courts/1/propose`)
          .expect(201);
        expect(res.body.ok).toBe(true);
        const { teamA, teamB } = res.body.pairing as { teamA: string[]; teamB: string[] };
        expect([[...teamA].sort().join('|'), [...teamB].sort().join('|')].sort()).toEqual(expected);
        // Clear the pending row so the next call is a fresh propose rather
        // than a reshuffle (which deliberately avoids repeating the split).
        await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      }
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: { in: [sessionCode, oldSessionCode] } } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { groupId: groupCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('ranks sit-out priority on this session only, ignoring earlier sessions', async () => {
    const groupCode = randomUUID();
    const oldSessionCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D', 'E'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: {
        code: oldSessionCode,
        groupId: groupCode,
        courtCount: 1,
        rawImportText: '',
        endedAt: new Date(),
      },
    });
    // A-D each played last week; E did not. That must not decide who sits out
    // today — games-played is a this-session-only signal (docs/overview.md, "Pairing").
    await prisma.pairing.create({
      data: {
        sessionId: oldSessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([players[0].id, players[1].id]),
        teamB: JSON.stringify([players[2].id, players[3].id]),
        confirmedAt: new Date(),
        endedAt: new Date(),
      },
    });
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    for (const p of players) {
      await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    }

    try {
      let everSatOut = false;
      for (let i = 0; i < 30 && !everSatOut; i++) {
        const res = await request(app.getHttpServer())
          .post(`/sessions/${sessionCode}/courts/1/propose`)
          .expect(201);
        const { teamA, teamB } = res.body.pairing as { teamA: string[]; teamB: string[] };
        if (![...teamA, ...teamB].includes(players[4].id)) everSatOut = true;
        await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      }
      expect(everSatOut).toBe(true);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: { in: [sessionCode, oldSessionCode] } } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { groupId: groupCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('confirms then finishes a pairing', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    const pairing = await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([players[0].id, players[1].id]),
        teamB: JSON.stringify([players[2].id, players[3].id]),
      },
    });

    try {
      const confirmRes = await request(app.getHttpServer())
        .post(`/sessions/${sessionCode}/pairings/${pairing.id}/confirm`)
        .expect(201);
      expect(confirmRes.body.confirmedAt).not.toBeNull();
      expect(confirmRes.body.endedAt).toBeNull();

      const finishRes = await request(app.getHttpServer())
        .post(`/sessions/${sessionCode}/pairings/${pairing.id}/finish`)
        .send({ scoreA: 21, scoreB: 15, winner: 'A' })
        .expect(201);
      expect(finishRes.body.endedAt).not.toBeNull();
      expect(finishRes.body.scoreA).toBe(21);
      expect(finishRes.body.scoreB).toBe(15);
      expect(finishRes.body.winner).toBe('A');
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('finishes a pairing with a winner but no scores', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    const pairing = await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([players[0].id, players[1].id]),
        teamB: JSON.stringify([players[2].id, players[3].id]),
        confirmedAt: new Date(),
      },
    });

    try {
      const res = await request(app.getHttpServer())
        .post(`/sessions/${sessionCode}/pairings/${pairing.id}/finish`)
        .send({ winner: 'B' })
        .expect(201);
      expect(res.body.winner).toBe('B');
      expect(res.body.scoreA).toBeNull();
      expect(res.body.scoreB).toBeNull();
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('finishes a match with no winner, for a game abandoned part-way', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    const pairing = await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify(['p1', 'p2']),
        teamB: JSON.stringify(['p3', 'p4']),
        confirmedAt: new Date(),
      },
    });

    try {
      const res = await request(app.getHttpServer())
        .post(`/sessions/${sessionCode}/pairings/${pairing.id}/finish`)
        .send({ scoreA: null, scoreB: null, winner: null })
        .expect(201);
      expect(res.body.endedAt).not.toBeNull();
      expect(res.body.winner).toBeNull();
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('rejects a finish that names a winner other than A or B', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    const pairing = await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify(['p1', 'p2']),
        teamB: JSON.stringify(['p3', 'p4']),
        confirmedAt: new Date(),
      },
    });

    try {
      await request(app.getHttpServer())
        .post(`/sessions/${sessionCode}/pairings/${pairing.id}/finish`)
        .send({ winner: 'C' })
        .expect(400);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('rejects finishing a pairing that was never confirmed', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    const pairing = await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify(['p1', 'p2']),
        teamB: JSON.stringify(['p3', 'p4']),
      },
    });

    try {
      await request(app.getHttpServer())
        .post(`/sessions/${sessionCode}/pairings/${pairing.id}/finish`)
        .send({ winner: 'A' })
        .expect(409);

      const row = await prisma.pairing.findUniqueOrThrow({ where: { id: pairing.id } });
      expect(row.endedAt).toBeNull();
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('rejects finishing a pairing that is already finished', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    const firstEndedAt = new Date('2026-09-01T10:00:00Z');
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    const pairing = await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify(['p1', 'p2']),
        teamB: JSON.stringify(['p3', 'p4']),
        confirmedAt: new Date(),
        endedAt: firstEndedAt,
        winner: 'A',
      },
    });

    try {
      await request(app.getHttpServer())
        .post(`/sessions/${sessionCode}/pairings/${pairing.id}/finish`)
        .send({ winner: 'B' })
        .expect(409);

      const row = await prisma.pairing.findUniqueOrThrow({ where: { id: pairing.id } });
      expect(row.winner).toBe('A');
      expect(row.endedAt?.toISOString()).toBe(firstEndedAt.toISOString());
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('rejects confirming a pairing that is already confirmed', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    const firstConfirmedAt = new Date('2026-09-01T10:00:00Z');
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    const pairing = await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify(['p1', 'p2']),
        teamB: JSON.stringify(['p3', 'p4']),
        confirmedAt: firstConfirmedAt,
      },
    });

    try {
      await request(app.getHttpServer())
        .post(`/sessions/${sessionCode}/pairings/${pairing.id}/confirm`)
        .expect(409);

      const row = await prisma.pairing.findUniqueOrThrow({ where: { id: pairing.id } });
      expect(row.confirmedAt?.toISOString()).toBe(firstConfirmedAt.toISOString());
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('rejects proposing on a session that has ended', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: {
        code: sessionCode,
        groupId: groupCode,
        courtCount: 1,
        rawImportText: '',
        endedAt: new Date(),
      },
    });
    for (const p of players) {
      await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    }

    try {
      await request(app.getHttpServer())
        .post(`/sessions/${sessionCode}/courts/1/propose`)
        .expect(409);

      const rows = await prisma.pairing.findMany({ where: { sessionId: sessionCode } });
      expect(rows).toEqual([]);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('leaves a never-confirmed pairing out of stats even once it has ended', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([players[0].id, players[1].id]),
        teamB: JSON.stringify([players[2].id, players[3].id]),
        endedAt: new Date(),
        winner: 'A',
      },
    });

    try {
      const res = await request(app.getHttpServer())
        .get(`/sessions/${sessionCode}/stats`)
        .expect(200);
      expect(res.body).toEqual([]);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('GET /sessions/:code includes endedAt', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });

    try {
      const res = await request(app.getHttpServer()).get(`/sessions/${sessionCode}`).expect(200);
      expect(res.body.endedAt).toBeNull();
    } finally {
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('ends a session with no unfinished courts', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });

    try {
      const res = await request(app.getHttpServer())
        .post(`/sessions/${sessionCode}/end`)
        .expect(201);
      expect(res.body.code).toBe(sessionCode);
      expect(res.body.endedAt).not.toBeNull();

      const getRes = await request(app.getHttpServer()).get(`/sessions/${sessionCode}`).expect(200);
      expect(getRes.body.endedAt).not.toBeNull();
    } finally {
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('rejects ending a session with an unfinished court', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([players[0].id, players[1].id]),
        teamB: JSON.stringify([players[2].id, players[3].id]),
      },
    });

    try {
      const res = await request(app.getHttpServer()).post(`/sessions/${sessionCode}/end`).expect(409);
      expect(res.body.message).toContain('Finish all active courts');

      const getRes = await request(app.getHttpServer()).get(`/sessions/${sessionCode}`).expect(200);
      expect(getRes.body.endedAt).toBeNull();
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('GET /sessions/:code/stats aggregates played/won for the current session', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([players[0].id, players[1].id]),
        teamB: JSON.stringify([players[2].id, players[3].id]),
        confirmedAt: new Date(),
        endedAt: new Date(),
        winner: 'A',
      },
    });
    // Abandoned part-way: played and finished, but with no winner to record.
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 2,
        teamA: JSON.stringify([players[0].id, players[2].id]),
        teamB: JSON.stringify([players[1].id, players[3].id]),
        confirmedAt: new Date(),
        endedAt: new Date(),
        winner: null,
      },
    });
    // Still being played — must not count.
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 3,
        teamA: JSON.stringify([players[0].id, players[1].id]),
        teamB: JSON.stringify([players[2].id, players[3].id]),
        confirmedAt: new Date(),
      },
    });

    try {
      const res = await request(app.getHttpServer())
        .get(`/sessions/${sessionCode}/stats`)
        .expect(200);
      const byId = new Map(res.body.map((r: { playerId: string }) => [r.playerId, r]));
      expect(byId.get(players[0].id)).toEqual({
        playerId: players[0].id,
        name: 'A',
        played: 2,
        won: 1,
      });
      expect(byId.get(players[2].id)).toEqual({
        playerId: players[2].id,
        name: 'C',
        played: 2,
        won: 0,
      });
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('GET /sessions/:code/stats?scope=all includes ended sessions in the same group', async () => {
    const groupCode = randomUUID();
    const oldSessionCode = randomUUID();
    const currentSessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: {
        code: oldSessionCode,
        groupId: groupCode,
        courtCount: 1,
        rawImportText: '',
        endedAt: new Date(),
      },
    });
    await prisma.session.create({
      data: { code: currentSessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    await prisma.pairing.create({
      data: {
        sessionId: oldSessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([players[0].id, players[1].id]),
        teamB: JSON.stringify([players[2].id, players[3].id]),
        confirmedAt: new Date(),
        endedAt: new Date(),
        winner: 'B',
      },
    });

    try {
      const sessionScoped = await request(app.getHttpServer())
        .get(`/sessions/${currentSessionCode}/stats`)
        .expect(200);
      expect(sessionScoped.body).toEqual([]);

      const allTime = await request(app.getHttpServer())
        .get(`/sessions/${currentSessionCode}/stats?scope=all`)
        .expect(200);
      const byId = new Map(allTime.body.map((r: { playerId: string }) => [r.playerId, r]));
      expect(byId.get(players[2].id).won).toBe(1);
      expect(byId.get(players[0].id).won).toBe(0);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: oldSessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.session.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('GET /sessions/:code/stats 404s for an unknown session', async () => {
    await request(app.getHttpServer()).get(`/sessions/${randomUUID()}/stats`).expect(404);
  });

  it('swaps one player on a pending pairing for a waiting substitute, leaving the other 3 untouched', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D', 'E'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    for (const p of players) {
      await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    }
    const pairing = await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([players[0].id, players[1].id]),
        teamB: JSON.stringify([players[2].id, players[3].id]),
      },
    });

    try {
      const res = await request(app.getHttpServer())
        .post(`/sessions/${sessionCode}/pairings/${pairing.id}/swap`)
        .send({ playerId: players[0].id })
        .expect(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.pairing.teamA).toEqual([players[4].id, players[1].id]);
      expect(res.body.pairing.teamB).toEqual([players[2].id, players[3].id]);

      const row = await prisma.pairing.findUniqueOrThrow({ where: { id: pairing.id } });
      expect(JSON.parse(row.teamA)).toEqual([players[4].id, players[1].id]);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('picks the substitute who avoids a repeat partner over the one with fewer games', async () => {
    const groupCode = randomUUID();
    const oldSessionCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const [a, b, c, d, e, f, x, y] = await Promise.all(
      ['A', 'B', 'C', 'D', 'E', 'F', 'X', 'Y'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: {
        code: oldSessionCode,
        groupId: groupCode,
        courtCount: 1,
        rawImportText: '',
        endedAt: new Date(),
      },
    });
    // Last week E partnered B, so subbing E in would recreate that pair.
    await prisma.pairing.create({
      data: {
        sessionId: oldSessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([e.id, b.id]),
        teamB: JSON.stringify([x.id, y.id]),
        confirmedAt: new Date(),
        endedAt: new Date(),
      },
    });
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    for (const p of [a, b, c, d, e, f]) {
      await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    }
    // F has played twice tonight and E not at all, so games-played alone would
    // pick E — the pick that repeats a partner.
    for (const [i, partner] of [x, y].entries()) {
      await prisma.pairing.create({
        data: {
          sessionId: sessionCode,
          courtNumber: 1,
          matchNumber: i + 1,
          teamA: JSON.stringify([f.id, partner.id]),
          teamB: JSON.stringify([i === 0 ? y.id : x.id, a.id]),
          confirmedAt: new Date(),
          endedAt: new Date(),
        },
      });
    }
    const pending = await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 3,
        teamA: JSON.stringify([a.id, b.id]),
        teamB: JSON.stringify([c.id, d.id]),
      },
    });

    try {
      const res = await request(app.getHttpServer())
        .post(`/sessions/${sessionCode}/pairings/${pending.id}/swap`)
        .send({ playerId: a.id })
        .expect(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.pairing.teamA).toEqual([f.id, b.id]);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: { in: [sessionCode, oldSessionCode] } } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { groupId: groupCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('breaks a tie between equally-fresh substitutes on games played tonight', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const [a, b, c, d, e, f, x, y] = await Promise.all(
      ['A', 'B', 'C', 'D', 'E', 'F', 'X', 'Y'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    for (const p of [a, b, c, d, e, f]) {
      await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    }
    // Neither E nor F has ever partnered B, so the history term ties and the
    // fresher player (E, with no games tonight) should come in.
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([f.id, x.id]),
        teamB: JSON.stringify([y.id, a.id]),
        confirmedAt: new Date(),
        endedAt: new Date(),
      },
    });
    const pending = await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 2,
        teamA: JSON.stringify([a.id, b.id]),
        teamB: JSON.stringify([c.id, d.id]),
      },
    });

    try {
      const res = await request(app.getHttpServer())
        .post(`/sessions/${sessionCode}/pairings/${pending.id}/swap`)
        .send({ playerId: a.id })
        .expect(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.pairing.teamA).toEqual([e.id, b.id]);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('reports no-substitute when nobody is waiting to swap in', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    for (const p of players) {
      await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    }
    const pairing = await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([players[0].id, players[1].id]),
        teamB: JSON.stringify([players[2].id, players[3].id]),
      },
    });

    try {
      const res = await request(app.getHttpServer())
        .post(`/sessions/${sessionCode}/pairings/${pairing.id}/swap`)
        .send({ playerId: players[0].id })
        .expect(201);
      expect(res.body).toEqual({ ok: false, reason: 'no-substitute' });

      const row = await prisma.pairing.findUniqueOrThrow({ where: { id: pairing.id } });
      expect(JSON.parse(row.teamA)).toEqual([players[0].id, players[1].id]);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('rejects swapping a pairing that is already confirmed', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    const pairing = await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([players[0].id, players[1].id]),
        teamB: JSON.stringify([players[2].id, players[3].id]),
        confirmedAt: new Date(),
      },
    });

    try {
      await request(app.getHttpServer())
        .post(`/sessions/${sessionCode}/pairings/${pairing.id}/swap`)
        .send({ playerId: players[0].id })
        .expect(409);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });
});
