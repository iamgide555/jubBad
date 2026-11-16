import { randomUUID } from 'node:crypto';
import { INestApplication, ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { vi } from 'vitest';
import { AppModule } from '../app.module.js';
import { AuthBootstrapService } from '../auth/bootstrap.service.js';
import { SESSION_SECRET } from '../auth/auth.module.js';
import { MAX_ATTEMPTS } from '../auth/login-throttle.js';
import { LiffIdentity, type LiffUser } from '../line/liff-identity.js';
import { LineClient } from '../line/line-client.js';
import { LineHostService } from '../line/line-host.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from '../users/users.service.js';

const SECRET = 'line-signup-test-secret';
const PASSWORD = 'a genuinely correct password';
const HEADER = 'X-Line-Access-Token';

type Kit = Awaited<ReturnType<typeof boot>>;

async function boot() {
  const liff = { verify: vi.fn<(accessToken: string) => Promise<LiffUser | null>>() };
  const line = {
    friendStatus: vi.fn<(userId: string) => Promise<boolean | null>>(),
    unlinkRichMenu: vi.fn<(userId: string) => Promise<boolean>>(),
  };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SESSION_SECRET)
    .useValue(SECRET)
    .overrideProvider(AuthBootstrapService)
    .useValue({ onModuleInit: async () => {} })
    .overrideProvider(LiffIdentity)
    .useValue(liff)
    .overrideProvider(LineClient)
    .useValue(line)
    .compile();
  const app: INestApplication = moduleRef.createNestApplication();
  app.use(cookieParser(SECRET));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  const server = app.getHttpServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const prisma = app.get(PrismaService);
  const tokens = new Map<string, LiffUser>();
  const emails: string[] = [];
  const lineIds: string[] = [];

  liff.verify.mockImplementation(async (t) => tokens.get(t) ?? null);
  line.friendStatus.mockResolvedValue(true);
  line.unlinkRichMenu.mockResolvedValue(true);

  /** A LINE account whose access token verifies, as `[token, user]`. */
  function viewer(name = 'Somchai'): [string, LiffUser] {
    const user: LiffUser = { userId: `U${randomUUID().replace(/-/g, '')}`, displayName: name, pictureUrl: null };
    const token = `tok-${randomUUID()}`;
    tokens.set(token, user);
    lineIds.push(user.userId);
    return [token, user];
  }
  const newEmail = () => {
    const email = `ls-${randomUUID()}@example.test`;
    emails.push(email);
    return email;
  };
  const post = (path: string, token: string | undefined, body: unknown) => {
    const r = request(server).post(path);
    return (token === undefined ? r : r.set(HEADER, token)).send(body as object);
  };
  async function cleanup() {
    await prisma.trialRecord.deleteMany({ where: { lineUserId: { in: lineIds } } });
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
    await app.close();
  }
  return { app, server, prisma, liff, line, viewer, newEmail, post, cleanup };
}

describe('POST /auth/line/status', () => {
  let kit: Kit;
  beforeAll(async () => {
    kit = await boot();
  });
  afterAll(() => kit.cleanup());

  it('a new LINE account: not registered, trial available', async () => {
    const [token] = kit.viewer();
    const res = await kit.post('/auth/line/status', token, {}).expect(200);
    expect(res.body).toEqual({ lineDisplayName: 'Somchai', registered: false, trialAvailable: true });
  });

  it('a registered LINE account', async () => {
    const [token, line] = kit.viewer();
    await kit.post('/auth/line/signup', token, { email: kit.newEmail(), password: PASSWORD }).expect(201);
    const res = await kit.post('/auth/line/status', token, {}).expect(200);
    expect(res.body).toMatchObject({ registered: true, trialAvailable: false });
    expect(line.userId).toBeTruthy();
  });

  it('a LINE account whose trial is used and whose account is gone', async () => {
    const [token, line] = kit.viewer();
    await kit.prisma.trialRecord.create({ data: { lineUserId: line.userId, userId: null } });
    const res = await kit.post('/auth/line/status', token, {}).expect(200);
    expect(res.body).toMatchObject({ registered: false, trialAvailable: false });
  });

  it('401 without a token and with a token LINE refuses', async () => {
    const missing = await kit.post('/auth/line/status', undefined, {}).expect(401);
    await kit.post('/auth/line/status', 'not-a-real-token', {}).expect(401);
    expect(missing.body.code).toBeUndefined();
  });
});

