import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../app.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ADMIN_TOKEN } from './admin.guard.js';

const TOKEN = 'boundary-test-token';

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
] as const;

interface Ctx {
  groupCode: string;
  sessionCode: string;
  playerId: string;
}

describe('auth boundary', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let ctx: Ctx;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ADMIN_TOKEN)
      .useValue(TOKEN)
      .compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    prisma = app.get(PrismaService);

    const groupCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'Boundary' } });
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

    // Walk the router Express actually built, rather than a list kept by hand.
    const router = server._events.request._router ?? server._events.request.router;
    const declared: { method: string; path: string }[] = [];
    for (const layer of router.stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        declared.push({ method, path: layer.route.path });
      }
    }
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
    const login = await request(server).post('/auth/login').send({ token: TOKEN }).expect(201);
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
});
