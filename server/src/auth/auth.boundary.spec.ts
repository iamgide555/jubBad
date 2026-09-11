import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../app.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SESSION_SECRET } from './auth.module.js';
import { AuthBootstrapService } from './bootstrap.service.js';
import { UsersService } from '../users/users.service.js';

const SECRET = 'boundary-test-secret';
const PASSWORD = 'a genuinely correct password';

/**
 * The public surface, exhaustively. Anything not on this list must refuse an
 * anonymous caller.
 *
 * This list is the security boundary written down. Per-route tests would let a
 * new route be added with no test at all and no failure; this walks the real
 * router, so a route that is added and left public fails here whether or not
 * anyone wrote a test for it.
 *
 * Each entry is deliberately justified — a route earns its place here only by
 * being read-only AND needed by a screen a player sees.
 */
const PUBLIC_ROUTES = [
  { method: 'get', path: (c: Ctx) => `/sessions/${c.sessionCode}`, why: 'venue display' },
  { method: 'get', path: (c: Ctx) => `/groups/${c.groupCode}`, why: 'display: group name' },
  { method: 'get', path: (c: Ctx) => `/groups/${c.groupCode}/players`, why: 'display: names' },
  {
    method: 'get',
    path: (c: Ctx) => `/groups/${c.groupCode}/players/${c.playerId}/stats`,
    why: 'player stat card',
  },
  {
    method: 'get',
    path: (c: Ctx) => `/sessions/${c.sessionCode}/summary`,
    why: 'session summary link, shared by the host',
  },
] as const;

interface Ctx {
  groupCode: string;
  sessionCode: string;
  playerId: string;
}

/**
 * Walks the router Express actually built, the same way the anonymous-caller
 * test does — reused here so the ownership walk checks the identical set of
 * routes rather than a second hand-kept list that could quietly drift from
 * the first.
 */
function declaredRoutes(server: ReturnType<INestApplication['getHttpServer']>) {
  const router = server._events.request._router ?? server._events.request.router;
  const declared: { method: string; path: string }[] = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      declared.push({ method, path: layer.route.path });
    }
  }
  return declared;
}

