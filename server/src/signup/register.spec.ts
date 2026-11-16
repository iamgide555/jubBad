import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AuthModule, SESSION_SECRET } from '../auth/auth.module.js';
import { AuthBootstrapService } from '../auth/bootstrap.service.js';
import { MAX_ATTEMPTS } from '../auth/login-throttle.js';
import { SESSION_COOKIE } from '../auth/session.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from '../users/users.service.js';
import { SignupModule } from './signup.module.js';

const SECRET = 'register-test-secret';
const PASSWORD = 'a genuinely correct password';
const ENV_KEYS = ['LINE_LIFF_ID', 'LINE_LOGIN_CHANNEL_ID', 'LINE_BOT_ADD_URL'] as const;

describe('website sign-up', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  const emails: string[] = [];
  const saved: Record<string, string | undefined> = {};

  const newEmail = () => {
    const email = `reg-${randomUUID()}@example.test`;
    emails.push(email);
    return email;
  };

  beforeEach(async () => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, AuthModule, SignupModule] })
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
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
    emails.length = 0;
    await app.close();
  });

  it('creates a free host, signs them in, and leaves no LINE link', async () => {
    const email = newEmail();
    const res = await request(server).post('/auth/register').send({ email, password: PASSWORD }).expect(201);
    expect(res.body).toEqual({ authenticated: true });
    expect(String(res.headers['set-cookie']?.[0])).toContain(SESSION_COOKIE);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user).toMatchObject({ role: 'host', plan: 'free', planRenewsAt: null, signupSource: 'web', lineUserId: null });
  });

  it('the cookie it sets signs in', async () => {
    const email = newEmail();
    const res = await request(server).post('/auth/register').send({ email, password: PASSWORD }).expect(201);
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0];
    const me = await request(server).get('/auth/me').set('Cookie', cookie).expect(200);
    expect(me.body).toEqual({ authenticated: true, role: 'host', email });
  });

  it('refuses a taken email, whatever its casing or spacing', async () => {
    const email = newEmail();
    await request(server).post('/auth/register').send({ email, password: PASSWORD }).expect(201);
    const again = await request(server)
      .post('/auth/register')
      .send({ email: `  ${email.toUpperCase()} `, password: PASSWORD })
      .expect(409);
    expect(again.body.code).toBe('EMAIL_TAKEN');
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it('refuses a short password and a malformed email', async () => {
    const email = newEmail();
    await request(server).post('/auth/register').send({ email, password: 'short' }).expect(400);
    await request(server).post('/auth/register').send({ email: 'not-an-email', password: PASSWORD }).expect(400);
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it('a filled trap field looks like success and creates nothing', async () => {
    const email = newEmail();
    const res = await request(server)
      .post('/auth/register')
      .send({ email, password: PASSWORD, website: 'http://spam' })
      .expect(201);
    expect(res.body).toEqual({ authenticated: true });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it('refuses the address after MAX_ATTEMPTS registrations in the window', async () => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await request(server).post('/auth/register').send({ email: newEmail(), password: PASSWORD }).expect(201);
    }
    await request(server).post('/auth/register').send({ email: newEmail(), password: PASSWORD }).expect(429);
  });

  it('an admin-created user still gets the club default', async () => {
    const email = newEmail();
    await app.get(UsersService).create(email, PASSWORD);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user).toMatchObject({ plan: 'club', signupSource: 'admin' });
  });

  it('signup-info reports the LIFF sign-up link when LINE is configured, nulls when not', async () => {
    process.env.LINE_LIFF_ID = 'L1';
    process.env.LINE_LOGIN_CHANNEL_ID = '999';
    process.env.LINE_BOT_ADD_URL = 'https://lin.ee/x';
    const on = await request(server).get('/auth/signup-info').expect(200);
    expect(on.body).toEqual({ liffId: 'L1', lineSignupUrl: 'https://liff.line.me/L1/signup', botAddUrl: 'https://lin.ee/x' });

    delete process.env.LINE_LIFF_ID;
    delete process.env.LINE_BOT_ADD_URL;
    const off = await request(server).get('/auth/signup-info').expect(200);
    expect(off.body).toEqual({ liffId: null, lineSignupUrl: null, botAddUrl: null });
  });
});
