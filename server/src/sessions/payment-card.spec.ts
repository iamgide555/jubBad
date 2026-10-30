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
import { liffSlipUrl, paymentCardMessages, paymentDmMessages } from '../line/payment-card.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from '../users/users.service.js';
import { BillService } from './bill.service.js';
import { newShareToken, parsePaymentState, serializePaymentState } from './payment-card-state.js';
import {
  isReady,
  PaymentCardService,
  paymentDmRetryKey,
  paymentRetryKey,
  type PaymentPanel,
} from './payment-card.service.js';

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
    // The pay page verifies LINE access tokens against this channel; without it the slip button is left off.
    process.env.LINE_LOGIN_CHANNEL_ID = '1234567890';
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
  /**
   * Confirms as the panel would: with the content hash of a fresh read, unless the body brings its own.
   * Returns `{ expect }` so call sites read like a supertest chain.
   */
  const confirm = (code: string, body: object = {}, cookie = ownerCookie) => ({
    expect: async (status: number) => {
      const expectedHash = 'expectedHash' in body ? undefined : (await payments.panel(code)).contentHash;
      return request(server)
        .post(`/sessions/${code}/payment-card/confirm`)
        .set('Cookie', cookie)
        .send({ expectedHash, ...body })
        .expect(status);
    },
  });
  /**
   * Stores a confirm of exactly what the panel shows now, past the confirm route's own refusals, so a send
   * or share gate can be tested on a card that is confirmed and current (not stale).
   */
  const storeConfirmed = async (code: string) => {
    const panel = await payments.panel(code);
    await prisma.session.update({
      where: { code },
      data: {
        paymentCard: serializePaymentState({
          account: panel.account,
          token: newShareToken(),
          confirmedAt: new Date().toISOString(),
          confirmedHash: panel.contentHash,
          lastSentAt: null,
          lastDmAt: null,
        }),
      },
    });
    expect(await payments.panel(code)).toMatchObject({ confirmed: true, stale: false });
  };
  /** Every row still due overridden to 0 baht: rows remain, nothing is owed. */
  const zeroEveryone = async (code: string, ids: string[]) => {
    const due = ids.slice(0, 5);
    await billConfig(code, {
      absentIds: [ids[4]],
      removedIds: [ids[5]],
      overrides: due.map((playerId) => ({ playerId, amountSatang: 0 })),
    });
    const panel = await payments.panel(code);
    expect(panel.rows).toHaveLength(5);
    expect(panel.totalSatang).toBe(0);
  };
  const send = (code: string, sendId: string = randomUUID(), cookie = ownerCookie) =>
    request(server).post(`/sessions/${code}/payment-card/send`).set('Cookie', cookie).send({ sendId });
  const dm = (code: string, sendId: string = randomUUID(), cookie = ownerCookie) =>
    request(server).post(`/sessions/${code}/payment-card/dm`).set('Cookie', cookie).send({ sendId });
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
    it('lists the people still due sorted by name, with the bill amounts, and totals them', async () => {
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
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'th'));

      expect(panel.rows).toEqual(expected);
      // Thai collation, not the bill's roster order (สมชาย, มาلี, ต้อม, นิด, แดง): members scan for their own name.
      expect(panel.rows.map((r) => r.name)).toEqual(['แดง', 'ต้อม', 'นิด', 'มาลี', 'สมชาย']);
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
        lastDmAt: null,
        shareUrl: null,
      });
    });

    it('carries the card header texts (group name, Thai date, venue) exactly as the card prints them', async () => {
      const { code } = await setup();
      expect(await panelOf(code)).toMatchObject({ groupName: 'ตีชิล', date: '29 ต.ค. 2569', venue: 'Bad@Mama' });
      await prisma.session.update({ where: { code }, data: { venue: '   ', date: null } });
      // No venue reads as null; no date falls back to the day the session ended, in Bangkok time.
      expect(await panelOf(code)).toMatchObject({ venue: null, date: '29 ต.ค. 2569' });
    });

    it('breaks a tie between two same-named people by player id, so the order never moves between reads', async () => {
      const { code, ids } = await setup();
      await prisma.player.update({ where: { id: ids[0] }, data: { name: 'มาลี' } });
      const panel = await panelOf(code);
      const twins = panel.rows.filter((r) => r.name === 'มาลี').map((r) => r.playerId);
      expect(twins).toEqual([ids[0], ids[1]].sort());
      expect((await panelOf(code)).contentHash).toBe(panel.contentHash);
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
      // The credit covers everyone, so one person is set to owe by hand: a night of all-zero rows has nothing due.
      await billConfig(code, {
        absentIds: [ids[4]], removedIds: [ids[5]], overrides: [{ playerId: ids[0], amountSatang: 5000 }],
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
      expect((await confirm(code).expect(409)).body.code).toBe('PAYMENT_NOTHING_DUE');
    });

    it('treats a night where every listed amount is 0 as nothing to collect: rows show, confirm refuses', async () => {
      const { code, ids } = await setup();
      await zeroEveryone(code, ids);
      const panel = await panelOf(code);
      expect(panel).toMatchObject({ ready: true, totalSatang: 0 });
      expect(panel.rows.every((r) => r.amountSatang === 0)).toBe(true);
      expect((await confirm(code).expect(409)).body.code).toBe('PAYMENT_NOTHING_DUE');
      expect((await prisma.session.findUniqueOrThrow({ where: { code } })).paymentCard).toBeNull();
    });

    it('carries a content hash that moves with an amount and with the account', async () => {
      const { code, ids, groupCode } = await setup();
      const first = await panelOf(code);
      expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);
      // Read twice, unchanged: the same hash.
      expect((await panelOf(code)).contentHash).toBe(first.contentHash);

      const amount = first.rows.find((r) => r.playerId === ids[0])!.amountSatang;
      await billConfig(code, {
        absentIds: [ids[4]], removedIds: [ids[5]], overrides: [{ playerId: ids[0], amountSatang: amount + 100 }],
      });
      const second = await panelOf(code);
      expect(second.contentHash).not.toBe(first.contentHash);

      await prisma.group.update({ where: { code: groupCode }, data: { payAccount: JSON.stringify(TONIGHT) } });
      const third = await panelOf(code);
      expect(third.account).toEqual(TONIGHT);
      expect(third.contentHash).not.toBe(second.contentHash);

      // Confirmed and current: the panel's hash is the one stored with the confirm.
      await confirm(code).expect(200);
      const stored = parsePaymentState((await prisma.session.findUniqueOrThrow({ where: { code } })).paymentCard);
      expect((await panelOf(code)).contentHash).toBe(stored.confirmedHash);
    });

    it('does not depend on the LIFF id: the send-slip button is outside the hash, so confirmed stays current', async () => {
      const { code } = await setup();
      const withLiff = await panelOf(code);
      delete process.env.LINE_LIFF_ID;
      expect((await panelOf(code)).contentHash).toBe(withLiff.contentHash);
      await confirm(code).expect(200);
      const stored = parsePaymentState((await prisma.session.findUniqueOrThrow({ where: { code } })).paymentCard);
      process.env.LINE_LIFF_ID = LIFF_ID;
      const after = await panelOf(code);
      expect(after.contentHash).toBe(stored.confirmedHash);
      expect(after).toMatchObject({ confirmed: true, stale: false });
    });
  });

  describe('confirm', () => {
    it('confirms when the expected hash matches the amounts the panel shows', async () => {
      const { code } = await setup();
      const seen = await panelOf(code);
      const res = await confirm(code, { expectedHash: seen.contentHash }).expect(200);
      expect(res.body).toMatchObject({ confirmed: true, stale: false, contentHash: seen.contentHash });
    });

    it('refuses with PAYMENT_CHANGED and stores nothing when the bill moved between the read and the confirm', async () => {
      const { code, ids } = await setup();
      const seen = await panelOf(code);
      const amount = seen.rows.find((r) => r.playerId === ids[1])!.amountSatang;
      await billConfig(code, {
        absentIds: [ids[4]], removedIds: [ids[5]], overrides: [{ playerId: ids[1], amountSatang: amount + 500 }],
      });
      const res = await confirm(code, { expectedHash: seen.contentHash }).expect(409);
      expect(res.body.code).toBe('PAYMENT_CHANGED');
      expect((await prisma.session.findUniqueOrThrow({ where: { code } })).paymentCard).toBeNull();
      expect((await panelOf(code)).confirmed).toBe(false);
    });

    it('leaves an earlier confirm untouched when a re-confirm is refused as changed', async () => {
      const { code, ids } = await setup();
      await confirm(code).expect(200);
      const before = (await prisma.session.findUniqueOrThrow({ where: { code } })).paymentCard;
      const seen = await panelOf(code);
      await billConfig(code, { courtFeeSatang: 70000, absentIds: [ids[4]], removedIds: [ids[5]] });
      const res = await confirm(code, { ...TONIGHT, expectedHash: seen.contentHash }).expect(409);
      expect(res.body.code).toBe('PAYMENT_CHANGED');
      expect((await prisma.session.findUniqueOrThrow({ where: { code } })).paymentCard).toBe(before);
      expect(await panelOf(code)).toMatchObject({ confirmed: true, stale: true, account: ACCOUNT });
    });

    it('needs an expectedHash string from the body, through the global pipe', async () => {
      const { code } = await setup();
      const post = (body: object) =>
        request(server).post(`/sessions/${code}/payment-card/confirm`).set('Cookie', ownerCookie).send(body);
      await post({}).expect(400);
      await post({ expectedHash: '' }).expect(400);
      await post({ expectedHash: 42 }).expect(400);
      await post({ expectedHash: 'a'.repeat(200) }).expect(400);
      expect((await prisma.session.findUniqueOrThrow({ where: { code } })).paymentCard).toBeNull();
    });

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

    it('is stale after the group is renamed', async () => {
      const { code, groupCode } = await setup();
      await confirm(code).expect(200);
      await prisma.group.update({ where: { code: groupCode }, data: { name: 'ตีชิล ใหม่' } });
      expect((await panelOf(code)).stale).toBe(true);
    });

    it('is stale after the session date changes', async () => {
      const { code } = await setup();
      await confirm(code).expect(200);
      await prisma.session.update({ where: { code }, data: { date: '2026-10-30' } });
      expect((await panelOf(code)).stale).toBe(true);
    });

    it('is stale after the venue changes', async () => {
      const { code } = await setup();
      await confirm(code).expect(200);
      await prisma.session.update({ where: { code }, data: { venue: 'สนามใหม่' } });
      expect((await panelOf(code)).stale).toBe(true);
    });
  });

  describe('send', () => {
    it('posts the confirmed card to the linked group once, with the builder messages, and records the time', async () => {
      const { code, groupCode } = await setup();
      const panel = (await confirm(code).expect(200)).body as PaymentPanel;
      const sendId = randomUUID();
      expect((await send(code, sendId).expect(200)).body).toEqual({ outcome: 'sent' });
      const token = parsePaymentState((await prisma.session.findUniqueOrThrow({ where: { code } })).paymentCard).token!;

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
          'group',
          // LINE_LIFF_ID is set in beforeEach, so the card carries the send-slip button.
          liffSlipUrl(LIFF_ID, code, token)
        )
      );
      const after = await panelOf(code);
      expect(after.lastSentAt).not.toBeNull();
      expect(Date.now() - Date.parse(after.lastSentAt!)).toBeLessThan(60_000);
    });

    const slipButtons = (messages: unknown): Record<string, any>[] => {
      const found: Record<string, any>[] = [];
      const visit = (n: unknown): void => {
        if (Array.isArray(n)) return n.forEach(visit);
        if (n === null || typeof n !== 'object') return;
        const node = n as Record<string, any>;
        if (node.type === 'button' && node.action?.label === 'ส่งสลิป') found.push(node);
        Object.values(node).forEach(visit);
      };
      visit(messages);
      return found;
    };

    it('puts a send-slip button with the confirmed token on the posted card when the LIFF id is set', async () => {
      const { code } = await setup();
      await confirm(code).expect(200);
      const token = parsePaymentState((await prisma.session.findUniqueOrThrow({ where: { code } })).paymentCard).token!;
      await send(code).expect(200);
      const [, messages] = fakeClient.push.mock.calls[0];
      const buttons = slipButtons(messages);
      expect(buttons).toHaveLength(1);
      expect(buttons[0].action.uri).toBe(`https://liff.line.me/${LIFF_ID}/slip/${code}/${token}`);
      // Copy button first, slip button after it.
      const footer = messages[0].contents.footer.contents;
      expect(footer).toHaveLength(2);
      expect(footer[0].action.type).toBe('clipboard');
      expect(footer[1]).toBe(buttons[0]);
    });

    it('posts the card without a send-slip button when the LIFF id is not set', async () => {
      const { code } = await setup();
      await confirm(code).expect(200);
      delete process.env.LINE_LIFF_ID;
      expect((await send(code).expect(200)).body).toEqual({ outcome: 'sent' });
      const [, messages] = fakeClient.push.mock.calls[0];
      expect(slipButtons(messages)).toHaveLength(0);
      expect(messages[0].contents.footer.contents).toHaveLength(1);
    });

    it('posts the card without a send-slip button when the LINE Login channel id is not set', async () => {
      // The pay page could not verify anyone, so every tap would end on "link no longer works".
      const { code } = await setup();
      await confirm(code).expect(200);
      delete process.env.LINE_LOGIN_CHANNEL_ID;
      expect((await send(code).expect(200)).body).toEqual({ outcome: 'sent' });
      const [, messages] = fakeClient.push.mock.calls[0];
      expect(slipButtons(messages)).toHaveLength(0);
      expect(messages[0].contents.footer.contents).toHaveLength(1);
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

    it('still answers sent when LINE took the card but saving the send time failed', async () => {
      const { code } = await setup();
      await confirm(code).expect(200);
      const update = vi.spyOn(prisma.session, 'update').mockRejectedValueOnce(new Error('database is locked'));
      try {
        expect((await send(code).expect(200)).body).toEqual({ outcome: 'sent' });
      } finally {
        update.mockRestore();
      }
      expect(fakeClient.push).toHaveBeenCalledTimes(1);
      expect((await panelOf(code)).lastSentAt).toBeNull();
    });

    it('is unavailable when every listed amount is 0, even on a confirmed and current card', async () => {
      const { code, ids } = await setup();
      await zeroEveryone(code, ids);
      await storeConfirmed(code);
      expect((await send(code).expect(200)).body).toEqual({ outcome: 'unavailable' });
      expect(fakeClient.push).not.toHaveBeenCalled();
    });

    it('sends nothing while an amount is undefined, even on a confirmed and current card', async () => {
      const { code, ids } = await setup();
      await billConfig(code, { courtFeeSatang: null, absentIds: [ids[4]], removedIds: [ids[5]] });
      await storeConfirmed(code);
      expect((await panelOf(code)).ready).toBe(false);
      expect((await send(code).expect(200)).body).toEqual({ outcome: 'stale' });
      expect(fakeClient.push).not.toHaveBeenCalled();
    });

    it('answers stale, not unavailable, on a not-ready night whose provisional total is 0', async () => {
      const { code, ids } = await setup();
      // No court fee and no shuttle price: the engine reads both as 0, so every provisional amount is 0.
      await prisma.session.update({ where: { code }, data: { shuttlePriceSatang: null } });
      await billConfig(code, { courtFeeSatang: null, absentIds: [ids[4]], removedIds: [ids[5]] });
      const panel = await payments.panel(code);
      expect(panel).toMatchObject({ ready: false, totalSatang: 0 });
      expect(panel.rows.length).toBeGreaterThan(0);
      expect((await confirm(code).expect(409)).body.code).toBe('PAYMENT_NOT_READY');
      await storeConfirmed(code);
      expect((await send(code).expect(200)).body).toEqual({ outcome: 'stale' });
      expect(fakeClient.push).not.toHaveBeenCalled();
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

  describe('sendToHost', () => {
    const confirmedHost = async () => {
      const made = await setup({ target: 'host' });
      const panel = (await confirm(made.code).expect(200)).body as PaymentPanel;
      return { ...made, panel };
    };

    it('pushes once to the owner with one Flex card whose "ส่งเข้ากลุ่ม" button opens the share link, and records the time', async () => {
      const { code, panel } = await confirmedHost();
      expect(panel.shareUrl).not.toBeNull();
      const sendId = randomUUID();
      expect((await dm(code, sendId).expect(200)).body).toEqual({ outcome: 'sent' });

      expect(fakeClient.push).toHaveBeenCalledTimes(1);
      const [to, messages, retryKey] = fakeClient.push.mock.calls[0];
      expect(to).toBe(`U${ownerId.replace(/-/g, '')}`);
      expect(retryKey).toBe(paymentDmRetryKey(code, sendId));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ type: 'flex' });
      expect(messages).toEqual(
        paymentDmMessages(
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
          panel.shareUrl!
        )
      );
      const footer = (messages[0] as { contents: { footer: { contents: { style: string; action: object }[] } } })
        .contents.footer.contents;
      // The forward button leads the DM card's footer (after its muted not-in-the-group line).
      expect(footer[1]).toEqual({
        type: 'button',
        style: 'primary',
        color: '#1f6b3d',
        action: { type: 'uri', label: 'ส่งเข้ากลุ่ม', uri: panel.shareUrl },
      });
      const after = await panelOf(code);
      expect(after.lastDmAt).not.toBeNull();
      expect(Date.now() - Date.parse(after.lastDmAt!)).toBeLessThan(60_000);
      expect(after.lastSentAt).toBeNull();
    });

    it('is unavailable for the group target and pushes nothing', async () => {
      const { code } = await setup();
      await confirm(code).expect(200);
      expect((await dm(code).expect(200)).body).toEqual({ outcome: 'unavailable' });
      expect(fakeClient.push).not.toHaveBeenCalled();
    });

    it('refuses before a confirm', async () => {
      const { code } = await setup({ target: 'host' });
      expect((await dm(code).expect(200)).body).toEqual({ outcome: 'not-confirmed' });
      expect(fakeClient.push).not.toHaveBeenCalled();
    });

    it('is stale after a bill edit since the confirm', async () => {
      const { code, ids } = await confirmedHost();
      await billConfig(code, { courtFeeSatang: 70000, absentIds: [ids[4]], removedIds: [ids[5]] });
      expect((await dm(code).expect(200)).body).toEqual({ outcome: 'stale' });
      expect(fakeClient.push).not.toHaveBeenCalled();
    });

    it('is stale, not unavailable, while an amount is undefined on a confirmed card', async () => {
      const { code, ids } = await setup({ target: 'host' });
      await billConfig(code, { courtFeeSatang: null, absentIds: [ids[4]], removedIds: [ids[5]] });
      await storeConfirmed(code);
      expect((await dm(code).expect(200)).body).toEqual({ outcome: 'stale' });
      expect(fakeClient.push).not.toHaveBeenCalled();
    });

    it('is unavailable when every listed amount is 0', async () => {
      const { code, ids } = await setup({ target: 'host' });
      await zeroEveryone(code, ids);
      await storeConfirmed(code);
      expect((await dm(code).expect(200)).body).toEqual({ outcome: 'unavailable' });
      expect(fakeClient.push).not.toHaveBeenCalled();
    });

    it('is unavailable when the owner unlinks their LINE account or the plan lapses', async () => {
      const { code } = await confirmedHost();
      await prisma.user.update({ where: { id: ownerId }, data: { lineUserId: null } });
      expect((await dm(code).expect(200)).body).toEqual({ outcome: 'unavailable' });
      await prisma.user.update({
        where: { id: ownerId },
        data: { lineUserId: `U${ownerId.replace(/-/g, '')}`, planRenewsAt: new Date(Date.now() - 86_400_000) },
      });
      expect((await dm(code).expect(200)).body).toEqual({ outcome: 'unavailable' });
      expect(fakeClient.push).not.toHaveBeenCalled();
    });

    it('is unavailable when the share link is not offered (no LIFF id), even on a current confirmed card', async () => {
      const { code } = await confirmedHost();
      delete process.env.LINE_LIFF_ID;
      expect((await panelOf(code)).shareUrl).toBeNull();
      expect((await dm(code).expect(200)).body).toEqual({ outcome: 'unavailable' });
      expect(fakeClient.push).not.toHaveBeenCalled();
    });

    it('is busy within 5 seconds and a deliberate resend after goes out', async () => {
      const { code } = await confirmedHost();
      const t0 = new Date();
      const at = (ms: number) => new Date(t0.getTime() + ms);
      expect(await payments.sendToHost(code, randomUUID(), t0)).toBe('sent');
      expect(await payments.sendToHost(code, randomUUID(), at(4_999))).toBe('busy');
      expect(fakeClient.push).toHaveBeenCalledTimes(1);
      expect(await payments.sendToHost(code, randomUUID(), at(5_000))).toBe('sent');
      expect(fakeClient.push).toHaveBeenCalledTimes(2);
    });

    it('passes quota and failed through and leaves the DM time unset', async () => {
      const { code } = await confirmedHost();
      fakeClient.push.mockResolvedValueOnce('quota');
      expect((await dm(code).expect(200)).body).toEqual({ outcome: 'quota' });
      fakeClient.push.mockResolvedValueOnce('failed');
      expect((await dm(code).expect(200)).body).toEqual({ outcome: 'failed' });
      fakeClient.push.mockRejectedValueOnce(new Error('boom'));
      expect((await dm(code).expect(200)).body).toEqual({ outcome: 'failed' });
      expect((await panelOf(code)).lastDmAt).toBeNull();
      expect(fakeClient.push).toHaveBeenCalledTimes(3);
    });

    it('still answers sent when LINE took the card but saving the DM time failed', async () => {
      const { code } = await confirmedHost();
      const update = vi.spyOn(prisma.session, 'update').mockRejectedValueOnce(new Error('database is locked'));
      try {
        expect((await dm(code).expect(200)).body).toEqual({ outcome: 'sent' });
      } finally {
        update.mockRestore();
      }
      expect(fakeClient.push).toHaveBeenCalledTimes(1);
      expect((await panelOf(code)).lastDmAt).toBeNull();
    });

    it('keeps the group send time and the DM time apart', async () => {
      const { code } = await confirmedHost();
      await dm(code).expect(200);
      const state = parsePaymentState((await prisma.session.findUniqueOrThrow({ where: { code } })).paymentCard);
      expect(state.lastDmAt).not.toBeNull();
      expect(state.lastSentAt).toBeNull();
    });

    it('keeps the DM time across a re-confirm', async () => {
      const { code } = await confirmedHost();
      await dm(code).expect(200);
      await confirm(code).expect(200);
      expect((await panelOf(code)).lastDmAt).not.toBeNull();
    });

    it('pins the DM retry key construction and keeps it apart from the group key', () => {
      const key = paymentDmRetryKey('abc12345', '00000000-0000-4000-8000-000000000001');
      expect(key).toBe('69bbb6df-12c9-5351-a44f-efebb649a19c');
      expect(key).not.toBe(paymentRetryKey('abc12345', '00000000-0000-4000-8000-000000000001'));
    });

    it('needs a UUID sendId from the body, through the global pipe', async () => {
      const { code } = await confirmedHost();
      const post = (body: object) =>
        request(server).post(`/sessions/${code}/payment-card/dm`).set('Cookie', ownerCookie).send(body);
      await post({ sendId: 'not-a-uuid' }).expect(400);
      await post({}).expect(400);
      await post({ sendId: 42 }).expect(400);
      expect(fakeClient.push).not.toHaveBeenCalled();
    });

    it('answers 404 to another host and 401 to no login', async () => {
      const { code } = await confirmedHost();
      await dm(code, randomUUID(), otherCookie).expect(404);
      await request(server).post(`/sessions/${code}/payment-card/dm`).send({ sendId: randomUUID() }).expect(401);
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

describe('isReady', () => {
  it('is ready with no warnings or only informational ones', () => {
    expect(isReady([])).toBe(true);
    expect(isReady(['EXCESS_CREDIT'])).toBe(true);
    expect(isReady(['EXCESS_CREDIT', 'UNCOVERED_COST', 'UNRETURNED_SURCHARGE'])).toBe(true);
  });

  it('blocks on a missing input, alone or next to a notice', () => {
    expect(isReady(['MISSING_COURT_FEE'])).toBe(false);
    expect(isReady(['EXCESS_CREDIT', 'MISSING_SHUTTLE_PRICE'])).toBe(false);
    expect(isReady(['UNKNOWN_SHUTTLE_USE'])).toBe(false);
  });

  it('blocks on a warning code it does not know', () => {
    expect(isReady(['SOME_FUTURE_WARNING'])).toBe(false);
    expect(isReady(['EXCESS_CREDIT', 'SOME_FUTURE_WARNING'])).toBe(false);
  });
});
