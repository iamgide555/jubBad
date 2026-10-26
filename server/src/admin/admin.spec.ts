import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../app.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SESSION_SECRET } from '../auth/auth.module.js';
import { AuthBootstrapService } from '../auth/bootstrap.service.js';
import { UsersService } from '../users/users.service.js';

const SECRET = 'admin-test-secret';
const PASSWORD = 'a genuinely correct password';

describe('admin module', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let adminCookie: string;
  let hostCookie: string;
  let adminId: string;
  let hostId: string;

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

    const users = app.get(UsersService);
    const adminEmail = `admin-${randomUUID()}@example.test`;
    const hostEmail = `host-${randomUUID()}@example.test`;
    const admin = await users.create(adminEmail, PASSWORD, 'admin');
    const host = await users.create(hostEmail, PASSWORD, 'host');
    adminId = admin.id;
    hostId = host.id;

    const adminLogin = await request(server)
      .post('/auth/login')
      .send({ email: adminEmail, password: PASSWORD })
      .expect(201);
    adminCookie = ([] as string[]).concat(adminLogin.headers['set-cookie'] ?? [])[0];

    const hostLogin = await request(server)
      .post('/auth/login')
      .send({ email: hostEmail, password: PASSWORD })
      .expect(201);
    hostCookie = ([] as string[]).concat(hostLogin.headers['set-cookie'] ?? [])[0];
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [adminId, hostId] } } });
    await app.close();
  });

  /**
   * Every /admin route, exhaustively — the load-bearing property this test
   * exists for. A route added to AdminController later and left unchecked
   * here still fails, because a plain host reaching it at all is the bug,
   * regardless of what it does.
   */
  const ADMIN_ROUTES: { method: 'get' | 'post' | 'put' | 'delete'; path: string }[] = [
    { method: 'get', path: '/admin/users' },
    { method: 'post', path: '/admin/users' },
    { method: 'put', path: '/admin/users/some-id' },
    { method: 'post', path: '/admin/users/some-id/disabled' },
    { method: 'put', path: '/admin/users/some-id/plan' },
    { method: 'delete', path: '/admin/users/some-id' },
    { method: 'post', path: '/admin/users/some-id/reset' },
    { method: 'get', path: '/admin/groups' },
    { method: 'post', path: '/admin/groups/some-code/owner' },
    { method: 'get', path: '/admin/reset-requests' },
    { method: 'post', path: '/admin/reset-requests/some-id/handle' },
  ];

  it('refuses a plain host on every /admin route', async () => {
    const leaked: string[] = [];
    for (const { method, path } of ADMIN_ROUTES) {
      const res = await request(server)[method](path).set('Cookie', hostCookie).send({});
      if (res.status !== 404) leaked.push(`${method.toUpperCase()} ${path} -> ${res.status}`);
    }
    expect(leaked, `admin routes answered a host caller: ${leaked.join(' | ')}`).toEqual([]);
  });

  it('refuses an anonymous caller on every /admin route with 401, not 404', async () => {
    // Distinguished from the host case: 401 says "log in"; 404 (what a signed-
    // in non-admin gets) must never leak to someone who is not even signed in,
    // since a 404-vs-401 split would itself reveal that the route exists.
    for (const { method, path } of ADMIN_ROUTES) {
      const res = await request(server)[method](path).send({});
      expect(res.status).toBe(401);
    }
  });

  it('admits an admin to the read-only routes', async () => {
    await request(server).get('/admin/users').set('Cookie', adminCookie).expect(200);
    await request(server).get('/admin/groups').set('Cookie', adminCookie).expect(200);
    await request(server).get('/admin/reset-requests').set('Cookie', adminCookie).expect(200);
  });

  it('lists a user with the groups they own', async () => {
    const groupCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'Owned', ownerId: hostId } });
    try {
      const res = await request(server).get('/admin/users').set('Cookie', adminCookie).expect(200);
      const row = (res.body as { id: string; ownedGroups: { code: string }[] }[]).find(
        (u) => u.id === hostId
      );
      expect(row?.ownedGroups.map((g) => g.code)).toContain(groupCode);
    } finally {
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it("lists the admin's own groups first, then other hosts' (by owner), ownerless last", async () => {
    const mine = randomUUID();
    const theirs = randomUUID();
    const orphan = randomUUID();
    // Created oldest-first for the admin's group so plain newest-first order
    // would put it last; the ordering under test has to override that.
    await prisma.group.create({ data: { code: mine, name: 'Mine', ownerId: adminId, createdAt: new Date('2026-01-01') } });
    await prisma.group.create({ data: { code: theirs, name: 'Theirs', ownerId: hostId, createdAt: new Date('2026-06-01') } });
    await prisma.group.create({ data: { code: orphan, name: 'Orphan', ownerId: null, createdAt: new Date('2026-07-01') } });
    try {
      const res = await request(server).get('/admin/groups').set('Cookie', adminCookie).expect(200);
      const rows = res.body as { code: string; mine: boolean }[];
      const order = rows.map((g) => g.code).filter((c) => [mine, theirs, orphan].includes(c));
      expect(order).toEqual([mine, theirs, orphan]);
      expect(rows.find((g) => g.code === mine)?.mine).toBe(true);
      expect(rows.find((g) => g.code === theirs)?.mine).toBe(false);
    } finally {
      await prisma.group.deleteMany({ where: { code: { in: [mine, theirs, orphan] } } });
    }
  });

  it('creates, edits and disables a user end to end', async () => {
    const email = `created-${randomUUID()}@example.test`;
    const created = await request(server)
      .post('/admin/users')
      .set('Cookie', adminCookie)
      .send({ email, password: 'a perfectly fine password' })
      .expect(201);
    const id = (created.body as { id: string }).id;

    try {
      const renamed = `renamed-${randomUUID()}@example.test`;
      await request(server)
        .put(`/admin/users/${id}`)
        .set('Cookie', adminCookie)
        .send({ email: renamed })
        .expect(200);

      // The session issued under the old tokenVersion still works — nothing
      // about a rename should sign anyone out.
      const login = await request(server)
        .post('/auth/login')
        .send({ email: renamed, password: 'a perfectly fine password' })
        .expect(201);
      const cookie = ([] as string[]).concat(login.headers['set-cookie'] ?? [])[0];

      await request(server)
        .post(`/admin/users/${id}/disabled`)
        .set('Cookie', adminCookie)
        .send({ disabled: true })
        .expect(201);

      // Disabling bumps tokenVersion — the cookie from before is dead now,
      // not just unable to log in again.
      await request(server).get('/auth/me').set('Cookie', cookie).expect(200, {
        authenticated: false,
      });
    } finally {
      await prisma.user.deleteMany({ where: { id } });
    }
  });

  it('refuses a duplicate email with 409', async () => {
    const email = `dup-${randomUUID()}@example.test`;
    await request(server)
      .post('/admin/users')
      .set('Cookie', adminCookie)
      .send({ email, password: 'first password here' })
      .expect(201);
    try {
      await request(server)
        .post('/admin/users')
        .set('Cookie', adminCookie)
        .send({ email, password: 'second password here' })
        .expect(409);
    } finally {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) await prisma.user.deleteMany({ where: { id: existing.id } });
    }
  });

  it('mints a reset token that /auth/reset/:token actually accepts', async () => {
    const email = `reset-target-${randomUUID()}@example.test`;
    const created = await request(server)
      .post('/admin/users')
      .set('Cookie', adminCookie)
      .send({ email, password: 'the original password' })
      .expect(201);
    const id = (created.body as { id: string }).id;

    try {
      const minted = await request(server)
        .post(`/admin/users/${id}/reset`)
        .set('Cookie', adminCookie)
        .expect(201);
      const token = (minted.body as { token: string }).token;

      await request(server)
        .post(`/auth/reset/${token}`)
        .send({ password: 'a brand new password' })
        .expect(201);

      await request(server)
        .post('/auth/login')
        .send({ email, password: 'a brand new password' })
        .expect(201);
    } finally {
      await prisma.user.deleteMany({ where: { id } });
    }
  });

  it('reassigns a group to another user', async () => {
    const groupCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'To Reassign', ownerId: hostId } });
    try {
      await request(server)
        .post(`/admin/groups/${groupCode}/owner`)
        .set('Cookie', adminCookie)
        .send({ toUserId: adminId })
        .expect(201);

      const group = await prisma.group.findUniqueOrThrow({ where: { code: groupCode } });
      expect(group.ownerId).toBe(adminId);
    } finally {
      await prisma.group.deleteMany({ where: { code: groupCode } });
    }
  });

  it('lists and handles a forgot-password request', async () => {
    const email = `pending-${randomUUID()}@example.test`;
    await request(server).post('/auth/forgot').send({ email }).expect(201);

    const listed = await request(server)
      .get('/admin/reset-requests')
      .set('Cookie', adminCookie)
      .expect(200);
    const row = (listed.body as { id: string; email: string }[]).find((r) => r.email === email);
    expect(row).toBeDefined();

    await request(server)
      .post(`/admin/reset-requests/${row!.id}/handle`)
      .set('Cookie', adminCookie)
      .expect(201);

    const afterHandling = await request(server)
      .get('/admin/reset-requests')
      .set('Cookie', adminCookie)
      .expect(200);
    expect((afterHandling.body as { id: string }[]).map((r) => r.id)).not.toContain(row!.id);

    await prisma.passwordResetRequest.deleteMany({ where: { email } });
  });

  describe('PUT /admin/users/:id/plan', () => {
    const put = (id: string, body: object) =>
      request(server).put(`/admin/users/${id}/plan`).set('Cookie', adminCookie).send(body);

    it('sets free with no renewal date and reports the effective plan', async () => {
      const res = await put(hostId, { plan: 'free', renewsAt: null }).expect(200);
      expect(res.body).toEqual({
        id: hostId,
        plan: 'free',
        planRenewsAt: null,
        effectivePlan: 'free',
        groupLimit: 1,
      });
    });

    it('stores a renewal date as the end of that day in Bangkok', async () => {
      const res = await put(hostId, { plan: 'host', renewsAt: '2026-11-19' }).expect(200);
      expect((res.body as { planRenewsAt: string }).planRenewsAt).toBe('2026-11-19T16:59:59.999Z');
      const row = await prisma.user.findUniqueOrThrow({ where: { id: hostId } });
      expect(row.planRenewsAt?.toISOString()).toBe('2026-11-19T16:59:59.999Z');
    });

    it('clears the renewal date when renewsAt is null', async () => {
      await put(hostId, { plan: 'host', renewsAt: '2026-11-19' }).expect(200);
      const res = await put(hostId, { plan: 'club', renewsAt: null }).expect(200);
      expect((res.body as { planRenewsAt: null }).planRenewsAt).toBeNull();
    });

    it('refuses an unknown plan with 400', async () => {
      await put(hostId, { plan: 'gold', renewsAt: null }).expect(400);
    });

    it('refuses a malformed or impossible renewal date with 400', async () => {
      await put(hostId, { plan: 'host', renewsAt: '19/11/2026' }).expect(400);
      await put(hostId, { plan: 'host', renewsAt: '2026-02-31' }).expect(400);
      await put(hostId, { plan: 'host' }).expect(400);
    });

    it('answers 404 for an unknown user', async () => {
      await put(randomUUID(), { plan: 'host', renewsAt: null }).expect(404);
    });

    it('refuses a plain host with 404', async () => {
      await request(server)
        .put(`/admin/users/${hostId}/plan`)
        .set('Cookie', hostCookie)
        .send({ plan: 'club', renewsAt: null })
        .expect(404);
    });

    it('lists a lapsed paid plan as plan host, effectivePlan free', async () => {
      await put(hostId, { plan: 'host', renewsAt: '2020-01-01' }).expect(200);
      const res = await request(server).get('/admin/users').set('Cookie', adminCookie).expect(200);
      const row = (res.body as { id: string; plan: string; planRenewsAt: string; effectivePlan: string }[]).find(
        (u) => u.id === hostId
      );
      expect(row).toMatchObject({
        plan: 'host',
        planRenewsAt: '2020-01-01T16:59:59.999Z',
        effectivePlan: 'free',
        groupLimit: 1,
      });
    });

    it('lists the group cap of the plan in force, and null for an admin', async () => {
      await put(hostId, { plan: 'host', renewsAt: null }).expect(200);
      const res = await request(server).get('/admin/users').set('Cookie', adminCookie).expect(200);
      const rows = res.body as { id: string; role: string; groupLimit: number | null }[];
      expect(rows.find((u) => u.id === hostId)?.groupLimit).toBe(3);
      expect(rows.find((u) => u.role === 'admin')?.groupLimit).toBeNull();
    });
  });
});
