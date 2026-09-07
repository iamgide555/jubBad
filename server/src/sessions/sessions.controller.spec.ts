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
  let server: ReturnType<INestApplication['getHttpServer']>;
  let service: SessionsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, SessionsModule],
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

    const res = await request(server)
      .post('/sessions')
      .send({
        groupCode,
        date: '2026-09-04',
        venue: 'Court A',
        courtCount: 2,
        rawImportText: '1. Alice\n2. Bobby',
        idempotencyKey: randomUUID(),
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
    await request(server)
      .post('/sessions')
      .send({
        groupCode,
        date: null,
        venue: null,
        courtCount: null,
        rawImportText: '1. Alice',
        idempotencyKey: randomUUID(),
        rosterReviews: [{ inputName: 'Alice', match: { type: 'new' }, decision: 'maybe' }],
        waitlistReviews: [],
      })
      .expect(400);
  });

  it('requires a nested match and a player ID for identity-bearing matches', async () => {
    const key = randomUUID();
    const base = {
      groupCode: randomUUID(),
      date: '2026-09-04',
      venue: null,
      courtCount: 1,
      rawImportText: '1. Alice',
      idempotencyKey: key,
      waitlistReviews: [],
    };

    await request(server)
      .post('/sessions')
      .send({
        ...base,
        rosterReviews: [{ inputName: 'Alice', decision: 'accept' }],
      })
      .expect(400);

    await request(server)
      .post('/sessions')
      .send({
        ...base,
        idempotencyKey: randomUUID(),
        rosterReviews: [{ inputName: 'Alice', match: { type: 'exact' }, decision: 'accept' }],
      })
      .expect(400);
  });

  it('rejects invalid session dates before creating roster records', async () => {
    const groupCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    try {
      await request(server)
        .post('/sessions')
        .send({
          groupCode,
          date: '2026-02-31',
          venue: null,
          courtCount: 1,
          rawImportText: '1. Alice',
          idempotencyKey: randomUUID(),
          rosterReviews: [{ inputName: 'Alice', match: { type: 'new' }, decision: 'accept' }],
          waitlistReviews: [],
        })
        .expect(400);
      expect(await prisma.session.count({ where: { groupId: groupCode } })).toBe(0);
      expect(await prisma.player.count({ where: { groupId: groupCode } })).toBe(0);
    } finally {
      await prisma.group.delete({ where: { code: groupCode } });
    }
  });

  it('rejects an accepted player belonging to another group without partial writes', async () => {
    const groupCode = randomUUID();
    const otherGroupCode = randomUUID();
    await prisma.group.createMany({
      data: [
        { code: groupCode, name: 'G' },
        { code: otherGroupCode, name: 'Other G' },
      ],
    });
    const otherPlayer = await prisma.player.create({
      data: { groupId: otherGroupCode, name: 'Alice', aliases: '[]' },
    });

    try {
      await request(server)
        .post('/sessions')
        .send({
          groupCode,
          date: '2026-09-04',
          venue: null,
          courtCount: 1,
          rawImportText: '1. Alice',
          idempotencyKey: randomUUID(),
          rosterReviews: [
            {
              inputName: 'Alice',
              match: { type: 'exact', playerId: otherPlayer.id },
              decision: 'accept',
            },
          ],
          waitlistReviews: [],
        })
        .expect(400);
      expect(await prisma.session.count({ where: { groupId: groupCode } })).toBe(0);
      expect(await prisma.player.count({ where: { groupId: groupCode } })).toBe(0);
    } finally {
      await prisma.player.delete({ where: { id: otherPlayer.id } });
      await prisma.group.deleteMany({ where: { code: { in: [groupCode, otherGroupCode] } } });
    }
  });

  it('resolves an accepted duplicate after an earlier fuzzy decision became new', async () => {
    const groupCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const bobby = await prisma.player.create({
      data: { groupId: groupCode, name: 'Bobby', aliases: '[]' },
    });

    let sessionCode: string | undefined;
    try {
      const res = await request(server)
        .post('/sessions')
        .send({
          groupCode,
          date: '2026-09-04',
          venue: null,
          courtCount: 1,
          rawImportText: '1. Boby\n2. Bobbi',
          idempotencyKey: randomUUID(),
          rosterReviews: [
            {
              inputName: 'Boby',
              match: { type: 'fuzzy', playerId: bobby.id, score: 0.8 },
              decision: 'reject-new',
            },
            {
              inputName: 'Bobbi',
              match: { type: 'duplicate', playerId: bobby.id },
              decision: 'accept',
            },
          ],
          waitlistReviews: [],
        })
        .expect(201);
      sessionCode = res.body.code;
      const roster = await prisma.sessionRoster.findMany({ where: { sessionId: sessionCode } });
      expect(roster).toHaveLength(2);
      expect(roster.some((entry) => entry.playerId === bobby.id)).toBe(true);
    } finally {
      if (sessionCode) {
        await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
        await prisma.session.delete({ where: { code: sessionCode } });
      }
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.delete({ where: { code: groupCode } });
    }
  });

  it('returns the original session for simultaneous and retry creation requests', async () => {
    const groupCode = randomUUID();
    const idempotencyKey = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const body = {
      groupCode,
      date: '2026-09-04',
      venue: null,
      courtCount: 1,
      rawImportText: '1. Alice',
      idempotencyKey,
      rosterReviews: [{ inputName: 'Alice', match: { type: 'new' }, decision: 'accept' }],
      waitlistReviews: [],
    };

    let sessionCode: string | undefined;
    try {
      const [first, second] = await Promise.all([
        request(server).post('/sessions').send(body).expect(201),
        request(server).post('/sessions').send(body).expect(201),
      ]);
      expect(first.body.code).toBe(second.body.code);
      sessionCode = first.body.code;

      const retry = await request(server).post('/sessions').send(body).expect(201);
      expect(retry.body.code).toBe(sessionCode);
      expect(await prisma.session.count({ where: { groupId: groupCode } })).toBe(1);
      expect(await prisma.player.count({ where: { groupId: groupCode } })).toBe(1);
    } finally {
      if (sessionCode) {
        await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
        await prisma.session.delete({ where: { code: sessionCode } });
      }
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.delete({ where: { code: groupCode } });
    }
  });

  it('creates a new player for a duplicate the host left as a different person', async () => {
    const groupCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const existing = await prisma.player.create({
      data: { groupId: groupCode, name: 'ตั้ม', aliases: '[]' },
    });

    // Two people the host numbered "ตั้ม (1)" / "ตั้ม (2)". Both normalize to
    // the one stored ตั้ม, so the second arrives flagged as a duplicate and
    // defaults to being its own player.
    const res = await request(server)
      .post('/sessions')
      .send({
        groupCode,
        date: '2026-09-04',
        venue: null,
        courtCount: 1,
        rawImportText: '1. ตั้ม (1)\n2. ตั้ม (2)',
        idempotencyKey: randomUUID(),
        rosterReviews: [
          { inputName: 'ตั้ม (1)', match: { type: 'exact', playerId: existing.id }, decision: 'accept' },
          {
            inputName: 'ตั้ม (2)',
            match: { type: 'duplicate', playerId: existing.id },
            decision: 'reject-new',
          },
        ],
        waitlistReviews: [],
      })
      .expect(201);

    try {
      const roster = await prisma.sessionRoster.findMany({ where: { sessionId: res.body.code } });
      expect(roster).toHaveLength(2);
      expect(new Set(roster.map((r) => r.playerId)).size).toBe(2);

      const players = await prisma.player.findMany({ where: { groupId: groupCode } });
      expect(players.map((p) => p.name).sort()).toEqual(['ตั้ม', 'ตั้ม (2)']);
    } finally {
      await prisma.sessionRoster.deleteMany({ where: { sessionId: res.body.code } });
      await prisma.session.deleteMany({ where: { code: res.body.code } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('drops a duplicate slot the host confirmed is the same person', async () => {
    const groupCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const existing = await prisma.player.create({
      data: { groupId: groupCode, name: 'ตั้ม', aliases: '[]' },
    });

    const res = await request(server)
      .post('/sessions')
      .send({
        groupCode,
        date: '2026-09-04',
        venue: null,
        courtCount: 1,
        rawImportText: '1. ตั้ม\n2. ตั้ม',
        idempotencyKey: randomUUID(),
        rosterReviews: [
          { inputName: 'ตั้ม', match: { type: 'exact', playerId: existing.id }, decision: 'accept' },
          { inputName: 'ตั้ม', match: { type: 'duplicate', playerId: existing.id }, decision: 'accept' },
        ],
        waitlistReviews: [],
      })
      .expect(201);

    try {
      const roster = await prisma.sessionRoster.findMany({ where: { sessionId: res.body.code } });
      expect(roster).toHaveLength(1);
      expect(roster[0].playerId).toBe(existing.id);

      const players = await prisma.player.findMany({ where: { groupId: groupCode } });
      expect(players).toHaveLength(1);
    } finally {
      await prisma.sessionRoster.deleteMany({ where: { sessionId: res.body.code } });
      await prisma.session.deleteMany({ where: { code: res.body.code } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('does not abort the import when a client sends the same player twice', async () => {
    const groupCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const existing = await prisma.player.create({
      data: { groupId: groupCode, name: 'ตั้ม', aliases: '[]' },
    });

    // The roster carries a per-player uniqueness constraint, so a repeated id
    // used to abort the whole transaction and lose the import. Reviews are
    // client-supplied, so the server cannot rely on them being deduplicated.
    const res = await request(server)
      .post('/sessions')
      .send({
        groupCode,
        date: '2026-09-04',
        venue: null,
        courtCount: 1,
        rawImportText: '1. ตั้ม\n2. ตั้ม',
        idempotencyKey: randomUUID(),
        rosterReviews: [
          { inputName: 'ตั้ม', match: { type: 'exact', playerId: existing.id }, decision: 'accept' },
          { inputName: 'ตั้ม', match: { type: 'exact', playerId: existing.id }, decision: 'accept' },
        ],
        waitlistReviews: [],
      })
      .expect(201);

    try {
      const roster = await prisma.sessionRoster.findMany({ where: { sessionId: res.body.code } });
      expect(roster).toHaveLength(1);
    } finally {
      await prisma.sessionRoster.deleteMany({ where: { sessionId: res.body.code } });
      await prisma.session.deleteMany({ where: { code: res.body.code } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('honors a host override that treats an exact match as a new player', async () => {
    const groupCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const existing = await prisma.player.create({
      data: { groupId: groupCode, name: 'Alex', aliases: '[]' },
    });

    let sessionCode: string | undefined;
    try {
      const res = await request(server)
        .post('/sessions')
        .send({
          groupCode,
          date: '2026-09-04',
          venue: null,
          courtCount: 1,
          rawImportText: '1. Alex',
          idempotencyKey: randomUUID(),
          rosterReviews: [
            {
              inputName: 'Alex',
              match: { type: 'exact', playerId: existing.id },
              decision: 'reject-new',
            },
          ],
          waitlistReviews: [],
        })
        .expect(201);
      sessionCode = res.body.code;
      const roster = await prisma.sessionRoster.findMany({ where: { sessionId: sessionCode } });
      expect(roster).toHaveLength(1);
      expect(roster[0].playerId).not.toBe(existing.id);
    } finally {
      if (sessionCode) {
        await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
        await prisma.session.delete({ where: { code: sessionCode } });
      }
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.delete({ where: { code: groupCode } });
    }
  });

  it('returns 404 for a session that does not exist', async () => {
    await request(server).get(`/sessions/${randomUUID()}`).expect(404);
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
      const res = await request(server).get(`/sessions/${sessionCode}`).expect(200);
      expect(res.body.rosterPlayerIds).toHaveLength(4);
      expect(res.body.courts).toEqual([
        {
          courtNumber: 1,
          status: 'active',
          pairingId: expect.any(String),
          revision: 0,
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
      const first = await request(server)
        .post(`/sessions/${sessionCode}/courts/1/propose`)
        .expect(201);
      expect(first.body.ok).toBe(true);
      const firstPairingId = first.body.pairing.id;
      expect(first.body.pairing.matchNumber).toBe(1);

      const rowsAfterFirst = await prisma.pairing.findMany({ where: { sessionId: sessionCode } });
      expect(rowsAfterFirst).toHaveLength(1);

      const second = await request(server)
        .post(`/sessions/${sessionCode}/courts/1/propose`)
        .expect(201);
      expect(second.body.ok).toBe(true);
      expect(second.body.pairing.id).toBe(firstPairingId);
      expect(second.body.pairing.matchNumber).toBe(1);

      const rowsAfterSecond = await prisma.pairing.findMany({ where: { sessionId: sessionCode } });
      expect(rowsAfterSecond).toHaveLength(1);

      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      const notEnough = await request(server)
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
        const res = await request(server)
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
        const res = await request(server)
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
      // 5 players, 1 court: exactly one sits each round, chosen by a shuffle
      // among equals. At 30 rounds this missed roughly 1 run in 800; at 80 it
      // is about 1 in 50 million, which is the difference between a test and
      // an occasional lie.
      for (let i = 0; i < 80 && !everSatOut; i++) {
        const res = await request(server)
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

  it('leaves a resting player out of the pool a match is proposed from', async () => {
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

    try {
      await request(server)
        .post(`/sessions/${sessionCode}/roster/${players[4].id}/active`)
        .send({ active: false })
        .expect(201);

      // Exactly 4 remain active, so every proposal must be those 4 and never E.
      for (let i = 0; i < 6; i++) {
        const res = await request(server)
          .post(`/sessions/${sessionCode}/courts/1/propose`)
          .expect(201);
        expect(res.body.ok).toBe(true);
        const on = [...res.body.pairing.teamA, ...res.body.pairing.teamB];
        expect(on).not.toContain(players[4].id);
        await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      }
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('brings a rested player back into the pool when reactivated', async () => {
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
      await request(server)
        .post(`/sessions/${sessionCode}/roster/${players[0].id}/active`)
        .send({ active: false })
        .expect(201);
      // Three active players can't fill a court.
      const short = await request(server)
        .post(`/sessions/${sessionCode}/courts/1/propose`)
        .expect(201);
      expect(short.body).toEqual({ ok: false, reason: 'not-enough-players' });

      await request(server)
        .post(`/sessions/${sessionCode}/roster/${players[0].id}/active`)
        .send({ active: true })
        .expect(201);
      const full = await request(server)
        .post(`/sessions/${sessionCode}/courts/1/propose`)
        .expect(201);
      expect(full.body.ok).toBe(true);
      expect([...full.body.pairing.teamA, ...full.body.pairing.teamB]).toContain(players[0].id);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('lets a match already under way play out when one of its players is rested', async () => {
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
        confirmedAt: new Date(),
      },
    });

    try {
      await request(server)
        .post(`/sessions/${sessionCode}/roster/${players[0].id}/active`)
        .send({ active: false })
        .expect(201);

      const row = await prisma.pairing.findUniqueOrThrow({ where: { id: pairing.id } });
      expect(JSON.parse(row.teamA)).toEqual([players[0].id, players[1].id]);
      expect(row.endedAt).toBeNull();

      const res = await request(server).get(`/sessions/${sessionCode}`).expect(200);
      expect(res.body.courts[0].status).toBe('active');
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('never picks a resting player as a swap substitute', async () => {
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
    const pending = await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([players[0].id, players[1].id]),
        teamB: JSON.stringify([players[2].id, players[3].id]),
      },
    });

    try {
      await request(server)
        .post(`/sessions/${sessionCode}/roster/${players[4].id}/active`)
        .send({ active: false })
        .expect(201);

      const res = await request(server)
        .post(`/sessions/${sessionCode}/pairings/${pending.id}/swap`)
        .send({ playerId: players[0].id })
        .expect(201);
      expect(res.body).toEqual({ ok: false, reason: 'no-substitute' });
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('reports who is resting on GET /sessions/:code', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B'].map((name) =>
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
      const before = await request(server).get(`/sessions/${sessionCode}`).expect(200);
      expect(before.body.restingPlayerIds).toEqual([]);
      expect(before.body.rosterPlayerIds).toHaveLength(2);

      await request(server)
        .post(`/sessions/${sessionCode}/roster/${players[1].id}/active`)
        .send({ active: false })
        .expect(201);

      const after = await request(server).get(`/sessions/${sessionCode}`).expect(200);
      expect(after.body.restingPlayerIds).toEqual([players[1].id]);
      // The roster still lists everyone — resting is a state, not a removal.
      expect(after.body.rosterPlayerIds).toHaveLength(2);
    } finally {
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('404s when resting a player who is not on this session roster', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });

    try {
      await request(server)
        .post(`/sessions/${sessionCode}/roster/${randomUUID()}/active`)
        .send({ active: false })
        .expect(404);
    } finally {
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('rejects a rest request with a non-boolean active flag', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });

    try {
      await request(server)
        .post(`/sessions/${sessionCode}/roster/anyone/active`)
        .send({ active: 'nope' })
        .expect(400);
    } finally {
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('undoes a finish, putting the match back on court', async () => {
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
        confirmedAt: new Date(),
        endedAt: new Date(),
        scoreA: 21,
        scoreB: 15,
        winner: 'A',
      },
    });

    try {
      const res = await request(server)
        .post(`/sessions/${sessionCode}/courts/1/undo`)
        .expect(201);
      expect(res.body).toEqual({ ok: true, undone: 'finish' });

      const row = await prisma.pairing.findUniqueOrThrow({ where: { id: pairing.id } });
      expect(row.endedAt).toBeNull();
      expect(row.winner).toBeNull();
      expect(row.scoreA).toBeNull();
      expect(row.scoreB).toBeNull();
      expect(row.confirmedAt).not.toBeNull();

      const sess = await request(server).get(`/sessions/${sessionCode}`).expect(200);
      expect(sess.body.courts[0].status).toBe('active');
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('undoes a confirm, putting the match back to pending', async () => {
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
      const res = await request(server)
        .post(`/sessions/${sessionCode}/courts/1/undo`)
        .expect(201);
      expect(res.body).toEqual({ ok: true, undone: 'confirm' });

      const row = await prisma.pairing.findUniqueOrThrow({ where: { id: pairing.id } });
      expect(row.confirmedAt).toBeNull();
      expect(row.endedAt).toBeNull();
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('reports nothing-to-undo on a court that has never played', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });

    try {
      const res = await request(server)
        .post(`/sessions/${sessionCode}/courts/1/undo`)
        .expect(201);
      expect(res.body).toEqual({ ok: false, reason: 'nothing-to-undo' });
    } finally {
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('refuses to undo a finish whose players have already started another match', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 2, rawImportText: '' },
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
    // The same four are now on court 2, so restoring court 1 would double-book.
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 2,
        matchNumber: 1,
        teamA: JSON.stringify([players[0].id, players[2].id]),
        teamB: JSON.stringify([players[1].id, players[3].id]),
        confirmedAt: new Date(),
      },
    });

    try {
      const res = await request(server)
        .post(`/sessions/${sessionCode}/courts/1/undo`)
        .expect(201);
      expect(res.body).toEqual({ ok: false, reason: 'players-busy' });
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('undoes only the most recent match on that court', async () => {
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
    const first = await prisma.pairing.create({
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
    const second = await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 2,
        teamA: JSON.stringify([players[0].id, players[2].id]),
        teamB: JSON.stringify([players[1].id, players[3].id]),
        confirmedAt: new Date(),
        endedAt: new Date(),
        winner: 'B',
      },
    });

    try {
      await request(server)
        .post(`/sessions/${sessionCode}/courts/1/undo`)
        .expect(201);

      const older = await prisma.pairing.findUniqueOrThrow({ where: { id: first.id } });
      expect(older.endedAt).not.toBeNull();
      expect(older.winner).toBe('A');

      const newer = await prisma.pairing.findUniqueOrThrow({ where: { id: second.id } });
      expect(newer.endedAt).toBeNull();
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('defaults to variety mode and switches to balanced', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });

    try {
      const before = await request(server).get(`/sessions/${sessionCode}`).expect(200);
      expect(before.body.mode).toBe('variety');

      await request(server)
        .post(`/sessions/${sessionCode}/mode`)
        .send({ mode: 'balanced' })
        .expect(201);

      const after = await request(server).get(`/sessions/${sessionCode}`).expect(200);
      expect(after.body.mode).toBe('balanced');
    } finally {
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('rejects an unknown mode', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });

    try {
      await request(server)
        .post(`/sessions/${sessionCode}/mode`)
        .send({ mode: 'sideways' })
        .expect(400);
    } finally {
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('balanced mode splits the strong players up, using group-wide Elo', async () => {
    const groupCode = randomUUID();
    const oldSessionCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const [s1, s2, w1, w2] = await Promise.all(
      ['S1', 'S2', 'W1', 'W2'].map((name) =>
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
    // S1+S2 beat W1+W2 repeatedly last week, so the ratings diverge.
    for (let i = 0; i < 8; i++) {
      await prisma.pairing.create({
        data: {
          sessionId: oldSessionCode,
          courtNumber: 1,
          matchNumber: i + 1,
          teamA: JSON.stringify([s1.id, s2.id]),
          teamB: JSON.stringify([w1.id, w2.id]),
          confirmedAt: new Date(Date.now() + i * 1000),
          endedAt: new Date(),
          winner: 'A',
        },
      });
    }
    await prisma.session.create({
      data: {
        code: sessionCode,
        groupId: groupCode,
        courtCount: 1,
        rawImportText: '',
        mode: 'balanced',
      },
    });
    for (const p of [s1, s2, w1, w2]) {
      await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    }

    try {
      // Repeated: with no balancing this split is one of three picked at random.
      for (let i = 0; i < 6; i++) {
        const res = await request(server)
          .post(`/sessions/${sessionCode}/courts/1/propose`)
          .expect(201);
        expect(res.body.ok).toBe(true);
        const { teamA } = res.body.pairing as { teamA: string[] };
        const strongOnA = teamA.filter((id) => id === s1.id || id === s2.id).length;
        expect(strongOnA).toBe(1);
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

  it('reports when each waiting player last finished a match', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    const finishedAt = new Date('2026-09-08T13:00:00.000Z');
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
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([players[0].id, players[1].id]),
        teamB: JSON.stringify([players[2].id, players[3].id]),
        confirmedAt: new Date(),
        endedAt: finishedAt,
        winner: 'A',
      },
    });

    try {
      const res = await request(server).get(`/sessions/${sessionCode}`).expect(200);
      expect(res.body.lastPlayedAt[players[0].id]).toBe(finishedAt.toISOString());
      // Never played tonight -> no entry, so the client falls back to the
      // session start rather than showing a bogus wait of zero.
      expect(res.body.lastPlayedAt[randomUUID()]).toBeUndefined();
      expect(typeof res.body.createdAt).toBe('string');
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('fills every idle court in one call', async () => {
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
      const res = await request(server)
        .post(`/sessions/${sessionCode}/courts/fill`)
        .expect(201);
      expect(res.body.filled).toEqual([1, 2]);

      const rows = await prisma.pairing.findMany({ where: { sessionId: sessionCode } });
      expect(rows).toHaveLength(2);
      const assigned = rows.flatMap((r) => [
        ...(JSON.parse(r.teamA) as string[]),
        ...(JSON.parse(r.teamB) as string[]),
      ]);
      expect(new Set(assigned).size).toBe(8);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('fills only what the roster can support and leaves the rest idle', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D', 'E'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 3, rawImportText: '' },
    });
    for (const p of players) {
      await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    }

    try {
      const res = await request(server)
        .post(`/sessions/${sessionCode}/courts/fill`)
        .expect(201);
      expect(res.body.filled).toEqual([1]);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('leaves a busy court alone when filling', async () => {
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
      const res = await request(server)
        .post(`/sessions/${sessionCode}/courts/fill`)
        .expect(201);
      expect(res.body.filled).toEqual([2]);

      const onCourt2 = await prisma.pairing.findFirstOrThrow({
        where: { sessionId: sessionCode, courtNumber: 2 },
      });
      const four = [
        ...(JSON.parse(onCourt2.teamA) as string[]),
        ...(JSON.parse(onCourt2.teamB) as string[]),
      ];
      // Court 1's players are still playing and must not be double-booked.
      expect(four).not.toContain(players[0].id);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('undoes an unconfirmed proposal by discarding it', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify(['p1', 'p2']),
        teamB: JSON.stringify(['p3', 'p4']),
      },
    });

    try {
      const res = await request(server)
        .post(`/sessions/${sessionCode}/courts/1/undo`)
        .expect(201);
      expect(res.body).toEqual({ ok: true, undone: 'propose' });

      const sess = await request(server).get(`/sessions/${sessionCode}`).expect(200);
      expect(sess.body.courts[0].status).toBe('idle');
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('reaches a finished match by undoing the proposal stacked on top of it', async () => {
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
    const finished = await prisma.pairing.create({
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
    // The host has already proposed the next match before noticing the wrong
    // winner on the one before.
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 2,
        teamA: JSON.stringify([players[0].id, players[2].id]),
        teamB: JSON.stringify([players[1].id, players[3].id]),
      },
    });

    try {
      const first = await request(server)
        .post(`/sessions/${sessionCode}/courts/1/undo`)
        .expect(201);
      expect(first.body.undone).toBe('propose');

      const second = await request(server)
        .post(`/sessions/${sessionCode}/courts/1/undo`)
        .expect(201);
      expect(second.body.undone).toBe('finish');

      const row = await prisma.pairing.findUniqueOrThrow({ where: { id: finished.id } });
      expect(row.endedAt).toBeNull();
      expect(row.winner).toBeNull();
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('chooses a court\'s four by rotation priority when other courts are idle', async () => {
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
    // A and B have partnered heavily; so have C and D. A good plan across both
    // idle courts splits each of those pairs rather than stranding one of them
    // together on the court proposed second.
    for (let i = 0; i < 6; i++) {
      await prisma.pairing.create({
        data: {
          sessionId: sessionCode,
          courtNumber: 1,
          matchNumber: i + 1,
          teamA: JSON.stringify([players[0].id, players[1].id]),
          teamB: JSON.stringify([players[2].id, players[3].id]),
          confirmedAt: new Date(Date.now() + i * 1000),
          endedAt: new Date(),
          winner: 'A',
        },
      });
    }

    try {
      const res = await request(server)
        .post(`/sessions/${sessionCode}/courts/1/propose`)
        .expect(201);
      expect(res.body.ok).toBe(true);
      const { teamA, teamB } = res.body.pairing as { teamA: string[]; teamB: string[] };

      // A-D already played six games. A one-court proposal must commit the
      // four people who have waited, rather than reserve them for a plan that
      // is not being committed.
      expect(new Set([...teamA, ...teamB])).toEqual(
        new Set(players.slice(4).map((player) => player.id))
      );
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('does not let a player re-enabled late monopolise the next matches', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D', 'LATE'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    const late = players[4];
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    for (const p of players) {
      await prisma.sessionRoster.create({
        data: { sessionId: sessionCode, playerId: p.id, active: p.id !== late.id },
      });
    }
    // The other four have played three matches while LATE had not arrived.
    for (let i = 0; i < 3; i++) {
      await prisma.pairing.create({
        data: {
          sessionId: sessionCode,
          courtNumber: 1,
          matchNumber: i + 1,
          teamA: JSON.stringify([players[0].id, players[1].id]),
          teamB: JSON.stringify([players[2].id, players[3].id]),
          confirmedAt: new Date(Date.now() + i * 1000),
          endedAt: new Date(),
          winner: 'A',
        },
      });
    }

    try {
      await request(server)
        .post(`/sessions/${sessionCode}/roster/${late.id}/active`)
        .send({ active: true })
        .expect(201);

      // Five active players, one court: exactly one sits each round, and the
      // fix makes LATE tied with everyone rather than ahead of them — so LATE
      // still plays most rounds, and asserting otherwise would be asserting
      // luck. What must hold is that LATE can now be the one sitting, which
      // was impossible before: on zero games they won every draw. 60 rounds
      // makes never-sitting a one-in-a-million event rather than a coin toss.
      let lateSatOut = 0;
      for (let i = 0; i < 60; i++) {
        const res = await request(server)
          .post(`/sessions/${sessionCode}/courts/1/propose`)
          .expect(201);
        const four = [...res.body.pairing.teamA, ...res.body.pairing.teamB];
        if (!four.includes(late.id)) lateSatOut += 1;
        await prisma.pairing.deleteMany({ where: { sessionId: sessionCode, confirmedAt: null } });
      }
      expect(lateSatOut).toBeGreaterThan(0);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('lets a returning player fall to the front of the queue as others play on', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D', 'LATE'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    const late = players[4];
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    for (const p of players) {
      await prisma.sessionRoster.create({
        data: { sessionId: sessionCode, playerId: p.id, active: p.id !== late.id },
      });
    }
    const playMatch = async (n: number) => {
      await prisma.pairing.create({
        data: {
          sessionId: sessionCode,
          courtNumber: 1,
          matchNumber: n,
          teamA: JSON.stringify([players[0].id, players[1].id]),
          teamB: JSON.stringify([players[2].id, players[3].id]),
          confirmedAt: new Date(Date.now() + n * 1000),
          endedAt: new Date(),
          winner: 'A',
        },
      });
    };
    for (let i = 1; i <= 3; i++) await playMatch(i);

    try {
      await request(server)
        .post(`/sessions/${sessionCode}/roster/${late.id}/active`)
        .send({ active: true })
        .expect(201);

      // LATE comes back level on 3. One more match among the others puts them
      // on 4, leaving LATE strictly the least-played — so the next proposal
      // must include them. This is the "waits about one rotation" claim, and
      // it holds without depending on any coin toss.
      await playMatch(4);

      const res = await request(server)
        .post(`/sessions/${sessionCode}/courts/1/propose`)
        .expect(201);
      const four = [...res.body.pairing.teamA, ...res.body.pairing.teamB];
      expect(four).toContain(late.id);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('credits a returning player with the highest count already on the roster', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D', 'LATE'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    const late = players[4];
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' },
    });
    for (const p of players) {
      await prisma.sessionRoster.create({
        data: { sessionId: sessionCode, playerId: p.id, active: p.id !== late.id },
      });
    }
    for (let i = 0; i < 3; i++) {
      await prisma.pairing.create({
        data: {
          sessionId: sessionCode,
          courtNumber: 1,
          matchNumber: i + 1,
          teamA: JSON.stringify([players[0].id, players[1].id]),
          teamB: JSON.stringify([players[2].id, players[3].id]),
          confirmedAt: new Date(Date.now() + i * 1000),
          endedAt: new Date(),
          winner: 'A',
        },
      });
    }

    try {
      await request(server)
        .post(`/sessions/${sessionCode}/roster/${late.id}/active`)
        .send({ active: true })
        .expect(201);

      const row = await prisma.sessionRoster.findFirstOrThrow({
        where: { sessionId: sessionCode, playerId: late.id },
      });
      expect(row.gamesOffset).toBe(3);

      // The stats table must still report what actually happened.
      const stats = await request(server)
        .get(`/sessions/${sessionCode}/stats`)
        .expect(200);
      const lateRow = stats.body.find((r: { playerId: string }) => r.playerId === late.id);
      expect(lateRow).toBeUndefined();
      const aRow = stats.body.find((r: { playerId: string }) => r.playerId === players[0].id);
      expect(aRow.played).toBe(3);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('never lowers a player by toggling them off and straight back on', async () => {
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
    // Everyone has played twice, so a mis-tap must not hand out a discount.
    for (let i = 0; i < 2; i++) {
      await prisma.pairing.create({
        data: {
          sessionId: sessionCode,
          courtNumber: 1,
          matchNumber: i + 1,
          teamA: JSON.stringify([players[0].id, players[1].id]),
          teamB: JSON.stringify([players[2].id, players[3].id]),
          confirmedAt: new Date(Date.now() + i * 1000),
          endedAt: new Date(),
          winner: 'A',
        },
      });
    }

    try {
      await request(server)
        .post(`/sessions/${sessionCode}/roster/${players[0].id}/active`)
        .send({ active: false })
        .expect(201);
      await request(server)
        .post(`/sessions/${sessionCode}/roster/${players[0].id}/active`)
        .send({ active: true })
        .expect(201);

      const row = await prisma.sessionRoster.findFirstOrThrow({
        where: { sessionId: sessionCode, playerId: players[0].id },
      });
      // Already level with everyone, so nothing is credited.
      expect(row.gamesOffset).toBe(0);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('measures a late arrival\'s wait from when they arrived, not the session start', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'LATE'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    const late = players[1];
    // The session started two hours ago.
    await prisma.session.create({
      data: {
        code: sessionCode,
        groupId: groupCode,
        courtCount: 1,
        rawImportText: '',
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    });
    for (const p of players) {
      await prisma.sessionRoster.create({
        data: { sessionId: sessionCode, playerId: p.id, active: p.id !== late.id },
      });
    }

    try {
      const before = await request(server).get(`/sessions/${sessionCode}`).expect(200);
      expect(before.body.activatedAt[late.id]).toBeUndefined();

      await request(server)
        .post(`/sessions/${sessionCode}/roster/${late.id}/active`)
        .send({ active: true })
        .expect(201);

      const after = await request(server).get(`/sessions/${sessionCode}`).expect(200);
      const activated = new Date(after.body.activatedAt[late.id]).getTime();
      // Just now, not two hours ago.
      expect(Date.now() - activated).toBeLessThan(60_000);
    } finally {
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
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
      const confirmRes = await request(server)
        .post(`/sessions/${sessionCode}/pairings/${pairing.id}/confirm`)
        .expect(201);
      expect(confirmRes.body.confirmedAt).not.toBeNull();
      expect(confirmRes.body.endedAt).toBeNull();

      const finishRes = await request(server)
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
      const res = await request(server)
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
      const res = await request(server)
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
      await request(server)
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
      await request(server)
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
      await request(server)
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
      const response = await request(server)
        .post(`/sessions/${sessionCode}/pairings/${pairing.id}/confirm`)
        .expect(409);
      expect(response.body.code).toBe('PAIRING_CONFIRMED');

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
      const response = await request(server)
        .post(`/sessions/${sessionCode}/courts/1/propose`)
        .expect(409);
      expect(response.body.code).toBe('SESSION_ENDED');

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
      const res = await request(server)
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
      const res = await request(server).get(`/sessions/${sessionCode}`).expect(200);
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
      const res = await request(server)
        .post(`/sessions/${sessionCode}/end`)
        .expect(201);
      expect(res.body.code).toBe(sessionCode);
      expect(res.body.endedAt).not.toBeNull();

      const getRes = await request(server).get(`/sessions/${sessionCode}`).expect(200);
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
      const res = await request(server).post(`/sessions/${sessionCode}/end`).expect(409);
      expect(res.body.code).toBe('SESSION_HAS_UNFINISHED_PAIRINGS');

      const getRes = await request(server).get(`/sessions/${sessionCode}`).expect(200);
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
      const res = await request(server)
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
      const sessionScoped = await request(server)
        .get(`/sessions/${currentSessionCode}/stats`)
        .expect(200);
      expect(sessionScoped.body).toEqual([]);

      const allTime = await request(server)
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
    await request(server).get(`/sessions/${randomUUID()}/stats`).expect(404);
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
      const res = await request(server)
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

  it('picks the fewest-games substitute before considering repeat partners', async () => {
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
    // F has played twice tonight and E not at all. Rotation priority must
    // select E even though that repeats E+B from last week.
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
      const res = await request(server)
        .post(`/sessions/${sessionCode}/pairings/${pending.id}/swap`)
        .send({ playerId: a.id })
        .expect(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.pairing.teamA).toEqual([e.id, b.id]);
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
      const res = await request(server)
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
      const res = await request(server)
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
      await request(server)
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
  /**
   * Finding 30: the waiting list the host reads is sorted by how long each
   * player has been sitting, but the engine used to break games-played ties at
   * random and never looked at waiting time. Someone who had just walked off
   * court could be picked ahead of a player who had been waiting half an hour,
   * which is the single thing a rotation is supposed to prevent.
   */
  it('sends the longest-waiting players on first when games played are level', async () => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((name) =>
        prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: {
        code: sessionCode,
        groupId: groupCode,
        courtCount: 1,
        rawImportText: '',
        // A wait can never predate the session, so the session has to have
        // started before either match ended for this to measure anything.
        createdAt: new Date(Date.now() - 3 * 60 * 60_000),
      },
    });
    for (const p of players) {
      await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    }

    const longAgo = new Date(Date.now() - 60 * 60_000);
    const justNow = new Date(Date.now() - 60_000);
    // Everyone has played exactly one game, so games-played cannot separate
    // them and only the wait can. A-D came off an hour ago, E-H a minute ago.
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 1,
        teamA: JSON.stringify([players[0].id, players[1].id]),
        teamB: JSON.stringify([players[2].id, players[3].id]),
        confirmedAt: longAgo,
        endedAt: longAgo,
      },
    });
    await prisma.pairing.create({
      data: {
        sessionId: sessionCode,
        courtNumber: 1,
        matchNumber: 2,
        teamA: JSON.stringify([players[4].id, players[5].id]),
        teamB: JSON.stringify([players[6].id, players[7].id]),
        confirmedAt: justNow,
        endedAt: justNow,
      },
    });

    const waitedLongest = new Set(players.slice(0, 4).map((p) => p.id));

    try {
      // Repeated because the remaining tie-break is random: if waiting time
      // were still being ignored, some run would put a fresh player on.
      for (let i = 0; i < 10; i++) {
        const res = await request(server)
          .post(`/sessions/${sessionCode}/courts/1/propose`)
          .expect(201);
        const { teamA, teamB } = res.body.pairing as { teamA: string[]; teamB: string[] };
        expect(new Set([...teamA, ...teamB])).toEqual(waitedLongest);
        await prisma.pairing.deleteMany({ where: { sessionId: sessionCode, matchNumber: 3 } });
      }
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('reports queue games so the waiting list can match the rotation', async () => {
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
    // A late arrival is credited with the games they missed, for rotation only.
    await prisma.sessionRoster.updateMany({
      where: { sessionId: sessionCode, playerId: players[3].id },
      data: { gamesOffset: 2 },
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
      },
    });

    try {
      const res = await request(server).get(`/sessions/${sessionCode}`).expect(200);
      expect(res.body.queueGames).toEqual({
        [players[0].id]: 1,
        [players[1].id]: 1,
        [players[2].id]: 1,
        [players[3].id]: 3,
      });

      // The offset is rotation-only and must never leak into statistics.
      const stats = await request(server)
        .get(`/sessions/${sessionCode}/stats?scope=session`)
        .expect(200);
      const late = (stats.body as { playerId: string; played: number }[]).find(
        (r) => r.playerId === players[3].id
      );
      expect(late?.played).toBe(1);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  /**
   * Finding 31: an imported message can book one court at 19:00 and three at
   * 20:00, but a session carries a single court count. The parser now warns,
   * and the host adjusts the count here when the later slot starts.
   */
  it('changes the court count mid-session and refuses to drop a court still playing', async () => {
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

    try {
      // The 20:00 slot opens two more courts.
      await request(server)
        .post(`/sessions/${sessionCode}/court-count`)
        .send({ courtCount: 3 })
        .expect(201)
        .expect((res) => {
          expect(res.body.courtCount).toBe(3);
        });
      const grown = await request(server).get(`/sessions/${sessionCode}`).expect(200);
      expect(grown.body.courts).toHaveLength(3);

      // Court 3 is playing, so shrinking past it must be refused rather than
      // silently cancelling the match the players are in the middle of.
      await prisma.pairing.create({
        data: {
          sessionId: sessionCode,
          courtNumber: 3,
          matchNumber: 1,
          teamA: JSON.stringify([players[0].id, players[1].id]),
          teamB: JSON.stringify([players[2].id, players[3].id]),
          confirmedAt: new Date(),
        },
      });
      await request(server)
        .post(`/sessions/${sessionCode}/court-count`)
        .send({ courtCount: 2 })
        .expect(409)
        .expect((res) => {
          expect(res.body.code).toBe('COURT_IN_USE');
          expect(res.body.courtNumbers).toEqual([3]);
        });
      const unchanged = await request(server).get(`/sessions/${sessionCode}`).expect(200);
      expect(unchanged.body.courtCount).toBe(3);

      // Once that match is finished the court is free to give back.
      await prisma.pairing.updateMany({
        where: { sessionId: sessionCode },
        data: { endedAt: new Date(), winner: 'A' },
      });
      await request(server)
        .post(`/sessions/${sessionCode}/court-count`)
        .send({ courtCount: 2 })
        .expect(201);

      await request(server)
        .post(`/sessions/${sessionCode}/court-count`)
        .send({ courtCount: 0 })
        .expect(400);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  /**
   * Finding 34: corrupt state used to come back as "not enough players", which
   * sends the host looking for absent people while the real fault sits in the
   * database.
   */
  it('reports corrupt session state distinctly instead of blaming the roster', async () => {
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
      // Sanity: with a sound roster this court fills.
      await request(server)
        .post(`/sessions/${sessionCode}/courts/1/propose`)
        .expect(201)
        .expect((res) => {
          expect(res.body.ok).toBe(true);
        });
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });

      // Now corrupt the rotation offset. A duplicated roster row is impossible
      // — SessionRoster is unique on (sessionId, playerId) — but nothing
      // constrains gamesOffset, so a negative one is the reachable corruption,
      // and it makes a player's game count negative.
      await prisma.sessionRoster.updateMany({
        where: { sessionId: sessionCode, playerId: players[0].id },
        data: { gamesOffset: -5 },
      });

      await request(server)
        .post(`/sessions/${sessionCode}/courts/1/propose`)
        .expect(500)
        .expect((res) => {
          expect(res.body.code).toBe('INVALID_SESSION_STATE');
          expect(res.body.detail).toContain('gamesPlayedThisSession');
        });
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });


  /**
   * Finding 35: resting a player left any pending proposal they were in
   * untouched, so they could still be confirmed onto court after the host had
   * marked them a no-show. The proposal is not invalidated when they are
   * rested — that would be surprising and racy — but confirming it is refused,
   * which is the moment it would actually do harm.
   */
  it('refuses to confirm a proposal containing a player who has been rested', async () => {
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

    try {
      const proposed = await request(server)
        .post(`/sessions/${sessionCode}/courts/1/propose`)
        .expect(201);
      const pairingId = proposed.body.pairing.id;
      const onCourt = [...proposed.body.pairing.teamA, ...proposed.body.pairing.teamB];
      const [rested] = onCourt;

      await request(server)
        .post(`/sessions/${sessionCode}/roster/${rested}/active`)
        .send({ active: false })
        .expect(201);

      // The proposal survives — nothing is silently rewritten underneath the
      // host — but it cannot be committed.
      const still = await request(server).get(`/sessions/${sessionCode}`).expect(200);
      expect(still.body.courts[0].status).toBe('pending');
      expect(still.body.restingPlayerIds).toEqual([rested]);

      await request(server)
        .post(`/sessions/${sessionCode}/pairings/${pairingId}/confirm`)
        .expect(409)
        .expect((res) => {
          expect(res.body.code).toBe('PLAYER_UNAVAILABLE');
          expect(res.body.playerIds).toEqual([rested]);
        });

      // Swapping them out is the fix, and the substitute comes from the
      // active roster, so the confirm then goes through.
      const swapped = await request(server)
        .post(`/sessions/${sessionCode}/pairings/${pairingId}/swap`)
        .send({ playerId: rested })
        .expect(201);
      expect(swapped.body.ok).toBe(true);
      const replacement = [...swapped.body.pairing.teamA, ...swapped.body.pairing.teamB];
      expect(replacement).not.toContain(rested);

      await request(server)
        .post(`/sessions/${sessionCode}/pairings/${pairingId}/confirm`)
        .expect(201);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('leaves an active match alone when one of its players is rested', async () => {
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
        confirmedAt: new Date(),
      },
    });

    try {
      // They are physically on court. Marking them as leaving after this game
      // must not disturb the game they are in the middle of.
      await request(server)
        .post(`/sessions/${sessionCode}/roster/${players[0].id}/active`)
        .send({ active: false })
        .expect(201);

      const session = await request(server).get(`/sessions/${sessionCode}`).expect(200);
      expect(session.body.courts[0].status).toBe('active');

      await request(server)
        .post(`/sessions/${sessionCode}/pairings/${pairing.id}/finish`)
        .send({ scoreA: 21, scoreB: 15, winner: 'A' })
        .expect(201);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });


  /**
   * Manual swap fixture: `courts` describes pending pairings by player index,
   * so a test can say "two courts, trade across them" without restating setup.
   */
  const manualSwapFixture = async (names: string[], courts: number[][]) => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = await Promise.all(
      names.map((name) => prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } }))
    );
    await prisma.session.create({
      data: {
        code: sessionCode,
        groupId: groupCode,
        courtCount: Math.max(1, courts.length),
        rawImportText: '',
      },
    });
    for (const p of players) {
      await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    }
    const pairings = [];
    for (const [i, four] of courts.entries()) {
      pairings.push(
        await prisma.pairing.create({
          data: {
            sessionId: sessionCode,
            courtNumber: i + 1,
            matchNumber: i + 1,
            teamA: JSON.stringify([players[four[0]].id, players[four[1]].id]),
            teamB: JSON.stringify([players[four[2]].id, players[four[3]].id]),
          },
        })
      );
    }
    const cleanup = async () => {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    };
    return { groupCode, sessionCode, players, pairings, cleanup };
  };

  it('swaps in the named player rather than rotation\'s choice', async () => {
    // E is waiting behind F, so automatic rotation would not pick F. Naming F
    // is the whole point of the manual gesture.
    const { sessionCode, players, pairings, cleanup } = await manualSwapFixture(
      ['A', 'B', 'C', 'D', 'E', 'F'],
      [[0, 1, 2, 3]]
    );
    try {
      const res = await request(server)
        .post(`/sessions/${sessionCode}/pairings/${pairings[0].id}/swap`)
        .send({ playerId: players[0].id, withPlayerId: players[5].id })
        .expect(201);
      expect(res.body.pairing.teamA).toEqual([players[5].id, players[1].id]);
      expect(res.body.pairing.teamB).toEqual([players[2].id, players[3].id]);
    } finally {
      await cleanup();
    }
  });

  it('trades two players who are on different pending courts', async () => {
    const { sessionCode, players, pairings, cleanup } = await manualSwapFixture(
      ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
      [
        [0, 1, 2, 3],
        [4, 5, 6, 7],
      ]
    );
    try {
      const res = await request(server)
        .post(`/sessions/${sessionCode}/pairings/${pairings[0].id}/swap`)
        .send({ playerId: players[0].id, withPlayerId: players[4].id })
        .expect(201);
      expect(res.body.pairing.teamA).toEqual([players[4].id, players[1].id]);

      // The far court must have received A in E's seat — a trade, not a
      // duplication, and not a court left a player short.
      const other = await prisma.pairing.findUniqueOrThrow({ where: { id: pairings[1].id } });
      expect(JSON.parse(other.teamA)).toEqual([players[0].id, players[5].id]);
      expect(other.revision).toBe(pairings[1].revision + 1);
    } finally {
      await cleanup();
    }
  });

  it('refuses to pull a player out of a match already under way', async () => {
    const { sessionCode, players, pairings, cleanup } = await manualSwapFixture(
      ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
      [
        [0, 1, 2, 3],
        [4, 5, 6, 7],
      ]
    );
    try {
      await prisma.pairing.update({
        where: { id: pairings[1].id },
        data: { confirmedAt: new Date() },
      });
      const res = await request(server)
        .post(`/sessions/${sessionCode}/pairings/${pairings[0].id}/swap`)
        .send({ playerId: players[0].id, withPlayerId: players[4].id })
        .expect(409);
      expect(res.body.code).toBe('PAIRING_NOT_PENDING');

      // The running match keeps the players its score will be recorded against.
      const running = await prisma.pairing.findUniqueOrThrow({ where: { id: pairings[1].id } });
      expect(JSON.parse(running.teamA)).toEqual([players[4].id, players[5].id]);
    } finally {
      await cleanup();
    }
  });

  it('refuses to bring on a player who is resting', async () => {
    const { sessionCode, players, pairings, cleanup } = await manualSwapFixture(
      ['A', 'B', 'C', 'D', 'E'],
      [[0, 1, 2, 3]]
    );
    try {
      await prisma.sessionRoster.updateMany({
        where: { sessionId: sessionCode, playerId: players[4].id },
        data: { active: false },
      });
      const res = await request(server)
        .post(`/sessions/${sessionCode}/pairings/${pairings[0].id}/swap`)
        .send({ playerId: players[0].id, withPlayerId: players[4].id })
        .expect(409);
      expect(res.body.code).toBe('PLAYER_UNAVAILABLE');
      expect(res.body.playerIds).toEqual([players[4].id]);
    } finally {
      await cleanup();
    }
  });

  it('refuses a player who is not in tonight\'s session at all', async () => {
    const { groupCode, sessionCode, players, pairings, cleanup } = await manualSwapFixture(
      ['A', 'B', 'C', 'D'],
      [[0, 1, 2, 3]]
    );
    try {
      const outsider = await prisma.player.create({
        data: { groupId: groupCode, name: 'Outsider', aliases: '[]' },
      });
      await request(server)
        .post(`/sessions/${sessionCode}/pairings/${pairings[0].id}/swap`)
        .send({ playerId: players[0].id, withPlayerId: outsider.id })
        .expect(404);
    } finally {
      await cleanup();
    }
  });

  it('rejects swapping a player with themselves', async () => {
    const { sessionCode, players, pairings, cleanup } = await manualSwapFixture(
      ['A', 'B', 'C', 'D', 'E'],
      [[0, 1, 2, 3]]
    );
    try {
      const res = await request(server)
        .post(`/sessions/${sessionCode}/pairings/${pairings[0].id}/swap`)
        .send({ playerId: players[0].id, withPlayerId: players[0].id })
        .expect(409);
      expect(res.body.code).toBe('SWAP_SAME_PLAYER');
    } finally {
      await cleanup();
    }
  });

  it('does not write half a trade when the round moved on underneath it', async () => {
    const { sessionCode, players, pairings, cleanup } = await manualSwapFixture(
      ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
      [
        [0, 1, 2, 3],
        [4, 5, 6, 7],
      ]
    );
    try {
      const res = await request(server)
        .post(`/sessions/${sessionCode}/pairings/${pairings[0].id}/swap`)
        .send({ playerId: players[0].id, withPlayerId: players[4].id, expectedRevision: 99 })
        .expect(409);
      expect(res.body.code).toBe('PAIRING_STALE');

      // Neither court may have moved: a rolled-back trade that left the far
      // court written would put one player on two courts at once.
      const near = await prisma.pairing.findUniqueOrThrow({ where: { id: pairings[0].id } });
      const far = await prisma.pairing.findUniqueOrThrow({ where: { id: pairings[1].id } });
      expect(JSON.parse(near.teamA)).toEqual([players[0].id, players[1].id]);
      expect(JSON.parse(far.teamA)).toEqual([players[4].id, players[5].id]);
    } finally {
      await cleanup();
    }
  });
});
