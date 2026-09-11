import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AuthModule, SESSION_SECRET } from './auth.module.js';
import { AuthBootstrapService } from './bootstrap.service.js';
import { SESSION_COOKIE } from './session.js';
import { MAX_ATTEMPTS } from './login-throttle.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from '../users/users.service.js';

const SECRET = 'test-session-secret';
const PASSWORD = 'a genuinely correct password';

describe('AuthController', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let email: string;
  let userId: string;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, AuthModule] })
      .overrideProvider(SESSION_SECRET)
      .useValue(SECRET)
      // This file seeds its own users directly; it must not depend on
      // ADMIN_EMAIL / ADMIN_PASSWORD being set in the environment the test
      // happens to run in (there is no server/.env in a fresh clone or CI).
      .overrideProvider(AuthBootstrapService)
      .useValue({ onModuleInit: async () => {} })
      .compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser(SECRET));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    server = app.getHttpServer();
    // supertest calls listen() itself for every request when the server is
    // not already listening; under enough requests in one test (the throttle
    // tests send close to MAX_ATTEMPTS) that churn intermittently produces a
    // "socket hang up" or a bogus 501 that reads like an application failure
    // — the same cause A13 documents for the other controller specs.
    await new Promise<void>((resolve) => server.listen(0, resolve));

    prisma = app.get(PrismaService);
    email = `test-${randomUUID()}@example.test`;
    const user = await app.get(UsersService).create(email, PASSWORD);
    userId = user.id;
  });

  afterEach(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
    await app.close();
  });

  const cookieOf = (res: request.Response): string =>
    ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0] ?? '';

  it('accepts the right credentials and sets the session cookie', async () => {
    const res = await request(server)
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(201);
    expect(res.body).toEqual({ authenticated: true });
    expect(cookieOf(res)).toContain(`${SESSION_COOKIE}=`);
  });

  it('matches the email case-insensitively', async () => {
    await request(server)
      .post('/auth/login')
      .send({ email: email.toUpperCase(), password: PASSWORD })
      .expect(201);
  });

  it('sets the cookie so client script cannot read it and cross-site posts do not carry it', async () => {
    const res = await request(server).post('/auth/login').send({ email, password: PASSWORD });
    const cookie = cookieOf(res);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
  });

  it('rejects a wrong password without setting anything', async () => {
    const res = await request(server)
      .post('/auth/login')
      .send({ email, password: 'nope' })
      .expect(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects an email with no account, with the same message as a wrong password', async () => {
    const unknown = await request(server)
      .post('/auth/login')
      .send({ email: `nobody-${randomUUID()}@example.test`, password: 'anything' })
      .expect(401);
    const wrong = await request(server)
      .post('/auth/login')
      .send({ email, password: 'wrong' })
      .expect(401);
    expect(unknown.body.message).toBe(wrong.body.message);
  });

  it('rejects a request missing email or password', async () => {
    await request(server).post('/auth/login').send({}).expect(400);
    await request(server).post('/auth/login').send({ email }).expect(400);
    await request(server).post('/auth/login').send({ password: PASSWORD }).expect(400);
  });

  it('reports an unauthenticated caller as such rather than refusing them', async () => {
    // The client guard calls this before it has anything, so it must answer
    // rather than 401 — otherwise "not logged in" is indistinguishable from
    // "the server is broken".
    const res = await request(server).get('/auth/me').expect(200);
    expect(res.body).toEqual({ authenticated: false });
  });

  it('reports an authenticated caller once they hold the cookie', async () => {
    const login = await request(server).post('/auth/login').send({ email, password: PASSWORD });
    const res = await request(server)
      .get('/auth/me')
      .set('Cookie', cookieOf(login))
      .expect(200);
    expect(res.body).toEqual({ authenticated: true, role: 'host', email: email.toLowerCase() });
  });

  it('clears the cookie on logout', async () => {
    const res = await request(server).post('/auth/logout').expect(201);
    // Express clears by re-sending the cookie with an expiry in the past. The
    // value itself is not `;` empty here — clearCookie signs an empty payload
    // because cookieOptions() sets signed: true — but the browser deletes on
    // the expiry regardless of what the value is.
    expect(cookieOf(res)).toContain(`${SESSION_COOKIE}=`);
    expect(cookieOf(res)).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('stops answering guesses against one account after repeated failures', async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await request(server).post('/auth/login').send({ email, password: `guess-${i}` }).expect(401);
    }
    await request(server).post('/auth/login').send({ email, password: 'guess-again' }).expect(429);
  });

  it('does not let the throttle lock out the real credentials', async () => {
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      await request(server).post('/auth/login').send({ email, password: 'wrong' }).expect(401);
    }
    await request(server).post('/auth/login').send({ email, password: PASSWORD }).expect(201);
    // A success clears the record, so the next wrong guess starts from zero.
    await request(server).post('/auth/login').send({ email, password: 'wrong' }).expect(401);
  });
});
