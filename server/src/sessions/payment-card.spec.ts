import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { SESSION_SECRET } from '../auth/auth.module.js';
import { AuthBootstrapService } from '../auth/bootstrap.service.js';
import { LineClient } from '../line/line-client.js';
import { retryKeyFor } from '../line/line-summary.service.js';
import { paymentCardMessages } from '../line/payment-card.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from '../users/users.service.js';
import { BillService } from './bill.service.js';
import { parsePaymentState } from './payment-card-state.js';
import { PaymentCardService, paymentRetryKey, type PaymentPanel } from './payment-card.service.js';

const SECRET = 'payment-card-test-secret';
const PASSWORD = 'a genuinely correct password';
const LIFF_ID = '2001234567-AbCdEfGh';
const ACCOUNT = { bank: 'กสิกร', number: '123-4-56789-0', name: 'สมหญิง ใจดี' };
const TONIGHT = { bank: 'กรุงไทย', number: '987-6-54321-0', name: 'ต้อม คนจ่าย' };
const NAMES = ['สมชาย', 'มาลี', 'ต้อม', 'นิด', 'แดง', 'ขาว'];

type Target = 'group' | 'host' | 'none';

describe('payment card: owner panel, confirm and bot send', () => {
  const saved = { ...process.env };
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let payments: PaymentCardService;
  let bills: BillService;
  let ownerId: string;
  let otherId: string;
  let ownerCookie: string;
  let otherCookie: string;
  const groupCodes: string[] = [];
  const fakeClient = {
    reply: vi.fn(),
    replyMessages: vi.fn(),
    groupName: vi.fn(),
    memberName: vi.fn(),
    leave: vi.fn(),
    push: vi.fn(),
  };

  const login = async (email: string) => {
    const res = await request(server).post('/auth/login').send({ email, password: PASSWORD }).expect(201);
    return ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0];
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SESSION_SECRET)
      .useValue(SECRET)
      .overrideProvider(AuthBootstrapService)
      .useValue({ onModuleInit: async () => {} })
      .overrideProvider(LineClient)
      .useValue(fakeClient)
      .compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.use(cookieParser(SECRET));
    // The same global pipe as main.ts: a DTO field with no validator decorator is silently stripped by it.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    prisma = app.get(PrismaService);
    payments = app.get(PaymentCardService);
    bills = app.get(BillService);

    const users = app.get(UsersService);
    const ownerEmail = `pay-card-owner-${randomUUID()}@example.test`;
    const otherEmail = `pay-card-other-${randomUUID()}@example.test`;
    ownerId = (await users.create(ownerEmail, PASSWORD)).id;
    otherId = (await users.create(otherEmail, PASSWORD)).id;
    ownerCookie = await login(ownerEmail);
    otherCookie = await login(otherEmail);
  });

  afterAll(async () => {
    const where = { session: { groupId: { in: groupCodes } } };
    await prisma.pairing.deleteMany({ where });
    await prisma.sessionCheckout.deleteMany({ where });
    await prisma.sessionRoster.deleteMany({ where });
    await prisma.session.deleteMany({ where: { groupId: { in: groupCodes } } });
    await prisma.player.deleteMany({ where: { groupId: { in: groupCodes } } });
    await prisma.group.deleteMany({ where: { code: { in: groupCodes } } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
    await app.close();
  });

  beforeEach(async () => {
    fakeClient.push.mockReset().mockResolvedValue('ok');
    process.env.LINE_CHANNEL_SECRET = 's';
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 't';
    process.env.PUBLIC_APP_URL = 'https://jubbad.test';
    process.env.LINE_LIFF_ID = LIFF_ID;
    // A host-plan owner who linked their own LINE account, so an unlinked group with the DM switch on is `host`.
    await prisma.user.update({
      where: { id: ownerId },
      data: { plan: 'host', planRenewsAt: null, lineUserId: `U${ownerId.replace(/-/g, '')}` },
    });
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  const panelOf = async (code: string, cookie = ownerCookie): Promise<PaymentPanel> =>
    (await request(server).get(`/sessions/${code}/payment-card`).set('Cookie', cookie).expect(200)).body;
  const confirm = (code: string, body: object = {}, cookie = ownerCookie) =>
    request(server).post(`/sessions/${code}/payment-card/confirm`).set('Cookie', cookie).send(body);
  const send = (code: string, sendId: string = randomUUID(), cookie = ownerCookie) =>
    request(server).post(`/sessions/${code}/payment-card/send`).set('Cookie', cookie).send({ sendId });
  const billConfig = (code: string, over: object = {}) =>
    request(server)
      .post(`/sessions/${code}/bill-config`)
      .set('Cookie', ownerCookie)
      .send({
        model: 'fair', courtFeeSatang: 60000, courtSplit: 'equal', shuttleSplit: 'byGames',
        perGameRateSatang: 0, entryFeeSatang: 0, capSatang: null, buffetPriceSatang: 0,
        buffetShuttlesIncluded: true, startingFeeSatang: 0, hostFeeSatang: 0, walkInFeeSatang: 0, roundingBaht: 1,
        addedIds: [], removedIds: [], overrides: [], ...over,
      })
      .expect(201);

  /**
   * Six players on the roster: P0-P3 and P5 played (P5 is then removed, ไม่คิดเงิน), P4 did not come (ไม่มา).
   * The bill is ready (court fee, shuttle count and price) unless `ready` is false.
   */
  async function setup(options: { target?: Target; ended?: boolean; account?: boolean; ready?: boolean } = {}) {
    const { target = 'group', ended = true, account = true, ready = true } = options;
    const groupCode = `pay-${randomUUID().slice(0, 10)}`;
    groupCodes.push(groupCode);
    await prisma.group.create({
      data: {
        code: groupCode,
        name: 'ตีชิล',
        ownerId,
        lineGroupId: target === 'group' ? `C${randomUUID().replace(/-/g, '')}` : null,
        lineDmEnabled: target === 'host',
        payAccount: account ? JSON.stringify(ACCOUNT) : null,
      },
    });
    const players = [];
    for (const name of NAMES) {
      players.push(await prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } }));
    }
    const ids = players.map((p) => p.id);
    const code = `p${randomUUID().slice(0, 8)}`;
    await prisma.session.create({
      data: {
        code,
        groupId: groupCode,
        rawImportText: '',
        date: '2026-10-29',
        venue: 'Bad@Mama',
        shuttleCount: 3,
        shuttlePriceSatang: 8000,
        // Open while the bill is configured; ended below.
      },
    });
    for (const id of ids) await prisma.sessionRoster.create({ data: { sessionId: code, playerId: id } });
    const at = new Date('2026-10-29T13:00:00Z');
    const games = [
      [ids[0], ids[1], ids[2], ids[3]],
      [ids[0], ids[1], ids[2], ids[5]],
    ];
    for (const [i, g] of games.entries()) {
      await prisma.pairing.create({
        data: {
          sessionId: code, courtNumber: 1, matchNumber: i + 1,
          teamA: JSON.stringify(g.slice(0, 2)), teamB: JSON.stringify(g.slice(2)),
          winner: 'A', confirmedAt: at, endedAt: at,
        },
      });
    }
    await billConfig(code, { absentIds: [ids[4]], removedIds: [ids[5]], ...(ready ? {} : { courtFeeSatang: null }) });
    if (ended) await prisma.session.update({ where: { code }, data: { endedAt: new Date('2026-10-29T15:00:00Z') } });
    return { code, groupCode, ids };
  }

  describe('panel', () => {
    it('lists the people still due in the bill order, with the bill amounts, and totals them', async () => {
      const { code, ids } = await setup();
      const panel = await panelOf(code);
      const bill = await bills.getBill(code);
      const billed = new Map(bill.result.rows.filter((r) => r.status === 'billed').map((r) => [r.playerId, r]));
      const expected = bill.players
        .filter((p) => billed.has(p.playerId))
        .map((p) => ({
          playerId: p.playerId,
          name: p.name,
          amountSatang: billed.get(p.playerId)!.amountSatang,
          absent: billed.get(p.playerId)!.absent,
        }));

      expect(panel.rows).toEqual(expected);
      expect(panel.rows).toHaveLength(5);
      // ไม่คิดเงิน is not a row; ไม่มา is, marked absent, with a court share.
      expect(panel.rows.map((r) => r.playerId)).not.toContain(ids[5]);
      const absent = panel.rows.find((r) => r.playerId === ids[4])!;
      expect(absent).toMatchObject({ name: 'แดง', absent: true });
      expect(absent.amountSatang).toBeGreaterThan(0);
      expect(panel.rows.filter((r) => r.absent)).toHaveLength(1);

      expect(panel.totalSatang).toBe(panel.rows.reduce((s, r) => s + r.amountSatang, 0));
      expect(panel.totalSatang).toBe(bill.result.totals.stillDueSatang);
      expect(panel).toMatchObject({
        target: 'group',
        ended: true,
        ready: true,
        warnings: [],
        settledCount: 0,
        groupAccount: ACCOUNT,
        account: ACCOUNT,
        confirmed: false,
        stale: false,
        lastSentAt: null,
        shareUrl: null,
      });
    });

    it('counts settled early checkouts apart from the rows', async () => {
      const { code, ids } = await setup();
      await prisma.session.update({ where: { code }, data: { shuttleToolsEnabled: true } });
      await prisma.sessionCheckout.create({
        data: {
          sessionId: code, playerId: ids[3], model: 'buffet', amountSatang: 15000,
          breakdown: JSON.stringify({
            baseSatang: 15000, shuttleSatang: 0, hostFeeSatang: 0, walkInFeeSatang: 0, discountSatang: 0,
          }),
          snapshot: '{}', idempotencyKey: randomUUID(),
        },
      });
      const panel = await panelOf(code);
      const bill = await bills.getBill(code);
      expect(bill.settled).toHaveLength(1);
      expect(panel.settledCount).toBe(1);
      expect(panel.rows.map((r) => r.playerId)).not.toContain(ids[3]);
      expect(panel.totalSatang).toBe(bill.result.totals.stillDueSatang);
    });

    it('is ready with only an informational warning (excess credit): it shows, and the card confirms and sends', async () => {
      const { code, ids } = await setup();
      await prisma.session.update({ where: { code }, data: { shuttleToolsEnabled: true } });
      // An early-checkout receipt larger than the whole night's cost (court 600 + shuttles 240 baht).
      await prisma.sessionCheckout.create({
        data: {
          sessionId: code, playerId: ids[3], model: 'buffet', amountSatang: 100000,
          breakdown: JSON.stringify({
            baseSatang: 100000, shuttleSatang: 0, hostFeeSatang: 0, walkInFeeSatang: 0, discountSatang: 0,
          }),
          snapshot: '{}', idempotencyKey: randomUUID(),
        },
      });
      const bill = await bills.getBill(code);
      expect(bill.result.warnings).toEqual(['EXCESS_CREDIT']);
      expect(bill.readyToCopy).toBe(false);

      const panel = await panelOf(code);
      expect(panel).toMatchObject({ ready: true, warnings: ['EXCESS_CREDIT'], notices: ['EXCESS_CREDIT'] });
      expect(panel.rows.length).toBeGreaterThan(0);
      expect((await confirm(code).expect(200)).body).toMatchObject({ confirmed: true, stale: false });
      expect((await send(code).expect(200)).body).toEqual({ outcome: 'sent' });
      expect(fakeClient.push).toHaveBeenCalledTimes(1);
    });

    it('is not ready while the court fee is missing, and confirm refuses with PAYMENT_NOT_READY', async () => {
      const { code } = await setup({ ready: false });
      const panel = await panelOf(code);
      expect(panel.ready).toBe(false);
      expect(panel.warnings).toContain('MISSING_COURT_FEE');
      expect(panel.notices).toEqual([]);
      expect((await confirm(code).expect(409)).body.code).toBe('PAYMENT_NOT_READY');
    });

    it('answers for an open session, which cannot be confirmed yet', async () => {
      const { code } = await setup({ ended: false });
      const panel = await panelOf(code);
      expect(panel).toMatchObject({ ended: false, shareUrl: null, confirmed: false });
      expect(panel.rows).toHaveLength(5);
      expect((await confirm(code).expect(409)).body.code).toBe('PAYMENT_NOT_READY');
    });

    it('has no target without a LINE destination, and confirm refuses with PAYMENT_UNAVAILABLE', async () => {
      const { code } = await setup({ target: 'none' });
      expect((await panelOf(code)).target).toBeNull();
      expect((await confirm(code).expect(409)).body.code).toBe('PAYMENT_UNAVAILABLE');
    });

    it('refuses to confirm with nobody left to collect from', async () => {
      const { code, ids } = await setup();
      await billConfig(code, { removedIds: ids });
      const panel = await panelOf(code);
      expect(panel.rows).toEqual([]);
      expect(panel.totalSatang).toBe(0);
      expect((await confirm(code).expect(409)).body.code).toBe('PAYMENT_NOT_READY');
    });
  });

  describe('confirm', () => {
    it('refuses with PAYMENT_NO_ACCOUNT when no account is set anywhere', async () => {
      const { code } = await setup({ account: false });
      const panel = await panelOf(code);
      expect(panel.account).toBeNull();
      expect((await confirm(code).expect(409)).body.code).toBe('PAYMENT_NO_ACCOUNT');
      expect((await prisma.session.findUniqueOrThrow({ where: { code } })).paymentCard).toBeNull();
    });

    it('takes tonight\'s account from a real body through the global pipe and stores it with a token', async () => {
      const { code, groupCode } = await setup({ account: false });
      const panel = (await confirm(code, TONIGHT).expect(200)).body as PaymentPanel;
      expect(panel).toMatchObject({ confirmed: true, stale: false, account: TONIGHT, groupAccount: null });

      const state = parsePaymentState((await prisma.session.findUniqueOrThrow({ where: { code } })).paymentCard);
      expect(state.account).toEqual(TONIGHT);
      expect(state.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(state.confirmedAt).not.toBeNull();
      expect(state.confirmedHash).toMatch(/^[0-9a-f]{64}$/);
      // Tonight's account is the session's, never written back as the group default.
      expect((await prisma.group.findUniqueOrThrow({ where: { code: groupCode } })).payAccount).toBeNull();
    });

    it('confirms the group default when the body is blank, and keeps it for tonight after the default is cleared', async () => {
      const { code, groupCode } = await setup();
      expect((await confirm(code, {}).expect(200)).body).toMatchObject({ confirmed: true, account: ACCOUNT });
      await prisma.group.update({ where: { code: groupCode }, data: { payAccount: null } });
      expect(await panelOf(code)).toMatchObject({ groupAccount: null, account: ACCOUNT, confirmed: true, stale: false });
    });

    it('refuses a partial account with PAY_ACCOUNT_INVALID and stores nothing', async () => {
      const { code } = await setup();
      const res = await confirm(code, { bank: 'กสิกร' }).expect(400);
      expect(res.body.code).toBe('PAY_ACCOUNT_INVALID');
      expect((await prisma.session.findUniqueOrThrow({ where: { code } })).paymentCard).toBeNull();
    });

    it('makes a new token on every confirm and keeps the last send time', async () => {
      const { code } = await setup();
      await confirm(code).expect(200);
      const first = parsePaymentState((await prisma.session.findUniqueOrThrow({ where: { code } })).paymentCard);
      expect((await send(code).expect(200)).body).toEqual({ outcome: 'sent' });
      await confirm(code).expect(200);
      const second = parsePaymentState((await prisma.session.findUniqueOrThrow({ where: { code } })).paymentCard);
      expect(second.token).not.toBe(first.token);
      expect(second.lastSentAt).not.toBeNull();
    });
  });

  describe('stale after a bill edit', () => {
    it('marks the panel stale, drops the host link and refuses the bot send until confirmed again', async () => {
      const host = await setup({ target: 'host' });
      await confirm(host.code).expect(200);
      const before = await panelOf(host.code);
      expect(before.shareUrl).not.toBeNull();

      await billConfig(host.code, { courtFeeSatang: 70000, absentIds: [host.ids[4]], removedIds: [host.ids[5]] });
      expect(await panelOf(host.code)).toMatchObject({ confirmed: true, stale: true, shareUrl: null });

      const group = await setup();
      await confirm(group.code).expect(200);
      await billConfig(group.code, { courtFeeSatang: 70000, absentIds: [group.ids[4]], removedIds: [group.ids[5]] });
      expect((await panelOf(group.code)).stale).toBe(true);
      expect((await send(group.code).expect(200)).body).toEqual({ outcome: 'stale' });
      expect(fakeClient.push).not.toHaveBeenCalled();

      await confirm(group.code).expect(200);
      expect((await panelOf(group.code)).stale).toBe(false);
      expect((await send(group.code).expect(200)).body).toEqual({ outcome: 'sent' });
    });

    it('is stale when two amounts move but the total stays the same', async () => {
      const { code, ids } = await setup();
      const panel = (await confirm(code).expect(200)).body as PaymentPanel;
      const amount = (id: string) => panel.rows.find((r) => r.playerId === id)!.amountSatang;
      await billConfig(code, {
        absentIds: [ids[4]],
        removedIds: [ids[5]],
        overrides: [
          { playerId: ids[0], amountSatang: amount(ids[0]) + 1000 },
          { playerId: ids[1], amountSatang: amount(ids[1]) - 1000 },
        ],
      });
      const after = await panelOf(code);
      expect(after.totalSatang).toBe(panel.totalSatang);
      expect(after.stale).toBe(true);
    });

    it('is stale when anything the card prints changes, such as a player renamed since', async () => {
      const { code, ids } = await setup();
      await confirm(code).expect(200);
      await prisma.player.update({ where: { id: ids[0] }, data: { name: 'สมชาย ใหม่' } });
      expect((await panelOf(code)).stale).toBe(true);
    });
  });

  describe('send', () => {
    it('posts the confirmed card to the linked group once, with the builder messages, and records the time', async () => {
      const { code, groupCode } = await setup();
      const panel = (await confirm(code).expect(200)).body as PaymentPanel;
      const sendId = randomUUID();
      expect((await send(code, sendId).expect(200)).body).toEqual({ outcome: 'sent' });

      expect(fakeClient.push).toHaveBeenCalledTimes(1);
      const group = await prisma.group.findUniqueOrThrow({ where: { code: groupCode } });
      const [to, messages, retryKey] = fakeClient.push.mock.calls[0];
      expect(to).toBe(group.lineGroupId);
      expect(retryKey).toBe(paymentRetryKey(code, sendId));
      expect(messages).toEqual(
        paymentCardMessages(
          {
            groupName: 'ตีชิล',
            date: '2026-10-29',
            endedAt: new Date('2026-10-29T15:00:00Z'),
            venue: 'Bad@Mama',
            rows: panel.rows.map(({ name, amountSatang, absent }) => ({ name, amountSatang, absent })),
            settledCount: 0,
            totalSatang: panel.totalSatang,
            account: ACCOUNT,
          },
          'group'
        )
      );
      const after = await panelOf(code);
      expect(after.lastSentAt).not.toBeNull();
      expect(Date.now() - Date.parse(after.lastSentAt!)).toBeLessThan(60_000);
    });

    it('uses one retry key per sendId: the same id repeats it, a new id does not', async () => {
      const { code } = await setup();
      await confirm(code).expect(200);
      const t0 = new Date();
      const later = (s: number) => new Date(t0.getTime() + s * 1000);
      const a = randomUUID();
      expect(await payments.send(code, a, t0)).toBe('sent');
      expect(await payments.send(code, a, later(10))).toBe('sent');
      expect(await payments.send(code, randomUUID(), later(20))).toBe('sent');
      const keys = fakeClient.push.mock.calls.map((c) => c[2]);
      expect(keys[0]).toBe(keys[1]);
      expect(keys[2]).not.toBe(keys[0]);
    });

    it('pins the retry key construction and keeps it apart from the summary card keys', () => {
      const key = paymentRetryKey('abc12345', '00000000-0000-4000-8000-000000000001');
      expect(key).toBe('9d5bf2fc-35f3-585f-a1a9-d40493f97f59');
      expect(key).not.toBe(retryKeyFor('group', 'abc12345'));
      expect(key).not.toBe(retryKeyFor('host', 'abc12345'));
    });

    it('passes quota and failed through and leaves the send time unset', async () => {
      const { code } = await setup();
      await confirm(code).expect(200);
      fakeClient.push.mockResolvedValueOnce('quota');
      expect((await send(code).expect(200)).body).toEqual({ outcome: 'quota' });
      fakeClient.push.mockResolvedValueOnce('failed');
      expect((await send(code).expect(200)).body).toEqual({ outcome: 'failed' });
      fakeClient.push.mockRejectedValueOnce(new Error('boom'));
      expect((await send(code).expect(200)).body).toEqual({ outcome: 'failed' });
      expect((await panelOf(code)).lastSentAt).toBeNull();
      expect(fakeClient.push).toHaveBeenCalledTimes(3);
    });

    it('is busy for a second tap within 5 seconds and sends a deliberate resend after', async () => {
      const { code } = await setup();
      await confirm(code).expect(200);
      const t0 = new Date();
      const at = (ms: number) => new Date(t0.getTime() + ms);
      expect(await payments.send(code, randomUUID(), t0)).toBe('sent');
      expect(await payments.send(code, randomUUID(), at(4_999))).toBe('busy');
      expect(fakeClient.push).toHaveBeenCalledTimes(1);
      expect(await payments.send(code, randomUUID(), at(5_000))).toBe('sent');
      expect(fakeClient.push).toHaveBeenCalledTimes(2);
    });

    it('posts once when two tabs send at the same moment with different ids', async () => {
      const { code } = await setup();
      await confirm(code).expect(200);
      const outcomes = await Promise.all([send(code), send(code)]);
      expect(outcomes.map((r) => r.body.outcome).sort()).toEqual(['busy', 'sent']);
      expect(fakeClient.push).toHaveBeenCalledTimes(1);
    });

    it('refuses before a confirm', async () => {
      const { code } = await setup();
      expect((await send(code).expect(200)).body).toEqual({ outcome: 'not-confirmed' });
      expect(fakeClient.push).not.toHaveBeenCalled();
    });

    it('is unavailable for the host target: that card is shared by the host, not posted', async () => {
      const { code } = await setup({ target: 'host' });
      await confirm(code).expect(200);
      expect((await send(code).expect(200)).body).toEqual({ outcome: 'unavailable' });
      expect(fakeClient.push).not.toHaveBeenCalled();
    });

    it('is unavailable when the plan lapses between confirm and send', async () => {
      const { code } = await setup();
      await confirm(code).expect(200);
      await prisma.user.update({ where: { id: ownerId }, data: { planRenewsAt: new Date(Date.now() - 86_400_000) } });
      expect((await send(code).expect(200)).body).toEqual({ outcome: 'unavailable' });
      expect((await panelOf(code)).target).toBeNull();
      expect(fakeClient.push).not.toHaveBeenCalled();
    });

    it('is unavailable when the LINE group is unlinked between confirm and send', async () => {
      const { code, groupCode } = await setup();
      await confirm(code).expect(200);
      await prisma.group.update({ where: { code: groupCode }, data: { lineGroupId: null } });
      expect((await send(code).expect(200)).body).toEqual({ outcome: 'unavailable' });
      expect(fakeClient.push).not.toHaveBeenCalled();
    });

    it('needs a UUID sendId from the body', async () => {
      const { code } = await setup();
      await confirm(code).expect(200);
      const post = (body: object) =>
        request(server).post(`/sessions/${code}/payment-card/send`).set('Cookie', ownerCookie).send(body);
      await post({ sendId: 'not-a-uuid' }).expect(400);
      await post({}).expect(400);
      await post({ sendId: 42 }).expect(400);
      expect(fakeClient.push).not.toHaveBeenCalled();
    });
  });

  describe('access', () => {
    it('answers 404 to another host and 401 to no login on every owner route', async () => {
      const { code } = await setup();
      await request(server).get(`/sessions/${code}/payment-card`).set('Cookie', otherCookie).expect(404);
      await confirm(code, {}, otherCookie).expect(404);
      await send(code, randomUUID(), otherCookie).expect(404);
      await request(server).get(`/sessions/${code}/payment-card`).expect(401);
      await request(server).post(`/sessions/${code}/payment-card/confirm`).send({}).expect(401);
      await request(server).post(`/sessions/${code}/payment-card/send`).send({ sendId: randomUUID() }).expect(401);
      expect((await prisma.session.findUniqueOrThrow({ where: { code } })).paymentCard).toBeNull();
      expect(fakeClient.push).not.toHaveBeenCalled();
    });
  });

  describe('malformed stored values read as absent', () => {
    for (const [label, paymentCard, payAccount] of [
      ['not JSON', '{not json', '{nope'],
      ['wrong shapes', '[1,2,3]', '"a string"'],
      ['half a confirm', JSON.stringify({ token: 'abc', confirmedHash: 'x' }), JSON.stringify({ bank: 'กสิกร' })],
    ] as const) {
      it(`${label}: the panel, the bill and ending the session all still work`, async () => {
        const { code, groupCode } = await setup({ ended: false });
        await prisma.session.update({ where: { code }, data: { paymentCard } });
        await prisma.group.update({ where: { code: groupCode }, data: { payAccount } });

        expect(await panelOf(code)).toMatchObject({ confirmed: false, stale: false, account: null, groupAccount: null });
        await request(server).get(`/sessions/${code}/bill`).set('Cookie', ownerCookie).expect(200);
        await request(server).post(`/sessions/${code}/end`).set('Cookie', ownerCookie).send({}).expect(201);
        expect((await panelOf(code)).ended).toBe(true);
      });
    }
  });
});