describe('LINE not answering', () => {
  let kit: Kit;
  beforeAll(async () => {
    kit = await boot();
  });
  afterAll(() => kit.cleanup());

  it('503, and it is not counted against the caller', async () => {
    const [token] = kit.viewer();
    kit.liff.verify.mockRejectedValue(new ServiceUnavailableException());
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
      await kit.post('/auth/line/status', token, {}).expect(503);
    }
    kit.liff.verify.mockImplementation(async (t) => (t === token ? { userId: 'U1', displayName: 'A', pictureUrl: null } : null));
    await kit.post('/auth/line/status', token, {}).expect(200);
  });
});

describe('POST /auth/line/signup', () => {
  let kit: Kit;
  beforeAll(async () => {
    kit = await boot();
  });
  afterAll(() => kit.cleanup());

  it('creates a linked host on the trial and signs them in', async () => {
    const [token, line] = kit.viewer();
    const email = kit.newEmail();
    const res = await kit.post('/auth/line/signup', token, { email, password: PASSWORD }).expect(201);
    expect(res.body).toMatchObject({ authenticated: true, botFriend: true });
    expect(res.body.trialUntil).toEqual(expect.any(String));
    expect(String(res.headers['set-cookie']?.[0])).toContain('jubbad_session');
    const user = await kit.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user).toMatchObject({ role: 'host', plan: 'host', signupSource: 'line', lineUserId: line.userId });
    expect(user.planRenewsAt?.toISOString()).toBe(res.body.trialUntil);
    expect(user.lineLinkedAt).not.toBeNull();
  });

  it('a LINE account whose trial is used still gets an account, on free', async () => {
    const [token, line] = kit.viewer();
    await kit.prisma.trialRecord.create({ data: { lineUserId: line.userId, userId: null } });
    const email = kit.newEmail();
    const res = await kit.post('/auth/line/signup', token, { email, password: PASSWORD }).expect(201);
    expect(res.body.trialUntil).toBeNull();
    const user = await kit.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user).toMatchObject({ plan: 'free', planRenewsAt: null, lineUserId: line.userId });
  });

  it('refuses a LINE account that already has a JubBad account', async () => {
    const [token] = kit.viewer();
    await kit.post('/auth/line/signup', token, { email: kit.newEmail(), password: PASSWORD }).expect(201);
    const second = kit.newEmail();
    const res = await kit.post('/auth/line/signup', token, { email: second, password: PASSWORD }).expect(409);
    expect(res.body.code).toBe('LINE_ALREADY_REGISTERED');
    expect(await kit.prisma.user.count({ where: { email: second } })).toBe(0);
  });

  it('two sign-ups for one LINE account at once make exactly one account', async () => {
    const [token, line] = kit.viewer();
    const [a, b] = await Promise.all([
      kit.post('/auth/line/signup', token, { email: kit.newEmail(), password: PASSWORD }),
      kit.post('/auth/line/signup', token, { email: kit.newEmail(), password: PASSWORD }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await kit.prisma.user.count({ where: { lineUserId: line.userId } })).toBe(1);
  });

  it('refuses a taken email, whatever its casing, and leaves the LINE account free to use', async () => {
    const [firstToken] = kit.viewer();
    const email = kit.newEmail();
    await kit.post('/auth/line/signup', firstToken, { email, password: PASSWORD }).expect(201);
    const [token, line] = kit.viewer();
    const res = await kit.post('/auth/line/signup', token, { email: ` ${email.toUpperCase()} `, password: PASSWORD }).expect(409);
    expect(res.body.code).toBe('EMAIL_TAKEN');
    expect(await kit.prisma.user.count({ where: { lineUserId: line.userId } })).toBe(0);
    expect(await kit.prisma.trialRecord.findUnique({ where: { lineUserId: line.userId } })).toBeNull();
  });

  it('still succeeds when the friend check fails', async () => {
    const [token] = kit.viewer();
    kit.line.friendStatus.mockRejectedValueOnce(new Error('boom'));
    const res = await kit.post('/auth/line/signup', token, { email: kit.newEmail(), password: PASSWORD }).expect(201);
    expect(res.body.botFriend).toBeNull();
  });

  it('401 without a token', async () => {
    await kit.post('/auth/line/signup', undefined, { email: kit.newEmail(), password: PASSWORD }).expect(401);
  });
});

