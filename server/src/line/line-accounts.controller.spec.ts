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

const SECRET = 'line-accounts-test-secret';
const PASSWORD = 'a genuinely correct password';

describe('group LINE account routes', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let ownerId: string;
  let otherId: string;
  let ownerCookie: string;
  let otherCookie: string;
  let codeA: string;
  let codeB: string;
  const lineUserIds: string[] = [];

  const login = async (email: string) => {
    const res = await request(server).post('/auth/login').send({ email, password: PASSWORD }).expect(201);
    return ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0];
  };
  const list = (code = codeA, cookie = ownerCookie) =>
    request(server).get(`/groups/${code}/line/accounts`).set('Cookie', cookie);
  const link = (accountId: string, playerId: string, code = codeA, cookie = ownerCookie) =>
    request(server).put(`/groups/${code}/line/accounts/${accountId}/player`).set('Cookie', cookie).send({ playerId });
  const unlink = (accountId: string, code = codeA, cookie = ownerCookie) =>
    request(server).delete(`/groups/${code}/line/accounts/${accountId}/player`).set('Cookie', cookie);

  const makePlayer = (groupId: string, name: string) =>
    prisma.player.create({ data: { groupId, name, aliases: '[]' } });
  /** An account the directory knows in the given group (all optionally), the way a roster post or slip leaves it. */
  const makeAccount = async (
    groupIds: string[],
    over: { displayName?: string | null; pictureUrl?: string | null; source?: string; lastSeenAt?: Date } = {}
  ) => {
    const lineUserId = `U${randomUUID().replace(/-/g, '')}`;
    lineUserIds.push(lineUserId);
    const account = await prisma.lineAccount.create({
      data: {
        lineUserId,
        displayName: over.displayName === undefined ? 'Somchai' : over.displayName,
        pictureUrl: over.pictureUrl === undefined ? 'https://profile.example.test/a.jpg' : over.pictureUrl,
      },
    });
    for (const groupId of groupIds) {
      await prisma.lineAccountGroup.create({
        data: {
          groupId,
          lineAccountId: account.id,
          source: over.source ?? 'roster',
          lastSeenAt: over.lastSeenAt ?? new Date(),
        },
      });
    }
    return account;
  };
  const linkRow = (groupId: string, lineUserId: string) =>
    prisma.playerLineAccount.findUnique({ where: { groupId_lineUserId: { groupId, lineUserId } } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SESSION_SECRET)
      .useValue(SECRET)
      .overrideProvider(AuthBootstrapService)
      .useValue({ onModuleInit: async () => {} })
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.use(cookieParser(SECRET));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    prisma = app.get(PrismaService);

    const users = app.get(UsersService);
    const ownerEmail = `la-owner-${randomUUID()}@example.test`;
    const otherEmail = `la-other-${randomUUID()}@example.test`;
    ownerId = (await users.create(ownerEmail, PASSWORD)).id;
    otherId = (await users.create(otherEmail, PASSWORD)).id;
    ownerCookie = await login(ownerEmail);
    otherCookie = await login(otherEmail);

    codeA = randomUUID();
    codeB = randomUUID();
    await prisma.group.create({ data: { code: codeA, name: 'A', ownerId } });
    await prisma.group.create({ data: { code: codeB, name: 'B', ownerId } });
  });

  afterEach(async () => {
    // Players cascade their links; memberships go with the groups' rows below, so clear them per test.
    await prisma.playerLineAccount.deleteMany({ where: { groupId: { in: [codeA, codeB] } } });
    await prisma.lineAccountGroup.deleteMany({ where: { groupId: { in: [codeA, codeB] } } });
    await prisma.player.deleteMany({ where: { groupId: { in: [codeA, codeB] } } });
    await prisma.lineAccount.deleteMany({ where: { lineUserId: { in: lineUserIds.splice(0) } } });
    await prisma.user.update({ where: { id: ownerId }, data: { plan: 'club', planRenewsAt: null } });
  });

  afterAll(async () => {
    await prisma.group.deleteMany({ where: { code: { in: [codeA, codeB] } } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
    await app.close();
  });

  it("lists the group's accounts with name, avatar, source and linked player", async () => {
    const linked = await makeAccount([codeA], { displayName: 'Linked', source: 'slip', lastSeenAt: new Date('2026-10-01') });
    const free = await makeAccount([codeA], { displayName: 'Free', source: 'roster', lastSeenAt: new Date('2026-09-01') });
    const newer = await makeAccount([codeA], { displayName: 'Newer', pictureUrl: null, lastSeenAt: new Date('2026-10-20') });
    const player = await makePlayer(codeA, 'Nok');
    await prisma.playerLineAccount.create({
      data: { groupId: codeA, playerId: player.id, lineUserId: linked.lineUserId, linkedBy: 'self' },
    });

    const res = await list().expect(200);

    // Unlinked first by newest last-seen, linked last.
    expect(res.body.map((r: { id: string }) => r.id)).toEqual([newer.id, free.id, linked.id]);
    expect(res.body[0]).toEqual({
      id: newer.id,
      displayName: 'Newer',
      pictureUrl: null,
      source: 'roster',
      firstSeenAt: expect.any(String),
      lastSeenAt: new Date('2026-10-20').toISOString(),
      player: null,
    });
    expect(res.body[2]).toMatchObject({
      id: linked.id,
      displayName: 'Linked',
      pictureUrl: 'https://profile.example.test/a.jpg',
      source: 'slip',
      player: { id: player.id, name: 'Nok', linkedBy: 'self' },
    });
  });

  it("link sets linkedBy 'host'", async () => {
    const account = await makeAccount([codeA]);
    const player = await makePlayer(codeA, 'Nok');

    expect((await link(account.id, player.id).expect(200)).body).toEqual({ ok: true });

    const row = await linkRow(codeA, account.lineUserId);
    expect(row).toMatchObject({ playerId: player.id, linkedBy: 'host' });
    const listed = (await list().expect(200)).body;
    expect(listed[0].player).toEqual({ id: player.id, name: 'Nok', linkedBy: 'host' });
  });

  it("link replaces the player's previous account, which stays listed unlinked", async () => {
    const first = await makeAccount([codeA], { displayName: 'First' });
    const second = await makeAccount([codeA], { displayName: 'Second' });
    const player = await makePlayer(codeA, 'Nok');
    await link(first.id, player.id).expect(200);

    await link(second.id, player.id).expect(200);

    expect(await linkRow(codeA, first.lineUserId)).toBeNull();
    expect(await linkRow(codeA, second.lineUserId)).toMatchObject({ playerId: player.id });
    const byId = new Map((await list().expect(200)).body.map((r: { id: string }) => [r.id, r]));
    expect(byId.get(first.id)).toMatchObject({ player: null });
    expect(byId.get(second.id)).toMatchObject({ player: { id: player.id } });
  });

  it('linking the account to the player it is already linked to is a no-op success', async () => {
    const account = await makeAccount([codeA]);
    const player = await makePlayer(codeA, 'Nok');
    await prisma.playerLineAccount.create({
      data: { groupId: codeA, playerId: player.id, lineUserId: account.lineUserId, linkedBy: 'self' },
    });
    const before = await linkRow(codeA, account.lineUserId);

    await link(account.id, player.id).expect(200);

    expect(await linkRow(codeA, account.lineUserId)).toEqual(before);
  });

  it('unlink removes the link and the account stays listed', async () => {
    const account = await makeAccount([codeA]);
    const player = await makePlayer(codeA, 'Nok');
    await link(account.id, player.id).expect(200);

    expect((await unlink(account.id).expect(200)).body).toEqual({ ok: true });

    expect(await linkRow(codeA, account.lineUserId)).toBeNull();
    const listed = (await list().expect(200)).body;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: account.id, player: null });
    expect(await prisma.lineAccountGroup.count({ where: { groupId: codeA, lineAccountId: account.id } })).toBe(1);
  });

  it('unlink twice is ok', async () => {
    const account = await makeAccount([codeA]);
    const player = await makePlayer(codeA, 'Nok');
    await link(account.id, player.id).expect(200);
    await unlink(account.id).expect(200);
    expect((await unlink(account.id).expect(200)).body).toEqual({ ok: true });
  });

  it('linking an account linked to another player is 409 ACCOUNT_ALREADY_LINKED and changes nothing', async () => {
    const account = await makeAccount([codeA]);
    const claimant = await makePlayer(codeA, 'Claimant');
    const wanted = await makePlayer(codeA, 'Wanted');
    const wantedOld = await makeAccount([codeA], { displayName: 'WantedOld' });
    await prisma.playerLineAccount.create({
      data: { groupId: codeA, playerId: claimant.id, lineUserId: account.lineUserId, linkedBy: 'self' },
    });
    await prisma.playerLineAccount.create({
      data: { groupId: codeA, playerId: wanted.id, lineUserId: wantedOld.lineUserId, linkedBy: 'host' },
    });

    const res = await link(account.id, wanted.id).expect(409);

    expect(res.body).toMatchObject({ code: 'ACCOUNT_ALREADY_LINKED' });
    expect(await linkRow(codeA, account.lineUserId)).toMatchObject({ playerId: claimant.id, linkedBy: 'self' });
    // The wanted player's own previous link was not replaced.
    expect(await linkRow(codeA, wantedOld.lineUserId)).toMatchObject({ playerId: wanted.id });
  });

  it("an account known only in group A is 404 through group B's routes and absent from B's list", async () => {
    const account = await makeAccount([codeA]);
    const playerB = await makePlayer(codeB, 'InB');

    await link(account.id, playerB.id, codeB).expect(404);
    await unlink(account.id, codeB).expect(404);
    expect((await list(codeB).expect(200)).body).toEqual([]);
    expect(await linkRow(codeB, account.lineUserId)).toBeNull();
  });

  it('a player of another group is 404 and nothing is linked', async () => {
    const account = await makeAccount([codeA]);
    const playerB = await makePlayer(codeB, 'InB');

    await link(account.id, playerB.id, codeA).expect(404);

    expect(await linkRow(codeA, account.lineUserId)).toBeNull();
    expect(await prisma.playerLineAccount.count({ where: { playerId: playerB.id } })).toBe(0);
  });

  it('the same account in both groups is listed and linked independently', async () => {
    const account = await makeAccount([codeA, codeB]);
    const playerA = await makePlayer(codeA, 'InA');
    const playerB = await makePlayer(codeB, 'InB');
    await link(account.id, playerA.id, codeA).expect(200);

    const inB = (await list(codeB).expect(200)).body;
    expect(inB).toHaveLength(1);
    expect(inB[0].player).toBeNull();
    await link(account.id, playerB.id, codeB).expect(200);
    expect((await list(codeA).expect(200)).body[0].player.id).toBe(playerA.id);
  });

  it('a non-owner gets 404 on all three routes', async () => {
    const account = await makeAccount([codeA]);
    const player = await makePlayer(codeA, 'Nok');

    await list(codeA, otherCookie).expect(404);
    await link(account.id, player.id, codeA, otherCookie).expect(404);
    await unlink(account.id, codeA, otherCookie).expect(404);

    expect(await linkRow(codeA, account.lineUserId)).toBeNull();
  });

  it('requires a login', async () => {
    await request(server).get(`/groups/${codeA}/line/accounts`).expect(401);
  });

  it('refuses a body without a playerId', async () => {
    const account = await makeAccount([codeA]);
    await request(server)
      .put(`/groups/${codeA}/line/accounts/${account.id}/player`)
      .set('Cookie', ownerCookie)
      .send({})
      .expect(400);
  });

  it("a deleted player's account is listed unlinked", async () => {
    const account = await makeAccount([codeA]);
    const player = await makePlayer(codeA, 'Nok');
    await link(account.id, player.id).expect(200);

    await prisma.player.delete({ where: { id: player.id } });

    const listed = (await list().expect(200)).body;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: account.id, player: null });
  });

  it('works on a free plan', async () => {
    await prisma.user.update({ where: { id: ownerId }, data: { plan: 'free', planRenewsAt: null } });
    const account = await makeAccount([codeA]);
    const player = await makePlayer(codeA, 'Nok');

    await list().expect(200);
    await link(account.id, player.id).expect(200);
    await unlink(account.id).expect(200);
  });

  it('works on a lapsed paid plan', async () => {
    await prisma.user.update({
      where: { id: ownerId },
      data: { plan: 'host', planRenewsAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });
    const account = await makeAccount([codeA]);
    const player = await makePlayer(codeA, 'Nok');

    await list().expect(200);
    await link(account.id, player.id).expect(200);
    await unlink(account.id).expect(200);
  });

  it('the response never contains a raw lineUserId', async () => {
    const account = await makeAccount([codeA]);
    const player = await makePlayer(codeA, 'Nok');

    const bodies = [
      (await list().expect(200)).body,
      (await link(account.id, player.id).expect(200)).body,
      (await list().expect(200)).body,
      (await unlink(account.id).expect(200)).body,
    ];

    for (const body of bodies) expect(JSON.stringify(body)).not.toContain(account.lineUserId);
  });
});
