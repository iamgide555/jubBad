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
import { GroupsService } from './groups.service.js';

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
  let otherGroupCode: string;
  const lineUserIds: string[] = [];
  const putCollector = (body: object, cookie = ownerCookie) =>
    request(server).put(`/groups/${code}/pay-collector`).set('Cookie', cookie).send(body);
  /** A player of `groupId`, optionally with a LINE account linked there (the collector eligibility rule). */
  const makePlayer = async (groupId: string, linked: boolean) => {
    const player = await prisma.player.create({ data: { groupId, name: `p-${randomUUID().slice(0, 6)}`, aliases: '[]' } });
    if (linked) {
      const lineUserId = `U${randomUUID().replace(/-/g, '')}`;
      lineUserIds.push(lineUserId);
      await prisma.lineAccount.create({ data: { lineUserId } });
      await prisma.playerLineAccount.create({ data: { groupId, playerId: player.id, lineUserId, linkedBy: 'host' } });
    }
    return player.id;
  };
  const storedCollector = async () =>
    (await prisma.group.findUniqueOrThrow({ where: { code }, select: { payCollectorPlayerId: true } })).payCollectorPlayerId;
  const storedPin = async () =>
    (await prisma.group.findUniqueOrThrow({ where: { code }, select: { payCollectorLineUserId: true } })).payCollectorLineUserId;
  const linkOf = async (playerId: string) =>
    (await prisma.playerLineAccount.findFirstOrThrow({ where: { groupId: code, playerId } })).lineUserId;
  /** Unlinks the player here and links `lineUserId` to them instead (a fresh LINE account when omitted). */
  const relink = async (playerId: string, lineUserId?: string) => {
    await prisma.playerLineAccount.deleteMany({ where: { groupId: code, playerId } });
    let id = lineUserId;
    if (id === undefined) {
      id = `U${randomUUID().replace(/-/g, '')}`;
      lineUserIds.push(id);
      await prisma.lineAccount.create({ data: { lineUserId: id } });
    }
    await prisma.playerLineAccount.create({ data: { groupId: code, playerId, lineUserId: id, linkedBy: 'self' } });
    return id;
  };

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
    otherGroupCode = randomUUID();
    await prisma.group.create({
      data: { code: otherGroupCode, name: 'Elsewhere', ownerId, shareToken: randomUUID().replace(/-/g, '').slice(0, 22) },
    });
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { groupId: code } });
    // Deleting players before their group (the real order, see buildDeleteGroupOps) frees the collector FK.
    await prisma.player.deleteMany({ where: { groupId: { in: [code, otherGroupCode] } } });
    await prisma.group.deleteMany({ where: { code: { in: [code, otherGroupCode] } } });
    await prisma.lineAccount.deleteMany({ where: { lineUserId: { in: lineUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
    await app.close();
  });

  beforeEach(async () => {
    await prisma.group.update({ where: { code }, data: { payAccount: null, payCollectorPlayerId: null, payCollectorLineUserId: null } });
  });

  it('reads no account for a fresh group', async () => {
    expect((await get().expect(200)).body).toEqual({ account: null, collectorPlayerId: null, collectorStale: false });
  });

  it('stores all three fields of a real PUT body through the global pipe, and reads them back', async () => {
    expect((await put(ACCOUNT).expect(200)).body).toEqual({ account: ACCOUNT });
    expect((await get().expect(200)).body).toEqual({ account: ACCOUNT, collectorPlayerId: null, collectorStale: false });
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
    expect((await get().expect(200)).body).toEqual({ account: null, collectorPlayerId: null, collectorStale: false });
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
    expect((await get().expect(200)).body).toEqual({ account: ACCOUNT, collectorPlayerId: null, collectorStale: false });
  });

  it('refuses non-string fields with a generic 400 and keeps the old account', async () => {
    await put(ACCOUNT).expect(200);
    const res = await put({ bank: 5, number: '123456', name: 'x' }).expect(400);
    expect(res.body.code).toBeUndefined();
    expect((await get().expect(200)).body).toEqual({ account: ACCOUNT, collectorPlayerId: null, collectorStale: false });
  });

  it('refuses a string over the DTO cap with a 400 and keeps the old account', async () => {
    await put(ACCOUNT).expect(200);
    await put({ ...ACCOUNT, name: 'ส'.repeat(201) }).expect(400);
    await put({ ...ACCOUNT, number: '1'.repeat(201) }).expect(400);
    expect((await get().expect(200)).body).toEqual({ account: ACCOUNT, collectorPlayerId: null, collectorStale: false });
  });

  it('reads null like a blank field: all null clears, null beside a filled field is partial', async () => {
    await put(ACCOUNT).expect(200);
    const partial = await put({ bank: 'กสิกร', number: null, name: null }).expect(400);
    expect(partial.body.code).toBe('PAY_ACCOUNT_INVALID');
    expect((await get().expect(200)).body).toEqual({ account: ACCOUNT, collectorPlayerId: null, collectorStale: false });
    expect((await put({ bank: null, number: null, name: null }).expect(200)).body).toEqual({ account: null });
    expect((await get().expect(200)).body).toEqual({ account: null, collectorPlayerId: null, collectorStale: false });
  });

  describe('collector', () => {
    it('sets a linked player of the group, and the read returns it', async () => {
      await put(ACCOUNT).expect(200);
      const playerId = await makePlayer(code, true);
      expect((await putCollector({ playerId }).expect(200)).body).toEqual({ collectorPlayerId: playerId });
      expect((await get().expect(200)).body).toEqual({ account: ACCOUNT, collectorPlayerId: playerId, collectorStale: false });
    });

    it('pins the LINE account linked at the pick; clearing clears both', async () => {
      await put(ACCOUNT).expect(200);
      const playerId = await makePlayer(code, true);
      await putCollector({ playerId }).expect(200);
      expect(await storedPin()).toBe(await linkOf(playerId));
      await putCollector({ playerId: null }).expect(200);
      expect([await storedCollector(), await storedPin()]).toEqual([null, null]);
      await putCollector({ playerId }).expect(200);
      await put({}).expect(200);
      expect([await storedCollector(), await storedPin()]).toEqual([null, null]);
    });

    it('reads a pick whose LINE account was unlinked or replaced as stale, and as held again once the same one is back', async () => {
      await put(ACCOUNT).expect(200);
      const playerId = await makePlayer(code, true);
      const original = await linkOf(playerId);
      await putCollector({ playerId }).expect(200);
      await prisma.playerLineAccount.deleteMany({ where: { groupId: code, playerId } });
      expect((await get().expect(200)).body).toEqual({ account: ACCOUNT, collectorPlayerId: null, collectorStale: true });
      await relink(playerId);
      expect((await get().expect(200)).body).toEqual({ account: ACCOUNT, collectorPlayerId: null, collectorStale: true });
      await relink(playerId, original);
      expect((await get().expect(200)).body).toEqual({ account: ACCOUNT, collectorPlayerId: playerId, collectorStale: false });
      // Picking again pins whichever account is linked now.
      const replaced = await relink(playerId);
      await putCollector({ playerId }).expect(200);
      expect(await storedPin()).toBe(replaced);
      expect((await get().expect(200)).body).toEqual({ account: ACCOUNT, collectorPlayerId: playerId, collectorStale: false });
    });

    it('reads a pick with no pinned LINE account as stale', async () => {
      await put(ACCOUNT).expect(200);
      const playerId = await makePlayer(code, true);
      await prisma.group.update({ where: { code }, data: { payCollectorPlayerId: playerId, payCollectorLineUserId: null } });
      expect((await get().expect(200)).body).toEqual({ account: ACCOUNT, collectorPlayerId: null, collectorStale: true });
    });

    it('refuses an unlinked player, and another group\'s linked player, with COLLECTOR_INVALID and keeps the value', async () => {
      await put(ACCOUNT).expect(200);
      const good = await makePlayer(code, true);
      await putCollector({ playerId: good }).expect(200);
      for (const playerId of [await makePlayer(code, false), await makePlayer(otherGroupCode, true), 'no-such-player']) {
        const res = await putCollector({ playerId }).expect(409);
        expect(res.body.code, playerId).toBe('COLLECTOR_INVALID');
      }
      expect(await storedCollector()).toBe(good);
    });

    it('refuses a collector on a group with no saved account with PAY_ACCOUNT_REQUIRED', async () => {
      const playerId = await makePlayer(code, true);
      const res = await putCollector({ playerId }).expect(409);
      expect(res.body.code).toBe('PAY_ACCOUNT_REQUIRED');
      expect(await storedCollector()).toBeNull();
    });

    it('clears with a null playerId, even with no saved account', async () => {
      await put(ACCOUNT).expect(200);
      await putCollector({ playerId: await makePlayer(code, true) }).expect(200);
      expect((await putCollector({ playerId: null }).expect(200)).body).toEqual({ collectorPlayerId: null });
      expect(await storedCollector()).toBeNull();
    });

    it('refuses a non-string or over-long playerId with a generic 400', async () => {
      await putCollector({ playerId: 5 }).expect(400);
      await putCollector({ playerId: 'x'.repeat(65) }).expect(400);
    });

    it('clearing the account clears the collector; editing only the name keeps it', async () => {
      await put(ACCOUNT).expect(200);
      const playerId = await makePlayer(code, true);
      await putCollector({ playerId }).expect(200);
      await put({ ...ACCOUNT, name: 'ชื่อใหม่' }).expect(200);
      expect(await storedCollector()).toBe(playerId);
      await put({}).expect(200);
      expect(await storedCollector()).toBeNull();
    });

    it('answers 404 to a different host and 401 to a caller with no login, changing nothing', async () => {
      await put(ACCOUNT).expect(200);
      const playerId = await makePlayer(code, true);
      await putCollector({ playerId }, otherCookie).expect(404);
      await request(server).put(`/groups/${code}/pay-collector`).send({ playerId }).expect(401);
      expect(await storedCollector()).toBeNull();
    });

    it('does not block deleting the group: its player rows go first, then the group', async () => {
      const doomed = randomUUID();
      await prisma.group.create({ data: { code: doomed, name: 'Doomed', ownerId, shareToken: randomUUID().replace(/-/g, '').slice(0, 22) } });
      const playerId = await makePlayer(doomed, true);
      await prisma.group.update({ where: { code: doomed }, data: { payAccount: JSON.stringify(ACCOUNT), payCollectorPlayerId: playerId } });
      const ops = await app.get(GroupsService).buildDeleteGroupOps(doomed);
      await prisma.$transaction(ops!);
      expect(await prisma.group.findUnique({ where: { code: doomed } })).toBeNull();
    });

    it('never rides the group read, the export, or the public dashboard', async () => {
      await put(ACCOUNT).expect(200);
      const playerId = await makePlayer(code, true);
      await putCollector({ playerId }).expect(200);
      for (const res of [
        await request(server).get(`/groups/${code}`).set('Cookie', ownerCookie).expect(200),
        await request(server).get(`/groups/${code}`).expect(200),
        await request(server).get(`/groups/${code}/export`).set('Cookie', ownerCookie).expect(200),
        await request(server).get(`/dashboards/${shareToken}`).expect(200),
      ]) {
        expect(JSON.stringify(res.body)).not.toContain('ollector');
      }
    });
  });

  describe('no plan gate: a free or lapsed owner can still set, read and clear', () => {
    const asPlan = async (data: { plan: string; planRenewsAt: Date | null }) => {
      await prisma.user.update({ where: { id: ownerId }, data });
    };
    const walk = async () => {
      expect((await put(ACCOUNT).expect(200)).body).toEqual({ account: ACCOUNT });
      expect((await get().expect(200)).body).toEqual({ account: ACCOUNT, collectorPlayerId: null, collectorStale: false });
      expect((await put({}).expect(200)).body).toEqual({ account: null });
      expect((await get().expect(200)).body).toEqual({ account: null, collectorPlayerId: null, collectorStale: false });
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
    expect((await get().expect(200)).body).toEqual({ account: ACCOUNT, collectorPlayerId: null, collectorStale: false });
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