describe('POST /auth/line/link', () => {
  let kit: Kit;
  beforeAll(async () => {
    kit = await boot();
  });
  afterAll(() => kit.cleanup());

  /** A website account on the free plan, as `POST /auth/register` makes it. */
  async function webAccount() {
    const email = kit.newEmail();
    await request(kit.server).post('/auth/register').send({ email, password: PASSWORD }).expect(201);
    return email;
  }

  it('links a free website account and starts the trial, without signing in', async () => {
    const email = await webAccount();
    const [token, line] = kit.viewer();
    const res = await kit.post('/auth/line/link', token, { email, password: PASSWORD }).expect(200);
    expect(res.body).toEqual({ linked: true, trialUntil: expect.any(String) });
    expect(res.headers['set-cookie']).toBeUndefined();
    const user = await kit.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user).toMatchObject({ lineUserId: line.userId, plan: 'host' });
    expect(user.planRenewsAt?.toISOString()).toBe(res.body.trialUntil);
  });

  it('links a club account and leaves its plan alone', async () => {
    const email = kit.newEmail();
    await kit.app.get(UsersService).create(email, PASSWORD);
    const [token] = kit.viewer();
    const res = await kit.post('/auth/line/link', token, { email, password: PASSWORD }).expect(200);
    expect(res.body.trialUntil).toBeNull();
    const user = await kit.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user).toMatchObject({ plan: 'club', planRenewsAt: null });
    expect(user.lineUserId).not.toBeNull();
  });

  it('a wrong password is 401 and links nothing', async () => {
    const email = await webAccount();
    const [token] = kit.viewer();
    const res = await kit.post('/auth/line/link', token, { email, password: 'not the password' }).expect(401);
    expect(res.body.code).toBe('BAD_CREDENTIALS');
    expect((await kit.prisma.user.findUniqueOrThrow({ where: { email } })).lineUserId).toBeNull();
  });

  it('an account that already has a LINE link is refused', async () => {
    const email = await webAccount();
    const [first] = kit.viewer();
    await kit.post('/auth/line/link', first, { email, password: PASSWORD }).expect(200);
    const [second] = kit.viewer();
    const res = await kit.post('/auth/line/link', second, { email, password: PASSWORD }).expect(409);
    expect(res.body.code).toBe('ACCOUNT_ALREADY_LINKED');
  });

  it('a LINE account already on another account is refused', async () => {
    const [token] = kit.viewer();
    await kit.post('/auth/line/link', token, { email: await webAccount(), password: PASSWORD }).expect(200);
    const other = await webAccount();
    const res = await kit.post('/auth/line/link', token, { email: other, password: PASSWORD }).expect(409);
    expect(res.body.code).toBe('LINE_ALREADY_LINKED');
    expect((await kit.prisma.user.findUniqueOrThrow({ where: { email: other } })).lineUserId).toBeNull();
  });

  it('linking switches the roster switch on for every group the account owns, when the trial starts', async () => {
    const email = await webAccount();
    const user = await kit.prisma.user.findUniqueOrThrow({ where: { email } });
    const codes = [`ls-g-${randomUUID()}`, `ls-g-${randomUUID()}`];
    for (const code of codes) await kit.prisma.group.create({ data: { code, name: 'G', ownerId: user.id } });
    const [token] = kit.viewer();
    await kit.post('/auth/line/link', token, { email, password: PASSWORD }).expect(200);
    const rows = await kit.prisma.group.findMany({ where: { code: { in: codes } }, select: { lineDmEnabled: true } });
    expect(rows.map((r) => r.lineDmEnabled)).toEqual([true, true]);
    await kit.prisma.group.deleteMany({ where: { code: { in: codes } } });
  });

  it('linking a LINE account whose trial is used leaves a free account’s groups off', async () => {
    const email = await webAccount();
    const user = await kit.prisma.user.findUniqueOrThrow({ where: { email } });
    const code = `ls-g-${randomUUID()}`;
    await kit.prisma.group.create({ data: { code, name: 'G', ownerId: user.id } });
    const [token, line] = kit.viewer();
    await kit.prisma.trialRecord.create({ data: { lineUserId: line.userId, userId: null } });
    const res = await kit.post('/auth/line/link', token, { email, password: PASSWORD }).expect(200);
    expect(res.body.trialUntil).toBeNull();
    expect((await kit.prisma.group.findUniqueOrThrow({ where: { code } })).lineDmEnabled).toBe(false);
    await kit.prisma.group.deleteMany({ where: { code } });
  });

  it('unlink then link again earns no second trial', async () => {
    const email = await webAccount();
    const [token] = kit.viewer();
    await kit.post('/auth/line/link', token, { email, password: PASSWORD }).expect(200);
    const linked = await kit.prisma.user.findUniqueOrThrow({ where: { email } });
    await kit.app.get(LineHostService).unlink(linked.id);
    const res = await kit.post('/auth/line/link', token, { email, password: PASSWORD }).expect(200);
    expect(res.body.trialUntil).toBeNull();
    const again = await kit.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(again.planRenewsAt).toEqual(linked.planRenewsAt);
  });
});

