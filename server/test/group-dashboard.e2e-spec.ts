import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { SESSION_SECRET } from '../src/auth/auth.module.js';
import { AuthBootstrapService } from '../src/auth/bootstrap.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { UsersService } from '../src/users/users.service.js';

const SECRET = 'e2e-dashboard-secret';
const PASSWORD = 'a genuinely correct e2e password';
const PLAYERS = 50;
const COURTS = 6;
const ROUNDS_PER_SESSION = 8;

/**
 * The whole feature against the real app and a real (migrated) SQLite file:
 * a 50-player group runs three sessions with the real engines, the host shares
 * the dashboard, and an anonymous caller reads it. The unit specs prove each
 * rule on a handful of rows; this proves the pieces agree at a real group's
 * size, and that the public read stays cheap with ~200 matches behind it.
 */
describe('group dashboard with a 50-player group (e2e)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let cookie: string;
  let userId: string;

  const groupCode = `e2e-${randomUUID().slice(0, 8)}`;
  const names = Array.from({ length: PLAYERS }, (_, i) => `ผู้เล่น${String(i + 1).padStart(2, '0')}`);
  const rosterText = names.map((n, i) => `${i + 1}. ${n}`).join('\n');
  const sessionCodes: string[] = [];

  const authed = (r: request.Test) => r.set('Cookie', cookie);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SESSION_SECRET)
      .useValue(SECRET)
      .overrideProvider(AuthBootstrapService)
      .useValue({ onModuleInit: async () => {} })
      .compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser(SECRET));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    prisma = app.get(PrismaService);

    const email = `e2e-dashboard-${randomUUID()}@example.test`;
    userId = (await app.get(UsersService).create(email, PASSWORD)).id;
    const login = await request(server).post('/auth/login').send({ email, password: PASSWORD }).expect(201);
    cookie = ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0];
  });

  afterAll(async () => {
    await prisma.pairing.deleteMany({ where: { session: { groupId: groupCode } } });
    await prisma.sessionRoster.deleteMany({ where: { session: { groupId: groupCode } } });
    await prisma.waitlist.deleteMany({ where: { session: { groupId: groupCode } } });
    await prisma.sessionCreation.deleteMany({ where: { groupId: groupCode } });
    await prisma.session.deleteMany({ where: { groupId: groupCode } });
    await prisma.player.deleteMany({ where: { groupId: groupCode } });
    await prisma.group.deleteMany({ where: { code: groupCode } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
  });

  /** Paste the roster the way the host does, then create the session from the parse result. */
  async function startSession(date: string): Promise<string> {
    const parsed = await authed(
      request(server).post(`/groups/${groupCode}/parse`).send({ groupName: 'ก๊วนทดสอบ 50 คน', rawText: rosterText })
    ).expect(201);
    expect(parsed.body.rosterReviews).toHaveLength(PLAYERS);

    const created = await authed(
      request(server)
        .post('/sessions')
        .send({
          groupCode,
          date,
          venue: 'ยิมทดสอบ',
          courtCount: COURTS,
          rawImportText: rosterText,
          idempotencyKey: randomUUID(),
          rosterReviews: parsed.body.rosterReviews.map((r: { inputName: string; match: unknown }) => ({
            inputName: r.inputName,
            match: r.match,
            decision: 'accept',
          })),
          waitlistReviews: [],
        })
    ).expect(201);
    return created.body.code as string;
  }

  /** One round: every idle court proposes, the host confirms each, then each match finishes. */
  async function playRound(code: string, finish: boolean) {
    await authed(request(server).post(`/sessions/${code}/courts/fill`)).expect(201);
    const session = await authed(request(server).get(`/sessions/${code}`)).expect(200);
    const pending = (session.body.courts as { status: string; pairingId?: string; revision?: number }[]).filter(
      (c) => c.status === 'pending'
    );
    expect(pending.length).toBe(COURTS);

    for (const court of pending) {
      await authed(
        request(server).post(`/sessions/${code}/pairings/${court.pairingId}/confirm`).send({ expectedRevision: court.revision })
      ).expect(201);
    }
    if (!finish) return;

    const active = await authed(request(server).get(`/sessions/${code}`)).expect(200);
    for (const court of active.body.courts as { status: string; pairingId?: string; revision?: number }[]) {
      if (court.status !== 'active') continue;
      await authed(
        request(server)
          .post(`/sessions/${code}/pairings/${court.pairingId}/finish`)
          .send({ winner: 'A', expectedRevision: court.revision })
      ).expect(201);
    }
  }

  it('runs three sessions with 50 players, two ended and one still live', async () => {
    for (const [i, date] of ['2026-09-10', '2026-09-17', '2026-09-24'].entries()) {
      const code = await startSession(date);
      sessionCodes.push(code);
      const last = i === 2;
      for (let r = 0; r < ROUNDS_PER_SESSION; r++) {
        // The live session's final round is confirmed but not finished: it is "playing now".
        await playRound(code, !(last && r === ROUNDS_PER_SESSION - 1));
      }
      if (!last) await authed(request(server).post(`/sessions/${code}/end`)).expect(201);
    }
    expect(sessionCodes).toHaveLength(3);
    expect(await prisma.player.count({ where: { groupId: groupCode } })).toBe(PLAYERS);
  }, 180_000);

  it('is private until shared, then public, then private again', async () => {
    const share = `/groups/${groupCode}/share`;
    expect((await authed(request(server).get(share)).expect(200)).body).toEqual({ token: null });

    const created = await authed(request(server).post(share)).expect(201);
    const token = created.body.token as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);

    // No cookie: the link works for a member.
    const res = await request(server).get(`/dashboards/${token}`).expect(200);
    expect(res.body.groupName).toBe('ก๊วนทดสอบ 50 คน');

    // The group code is NOT a way in.
    await request(server).get(`/dashboards/${groupCode}`).expect(404);

    await authed(request(server).delete(share)).expect(200);
    await request(server).get(`/dashboards/${token}`).expect(404);
  });

  it('shows all 50 players and three sessions, correctly counted, without leaking ids', async () => {
    const { body } = await authed(request(server).post(`/groups/${groupCode}/share`)).expect(201);
    const token = body.token as string;

    const started = performance.now();
    const res = await request(server).get(`/dashboards/${token}`).expect(200);
    const elapsed = performance.now() - started;
    const dash = res.body;

    // Sessions: newest first, the live one flagged.
    expect(dash.sessions.map((s: { date: string }) => s.date)).toEqual(['2026-09-24', '2026-09-17', '2026-09-10']);
    expect(dash.sessions.map((s: { live: boolean }) => s.live)).toEqual([true, false, false]);
    expect(dash.lastSessionDate).toBe('2026-09-24');
    for (const s of dash.sessions) {
      expect(s.matchCount).toBe(ROUNDS_PER_SESSION * COURTS);
      expect(s.playerCount).toBeLessThanOrEqual(PLAYERS);
      expect(s.playerCount).toBeGreaterThan(COURTS * 4); // rotation reached beyond the first 24
    }

    // Standings: everyone who stepped on court, ranked, participation-only.
    expect(dash.standings).toHaveLength(PLAYERS);
    const totalSeats = dash.standings.reduce((n: number, p: { gamesPlayed: number }) => n + p.gamesPlayed, 0);
    const matches = await prisma.pairing.count({
      where: { session: { groupId: groupCode }, confirmedAt: { not: null } },
    });
    expect(matches).toBe(3 * ROUNDS_PER_SESSION * COURTS);
    expect(totalSeats).toBe(matches * 4); // doubles: four seats a match, none lost or double-counted

    for (let i = 1; i < dash.standings.length; i++) {
      const a = dash.standings[i - 1];
      const b = dash.standings[i];
      expect([a.sessionsAttended, a.gamesPlayed]).toSatisfy(
        ([sa, ga]: number[]) => sa > b.sessionsAttended || (sa === b.sessionsAttended && ga >= b.gamesPlayed)
      );
    }
    expect(Math.max(...dash.standings.map((p: { sessionsAttended: number }) => p.sessionsAttended))).toBeLessThanOrEqual(3);

    // Nothing private rides along.
    const ids = (await prisma.player.findMany({ where: { groupId: groupCode }, select: { id: true } })).map((p) => p.id);
    const json = JSON.stringify(dash);
    for (const id of ids) expect(json).not.toContain(id);
    expect(json).not.toContain(groupCode);
    expect(json).not.toMatch(/rating|level|winRate|email|phone/i);
    expect(Object.keys(dash.standings[0]).sort()).toEqual(['gamesPlayed', 'name', 'sessionsAttended']);

    // ~200 matches behind it and still one cheap read.
    expect(elapsed).toBeLessThan(1000);
  });

  it('stays correct as the live session finishes and ends', async () => {
    const token = (await authed(request(server).get(`/groups/${groupCode}/share`)).expect(200)).body.token as string;
    const live = sessionCodes[2];

    const session = await authed(request(server).get(`/sessions/${live}`)).expect(200);
    for (const court of session.body.courts as { status: string; pairingId?: string; revision?: number }[]) {
      if (court.status !== 'active') continue;
      await authed(
        request(server).post(`/sessions/${live}/pairings/${court.pairingId}/finish`).send({ winner: 'B', expectedRevision: court.revision })
      ).expect(201);
    }
    await authed(request(server).post(`/sessions/${live}/end`)).expect(201);

    const dash = (await request(server).get(`/dashboards/${token}`).expect(200)).body;
    expect(dash.sessions.map((s: { live: boolean }) => s.live)).toEqual([false, false, false]);
    expect(dash.sessions[0].matchCount).toBe(ROUNDS_PER_SESSION * COURTS);
  }, 60_000);
});
