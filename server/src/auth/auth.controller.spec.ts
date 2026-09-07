import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AuthModule } from './auth.module.js';
import { ADMIN_TOKEN, ADMIN_COOKIE } from './admin.guard.js';
import { MAX_ATTEMPTS } from './login-throttle.js';

const TOKEN = 'test-admin-token';

describe('AuthController', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AuthModule] })
      .overrideProvider(ADMIN_TOKEN)
      .useValue(TOKEN)
      .compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    server = app.getHttpServer();
  });

  afterEach(async () => {
    await app.close();
  });

  const cookieOf = (res: request.Response): string =>
    ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0] ?? '';

  it('accepts the right token and sets the admin cookie', async () => {
    const res = await request(server).post('/auth/login').send({ token: TOKEN }).expect(201);
    expect(res.body).toEqual({ authenticated: true });
    expect(cookieOf(res)).toContain(`${ADMIN_COOKIE}=`);
  });

  it('sets the cookie so client script cannot read it and cross-site posts do not carry it', async () => {
    const res = await request(server).post('/auth/login').send({ token: TOKEN });
    const cookie = cookieOf(res);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
  });

  it('rejects a wrong token without setting anything', async () => {
    const res = await request(server).post('/auth/login').send({ token: 'nope' }).expect(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects a request with no token at all', async () => {
    await request(server).post('/auth/login').send({}).expect(400);
  });

  it('reports an unauthenticated caller as such rather than refusing them', async () => {
    // The client guard calls this before it has anything, so it must answer
    // rather than 401 — otherwise "not logged in" is indistinguishable from
    // "the server is broken".
    const res = await request(server).get('/auth/me').expect(200);
    expect(res.body).toEqual({ authenticated: false });
  });

  it('reports an authenticated caller once they hold the cookie', async () => {
    const login = await request(server).post('/auth/login').send({ token: TOKEN });
    const res = await request(server)
      .get('/auth/me')
      .set('Cookie', cookieOf(login))
      .expect(200);
    expect(res.body).toEqual({ authenticated: true });
  });

  it('clears the cookie on logout', async () => {
    const res = await request(server).post('/auth/logout').expect(201);
    // Express clears by re-sending the cookie with an expiry in the past.
    expect(cookieOf(res)).toMatch(new RegExp(`${ADMIN_COOKIE}=;`));
  });

  it('stops answering guesses from one address after repeated failures', async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await request(server).post('/auth/login').send({ token: `guess-${i}` }).expect(401);
    }
    await request(server).post('/auth/login').send({ token: 'guess-again' }).expect(429);
  });

  it('does not let the throttle lock out the real token', async () => {
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      await request(server).post('/auth/login').send({ token: 'wrong' }).expect(401);
    }
    await request(server).post('/auth/login').send({ token: TOKEN }).expect(201);
    // A success clears the record, so the next wrong guess starts from zero.
    await request(server).post('/auth/login').send({ token: 'wrong' }).expect(401);
  });
});