describe('POST /auth/line/link throttle', () => {
  let kit: Kit;
  beforeAll(async () => {
    kit = await boot();
  });
  afterAll(() => kit.cleanup());

  it('refuses the email after MAX_ATTEMPTS wrong passwords', async () => {
    const email = kit.newEmail();
    await request(kit.server).post('/auth/register').send({ email, password: PASSWORD }).expect(201);
    const [token] = kit.viewer();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await kit.post('/auth/line/link', token, { email, password: 'wrong password' }).expect(401);
    }
    await kit.post('/auth/line/link', token, { email, password: PASSWORD }).expect(429);
  });
});

describe('the guest menu goes away once an account has the LINE link', () => {
  let kit: Kit;
  const saved = process.env.LINE_GUEST_RICHMENU_ID;
  beforeAll(async () => {
    kit = await boot();
  });
  beforeEach(() => {
    process.env.LINE_GUEST_RICHMENU_ID = 'RM1';
    kit.line.unlinkRichMenu.mockClear().mockResolvedValue(true);
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.LINE_GUEST_RICHMENU_ID;
    else process.env.LINE_GUEST_RICHMENU_ID = saved;
    await kit.cleanup();
  });

  it('after a LINE sign-up', async () => {
    const [token, line] = kit.viewer();
    await kit.post('/auth/line/signup', token, { email: kit.newEmail(), password: PASSWORD }).expect(201);
    expect(kit.line.unlinkRichMenu).toHaveBeenCalledExactlyOnceWith(line.userId);
  });

  it('after linking an existing account', async () => {
    const email = kit.newEmail();
    await request(kit.server).post('/auth/register').send({ email, password: PASSWORD }).expect(201);
    const [token, line] = kit.viewer();
    await kit.post('/auth/line/link', token, { email, password: PASSWORD }).expect(200);
    expect(kit.line.unlinkRichMenu).toHaveBeenCalledExactlyOnceWith(line.userId);
  });

  it('not after a refused sign-up or link', async () => {
    const [token] = kit.viewer();
    await kit.post('/auth/line/link', token, { email: kit.newEmail(), password: 'not the password' }).expect(401);
    expect(kit.line.unlinkRichMenu).not.toHaveBeenCalled();
  });

  it('and a menu failure never fails the sign-up', async () => {
    const [token] = kit.viewer();
    kit.line.unlinkRichMenu.mockRejectedValue(new Error('LINE is down'));
    await kit.post('/auth/line/signup', token, { email: kit.newEmail(), password: PASSWORD }).expect(201);
  });
});

describe('throttles on the LINE routes: signup probing', () => {
  let kit: Kit;
  beforeAll(async () => {
    kit = await boot();
  });
  afterAll(() => kit.cleanup());

  it('/auth/line/signup counts every attempt per address, so one LINE account cannot probe emails', async () => {
    const [token] = kit.viewer();
    const taken = kit.newEmail();
    await request(kit.server).post('/auth/register').send({ email: taken, password: PASSWORD }).expect(201);
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await kit.post('/auth/line/signup', token, { email: taken, password: PASSWORD }).expect(409);
    }
    await kit.post('/auth/line/signup', token, { email: kit.newEmail(), password: PASSWORD }).expect(429);
  });
});

describe('throttles on the LINE routes: link failures reach login', () => {
  let kit: Kit;
  beforeAll(async () => {
    kit = await boot();
  });
  afterAll(() => kit.cleanup());

  it('wrong passwords at /auth/line/link lock /auth/login for that email (one shared counter)', async () => {
    const email = kit.newEmail();
    await request(kit.server).post('/auth/register').send({ email, password: PASSWORD }).expect(201);
    const [token] = kit.viewer();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await kit.post('/auth/line/link', token, { email, password: 'wrong password' }).expect(401);
    }
    await request(kit.server).post('/auth/login').send({ email, password: PASSWORD }).expect(429);
  });
});

describe('throttles on the LINE routes: login failures reach link', () => {
  let kit: Kit;
  beforeAll(async () => {
    kit = await boot();
  });
  afterAll(() => kit.cleanup());

  it('and wrong passwords at /auth/login lock /auth/line/link for that email', async () => {
    const email = kit.newEmail();
    await request(kit.server).post('/auth/register').send({ email, password: PASSWORD }).expect(201);
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await request(kit.server).post('/auth/login').send({ email, password: 'wrong password' }).expect(401);
    }
    const [token] = kit.viewer();
    await kit.post('/auth/line/link', token, { email, password: PASSWORD }).expect(429);
  });
});
