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

const SECRET = 'pay-account-test-secret';
const PASSWORD = 'a genuinely correct password';
const ACCOUNT = { bank: 'กสิกร', number: '123-4-56789-0', name: 'สมชาย ใจดี' };

describe('group pay-account routes', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let ownerId: string;
  let otherId: string;
  let ownerCookie: string;
  let otherCookie: string;
  let code: string;
  let shareToken: string;

  const login = async (email: string) => {
    const res = await request(server).post('/auth/login').send({ email, password: PASSWORD }).expect(201);
    return ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0];
  };
  const put = (body: object, cookie = ownerCookie) =>
    request(server).put(`/groups/${code}/pay-account`).set('Cookie', cookie).send(body);
  const get = (cookie = ownerCookie) => request(server).get(`/groups/${code}/pay-account`).set('Cookie', cookie);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SESSION_SECRET)
      .useValue(SECRET)
      .overrideProvider(AuthBootstrapService)
      .useValue({ onModuleInit: async () => {} })
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.use(cookieParser(SECRET));
    // The same global pipe as main.ts: a DTO field with no validator decorator is silently stripped by it.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    prisma = app.get(PrismaService);

    const users = app.get(UsersService);
    const ownerEmail = `pay-owner-${randomUUID()}@example.test`;
    const otherEmail = `pay-other-${randomUUID()}@example.test`;
    ownerId = (await users.create(ownerEmail, PASSWORD)).id;
    otherId = (await users.create(otherEmail, PASSWORD)).id;
    ownerCookie = await login(ownerEmail);
    otherCookie = await login(otherEmail);

    code = randomUUID();
    shareToken = randomUUID().replace(/-/g, '').slice(0, 22);
    await prisma.group.create({ data: { code, name: 'Pay', ownerId, shareToken } });
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { groupId: code } });
    await prisma.group.deleteMany({ where: { code } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
    await app.close();
  });

  beforeEach(async () => {
    await prisma.group.update({ where: { code }, data: { payAccount: null } });
  });

  it('reads no account for a fresh group', async () => {
    expect((await get().expect(200)).body).toEqual({ account: null });
  });

  it('stores all three fields of a real PUT body through the global pipe, and reads them back', async () => {
    expect((await put(ACCOUNT).expect(200)).body).toEqual({ account: ACCOUNT });
    expect((await get().expect(200)).body).toEqual({ account: ACCOUNT });
    const stored = await prisma.group.findUniqueOrThrow({ where: { code }, select: { payAccount: true } });
    expect(JSON.parse(stored.payAccount as string)).toEqual(ACCOUNT);
  });

  it('trims the stored values', async () => {
    const res = await put({ bank: ' กสิกร ', number: ' 123-4-56789-0 ', name: ' สมชาย ใจดี ' }).expect(200);
    expect(res.body).toEqual({ account: ACCOUNT });
  });

  it('clears on an all-blank or empty body', async () => {
    await put(ACCOUNT).expect(200);
    expect((await put({ bank: ' ', number: '', name: '' }).expect(200)).body).toEqual({ account: null });
    expect((await get().expect(200)).body).toEqual({ account: null });
    await put(ACCOUNT).expect(200);
    expect((await put({}).expect(200)).body).toEqual({ account: null });
    expect((await prisma.group.findUniqueOrThrow({ where: { code } })).payAccount).toBeNull();
  });

  it('refuses a partial or invalid account with PAY_ACCOUNT_INVALID and keeps the old one', async () => {
    await put(ACCOUNT).expect(200);
    const bad = [
      { bank: 'กสิกร' },
      { bank: 'กสิกร', number: '123456' },
      { bank: 'กสิกร', number: '12', name: 'x' },
      { bank: 'กสิกร', number: '------', name: 'x' },
      { bank: 'กสิกร', number: 'abcdefgh', name: 'x' },
      { bank: 'ก'.repeat(41), number: '123456', name: 'x' },
      { bank: 'กสิกร', number: '123456', name: 'ส'.repeat(81) },
    ];
    for (const body of bad) {
      const res = await put(body).expect(400);
      expect(res.body.code, JSON.stringify(body)).toBe('PAY_ACCOUNT_INVALID');
    }
    expect((await get().expect(200)).body).toEqual({ account: ACCOUNT });
  });

  it('refuses non-string fields with a generic 400 and keeps the old account', async () => {
    await put(ACCOUNT).expect(200);
    const res = await put({ bank: 5, number: '123456', name: 'x' }).expect(400);
    expect(res.body.code).toBeUndefined();
    expect((await get().expect(200)).body).toEqual({ account: ACCOUNT });
  });

  it('refuses a string over the DTO cap with a 400 and keeps the old account', async () => {
    await put(ACCOUNT).expect(200);
    await put({ ...ACCOUNT, name: 'ส'.repeat(201) }).expect(400);
    await put({ ...ACCOUNT, number: '1'.repeat(201) }).expect(400);
    expect((await get().expect(200)).body).toEqual({ account: ACCOUNT });
  });

  it('reads null like a blank field: all null clears, null beside a filled field is partial', async () => {
    await put(ACCOUNT).expect(200);
    const partial = await put({ bank: 'กสิกร', number: null, name: null }).expect(400);
    expect(partial.body.code).toBe('PAY_ACCOUNT_INVALID');
    expect((await get().expect(200)).body).toEqual({ account: ACCOUNT });
    expect((await put({ bank: null, number: null, name: null }).expect(200)).body).toEqual({ account: null });
    expect((await get().expect(200)).body).toEqual({ account: null });
  });

  describe('no plan gate: a free or lapsed owner can still set, read and clear', () => {
    const asPlan = async (data: { plan: string; planRenewsAt: Date | null }) => {
      await prisma.user.update({ where: { id: ownerId }, data });
    };
    const walk = async () => {
      expect((await put(ACCOUNT).expect(200)).body).toEqual({ account: ACCOUNT });
      expect((await get().expect(200)).body).toEqual({ account: ACCOUNT });
      expect((await put({}).expect(200)).body).toEqual({ account: null });
      expect((await get().expect(200)).body).toEqual({ account: null });
    };
    // The default owner plan is club, which would pass any gate; these two are the owners a gate would refuse.
    afterEach(async () => {
      await asPlan({ plan: 'club', planRenewsAt: null });
    });

    it('free owner with no LINE link', async () => {
      await asPlan({ plan: 'free', planRenewsAt: null });
      expect((await prisma.group.findUniqueOrThrow({ where: { code } })).lineGroupId).toBeNull();
      await walk();
    });

    it('lapsed paid owner (renewal date in the past)', async () => {
      await asPlan({ plan: 'host', planRenewsAt: new Date(Date.now() - 24 * 60 * 60 * 1000) });
      await walk();
    });
  });

  it('answers 404 to a different host on both verbs and does not change the account', async () => {
    await put(ACCOUNT).expect(200);
    await get(otherCookie).expect(404);
    await put({ bank: 'x', number: '999999', name: 'y' }, otherCookie).expect(404);
    await put({}, otherCookie).expect(404);
    expect((await get().expect(200)).body).toEqual({ account: ACCOUNT });
  });

  it('refuses an unauthenticated caller on both verbs', async () => {
    await request(server).get(`/groups/${code}/pay-account`).expect(401);
    await request(server).put(`/groups/${code}/pay-account`).send(ACCOUNT).expect(401);
  });

  it('never appears in the group read, the export, or the public dashboard', async () => {
    await put(ACCOUNT).expect(200);
    await prisma.session.create({
      data: { code: randomUUID().slice(0, 8), groupId: code, rawImportText: '', paymentCard: JSON.stringify({ account: ACCOUNT }) },
    });

    const ownerRead = await request(server).get(`/groups/${code}`).set('Cookie', ownerCookie).expect(200);
    const anonRead = await request(server).get(`/groups/${code}`).expect(200);
    const exported = await request(server).get(`/groups/${code}/export`).set('Cookie', ownerCookie).expect(200);
    const dashboard = await request(server).get(`/dashboards/${shareToken}`).expect(200);

    for (const res of [ownerRead, anonRead, exported, dashboard]) {
      const json = JSON.stringify(res.body);
      expect(json).not.toContain('payAccount');
      expect(json).not.toContain('paymentCard');
      expect(json).not.toContain('123-4-56789-0');
      expect(json).not.toContain('1234567890');
    }
  });
});