describe('auth boundary', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let ctx: Ctx;
  let email: string;
  let userId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SESSION_SECRET)
      .useValue(SECRET)
      // This file seeds its own user directly; it must not depend on
      // ADMIN_EMAIL / ADMIN_PASSWORD being present in the environment the
      // test happens to run in (there is no server/.env in a fresh clone or
      // CI).
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

    email = `boundary-${randomUUID()}@example.test`;
    const user = await app.get(UsersService).create(email, PASSWORD);
    userId = user.id;

    const groupCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'Boundary', ownerId: userId } });
    const player = await prisma.player.create({
      data: { groupId: groupCode, name: 'A', aliases: '[]' },
    });
    const sessionCode = randomUUID().slice(0, 8);
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, rawImportText: '' },
    });
    ctx = { groupCode, sessionCode, playerId: player.id };
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { groupId: ctx.groupCode } });
    await prisma.player.deleteMany({ where: { groupId: ctx.groupCode } });
    await prisma.group.deleteMany({ where: { code: ctx.groupCode } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
  });

  describe('public routes answer an anonymous caller', () => {
    for (const route of PUBLIC_ROUTES) {
      it(`${route.method.toUpperCase()} ${route.why}`, async () => {
        const res = await request(server)[route.method](route.path(ctx));
        expect(res.status).toBe(200);
      });
    }
  });

  it('refuses every other route to an anonymous caller', async () => {
    const publicPaths = new Set(PUBLIC_ROUTES.map((r) => `${r.method} ${r.path(ctx)}`));
    const declared = declaredRoutes(server);
    expect(declared.length).toBeGreaterThan(15);

    const leaked: string[] = [];
    for (const { method, path } of declared) {
      // Auth's own routes must stay reachable — you cannot log in with a
      // cookie you do not have yet.
      if (path.startsWith('/auth')) continue;

      // ':code' means a group code under /groups and a session code under
      // /sessions. Substituting the wrong one yields a 404 from a public route,
      // which looks exactly like a route that refused to answer.
      const code = path.startsWith('/sessions') ? ctx.sessionCode : ctx.groupCode;
      const concrete = path
        .replace(':code', code)
        .replace(':playerId', ctx.playerId)
        .replace(':id', 'some-id')
        .replace(':n', '1');
      if (publicPaths.has(`${method} ${concrete}`)) continue;
      if (concrete.includes(':')) continue; // unresolved param, skip

      const res = await request(server)[method as 'get'](concrete).send({});
      if (res.status !== 401) leaked.push(`${method.toUpperCase()} ${concrete} -> ${res.status}`);
    }

    // Named in the message: a bare array diff tells you the boundary broke but
    // not where, which is the one thing you need to fix it.
    expect(leaked, `routes answered an anonymous caller: ${leaked.join(' | ')}`).toEqual([]);
  });

  it('admits the same routes once the caller holds the cookie', async () => {
    const login = await request(server)
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(201);
    const cookie = ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0];

    await request(server).get('/groups').set('Cookie', cookie).expect(200);
    await request(server)
      .get(`/groups/${ctx.groupCode}/sessions`)
      .set('Cookie', cookie)
      .expect(200);
  });

  it('keeps the full data export behind auth', async () => {
    // An export is every player, session and match in one response — the single
    // most valuable thing to leak, and a GET, which is easy to overlook when
    // thinking of auth as protecting writes.
    await request(server).get(`/groups/${ctx.groupCode}/export`).expect(401);
  });

  it('keeps group deletion behind auth', async () => {
    await request(server).delete(`/groups/${ctx.groupCode}`).expect(401);
    // ...and the group is still there.
    await request(server).get(`/groups/${ctx.groupCode}`).expect(200);
  });

  /**
   * The second dimension of the boundary. The tests above establish that an
   * anonymous caller is refused everywhere except PUBLIC_ROUTES; these
   * establish that an *authenticated* caller is refused everywhere except
   * what they themselves own. Same walk of the same real router, so a route
   * added later that forgets ownership fails here whether or not anyone
   * thought to test it directly — the property this file exists for.
   */
  describe('ownership boundary', () => {
    let otherEmail: string;
    let otherUserId: string;
    let otherCookie: string;

    beforeAll(async () => {
      otherEmail = `boundary-other-${randomUUID()}@example.test`;
      const otherUser = await app.get(UsersService).create(otherEmail, PASSWORD);
      otherUserId = otherUser.id;

      const login = await request(server)
        .post('/auth/login')
        .send({ email: otherEmail, password: PASSWORD })
        .expect(201);
      otherCookie = ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0];
    });

    afterAll(async () => {
      await prisma.user.deleteMany({ where: { id: otherUserId } });
    });

    it("refuses a second host every route that touches the first host's group or session", async () => {
      const publicPaths = new Set(PUBLIC_ROUTES.map((r) => `${r.method} ${r.path(ctx)}`));
      const declared = declaredRoutes(server);

      const leaked: string[] = [];
      for (const { method, path } of declared) {
        if (path.startsWith('/auth')) continue;

        const code = path.startsWith('/sessions') ? ctx.sessionCode : ctx.groupCode;
        const concrete = path
          .replace(':code', code)
          .replace(':playerId', ctx.playerId)
          .replace(':id', 'some-id')
          .replace(':n', '1');
        if (publicPaths.has(`${method} ${concrete}`)) continue;
        if (concrete.includes(':')) continue;
        // None of these three has a :code in the path, so OwnershipGuard
        // deliberately lets all of them through: GET / addresses no group at
        // all (AppController's scaffold route); GET /groups is filtered by
        // owner in the service (checked properly below); POST /sessions names
        // its group in the body (checked in SessionsService.createSession,
        // exercised by the race test below). A blanket 404 here would be
        // testing the wrong layer for exactly these three routes.
        if (concrete === '/' || concrete === '/groups' || concrete === '/sessions') continue;

        const res = await request(server)
          [method as 'get'](concrete)
          .set('Cookie', otherCookie)
          .send({});
        if (res.status !== 404) leaked.push(`${method.toUpperCase()} ${concrete} -> ${res.status}`);
      }

      expect(
        leaked,
        `routes answered a non-owning caller: ${leaked.join(' | ')}`
      ).toEqual([]);
    });

    it('refuses to create a session by naming a group the caller does not own', async () => {
      // POST /sessions has no :code in the path, so the ownership check the
      // guard applies everywhere else runs inside
      // SessionsService.createSession instead — this is what proves that
      // check actually runs, since the router walk above skips this route.
      await request(server)
        .post('/sessions')
        .set('Cookie', otherCookie)
        .send({
          groupCode: ctx.groupCode,
          date: null,
          venue: null,
          courtCount: null,
          rawImportText: '',
          idempotencyKey: randomUUID(),
          rosterReviews: [],
          waitlistReviews: [],
        })
        .expect(404);
    });

    it('still admits the second host to a group and session that host owns', async () => {
      // Real flow, not a row written directly — this is exactly the path A15
      // and B12's review flagged as untested: create-or-own through
      // GroupsService.parse, then a session inside the claimed group.
      const freshCode = randomUUID();
      await request(server)
        .post(`/groups/${freshCode}/parse`)
        .set('Cookie', otherCookie)
        .send({ groupName: 'Other Host Group', rawText: '1. Solo' })
        .expect(201);

      const listed = await request(server).get('/groups').set('Cookie', otherCookie).expect(200);
      const codes = (listed.body as { code: string }[]).map((g) => g.code);
      expect(codes).toContain(freshCode);
      // ...and the first host's group, created before this one, does not leak
      // into the second host's own list.
      expect(codes).not.toContain(ctx.groupCode);

      const created = await request(server)
        .post('/sessions')
        .set('Cookie', otherCookie)
        .send({
          groupCode: freshCode,
          date: null,
          venue: null,
          courtCount: null,
          rawImportText: '1. Solo',
          idempotencyKey: randomUUID(),
          rosterReviews: [],
          waitlistReviews: [],
        })
        .expect(201);

      await request(server)
        .get(`/sessions/${(created.body as { code: string }).code}`)
        .set('Cookie', otherCookie)
        .expect(200);

      await prisma.session.deleteMany({ where: { groupId: freshCode } });
      await prisma.player.deleteMany({ where: { groupId: freshCode } });
      await prisma.group.deleteMany({ where: { code: freshCode } });
    });

    it('refuses to let a second claim take a group the first request already won', async () => {
      // The race two hosts hitting the same fresh code at once, closed by the
      // upsert in GroupsService.parse — see its comment. Sequential here
      // (concurrent requests do not reproduce the race through supertest, the
      // same limitation A2's regression test already documents) but the
      // outcome asserted is the one the atomic upsert guarantees regardless
      // of interleaving: exactly one claimant.
      const freshCode = randomUUID();
      await request(server)
        .post(`/groups/${freshCode}/parse`)
        .set('Cookie', otherCookie)
        .send({ groupName: 'First Claim', rawText: '1. Solo' })
        .expect(201);

      // A first host trying the same code after the second already claimed it
      // — refused with the same 404 an ownership mismatch always gets.
      const login = await request(server)
        .post('/auth/login')
        .send({ email, password: PASSWORD })
        .expect(201);
      const cookie = ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0];

      await request(server)
        .post(`/groups/${freshCode}/parse`)
        .set('Cookie', cookie)
        .send({ groupName: 'Second Claim', rawText: '1. Solo' })
        .expect(404);

      await prisma.player.deleteMany({ where: { groupId: freshCode } });
      await prisma.group.deleteMany({ where: { code: freshCode } });
    });
  });
});
