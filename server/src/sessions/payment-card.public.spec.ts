import { randomUUID } from 'node:crypto';
import { INestApplication, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { SESSION_SECRET } from '../auth/auth.module.js';
import { AuthBootstrapService } from '../auth/bootstrap.service.js';
import { LineClient } from '../line/line-client.js';
import { liffPayUrl, liffSlipUrl, paymentCardMessages } from '../line/payment-card.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from '../users/users.service.js';
import { newShareToken, parsePaymentState, serializePaymentState } from './payment-card-state.js';
import { PaymentCardService, type PaymentPanel } from './payment-card.service.js';

const SECRET = 'payment-share-test-secret';
const PASSWORD = 'a genuinely correct password';
const LIFF_ID = '2001234567-AbCdEfGh';
const ACCOUNT = { bank: 'กสิกร', number: '123-4-56789-0', name: 'สมหญิง ใจดี' };
const NAMES = ['สมชาย', 'มาลี', 'ต้อม', 'นิด'];

describe('GET /sessions/:code/payment-share-card (public, token-gated)', () => {
  const saved = { ...process.env };
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let prisma: PrismaService;
  let payments: PaymentCardService;
  let ownerId: string;
  let ownerEmail: string;
  let ownerCookie: string;
  const groupCodes: string[] = [];
  const fakeClient = {
    reply: vi.fn(),
    replyMessages: vi.fn(),
    groupName: vi.fn(),
    memberName: vi.fn(),
    leave: vi.fn(),
    push: vi.fn(),
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
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    server = app.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    prisma = app.get(PrismaService);
    payments = app.get(PaymentCardService);

    ownerEmail = `pay-share-${randomUUID()}@example.test`;
    ownerId = (await app.get(UsersService).create(ownerEmail, PASSWORD)).id;
    const res = await request(server).post('/auth/login').send({ email: ownerEmail, password: PASSWORD }).expect(201);
    ownerCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0];
  });

  afterAll(async () => {
    const where = { session: { groupId: { in: groupCodes } } };
    await prisma.pairing.deleteMany({ where });
    await prisma.sessionRoster.deleteMany({ where });
    await prisma.session.deleteMany({ where: { groupId: { in: groupCodes } } });
    await prisma.player.deleteMany({ where: { groupId: { in: groupCodes } } });
    await prisma.group.deleteMany({ where: { code: { in: groupCodes } } });
    await prisma.user.deleteMany({ where: { id: ownerId } });
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
    await prisma.user.update({
      where: { id: ownerId },
      data: { plan: 'host', planRenewsAt: null, lineUserId: `U${ownerId.replace(/-/g, '')}` },
    });
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  /** Confirms as the panel would, with the content hash of a fresh read. */
  const confirm = async (code: string) => {
    const { contentHash } = await payments.panel(code);
    return request(server)
      .post(`/sessions/${code}/payment-card/confirm`)
      .set('Cookie', ownerCookie)
      .send({ expectedHash: contentHash })
      .expect(200);
  };
  /** Stores a confirm of exactly what the panel shows now, past the confirm route's own refusals. */
  const storeConfirmed = async (code: string) => {
    const panel = await payments.panel(code);
    const token = newShareToken();
    await prisma.session.update({
      where: { code },
      data: {
        paymentCard: serializePaymentState({
          account: panel.account,
          token,
          confirmedAt: new Date().toISOString(),
          confirmedHash: panel.contentHash,
          lastSentAt: null,
        }),
      },
    });
    expect(await payments.panel(code)).toMatchObject({ confirmed: true, stale: false, shareUrl: null });
    return token;
  };
  const tokenOf = async (code: string) =>
    parsePaymentState((await prisma.session.findUniqueOrThrow({ where: { code } })).paymentCard).token!;
  const share = (code: string, query = '') => request(server).get(`/sessions/${code}/payment-share-card${query}`);
  const fairBill = (code: string, courtFeeSatang: number) =>
    request(server)
      .post(`/sessions/${code}/bill-config`)
      .set('Cookie', ownerCookie)
      .send({
        model: 'fair', courtFeeSatang, courtSplit: 'equal', shuttleSplit: 'byGames',
        perGameRateSatang: 0, entryFeeSatang: 0, capSatang: null, buffetPriceSatang: 0,
        buffetShuttlesIncluded: true, startingFeeSatang: 0, hostFeeSatang: 0, walkInFeeSatang: 0, roundingBaht: 1,
        addedIds: [], removedIds: [], overrides: [],
      })
      .expect(201);

  /** An ended session of one finished game over four players, ready to bill, on a `host` (default) or `group` target. */
  async function setup(target: 'host' | 'group' = 'host') {
    const groupCode = `pshare-${randomUUID().slice(0, 10)}`;
    groupCodes.push(groupCode);
    const shareToken = randomUUID().replace(/-/g, '').slice(0, 22);
    await prisma.group.create({
      data: {
        code: groupCode,
        name: 'ตีชิล',
        ownerId,
        shareToken,
        lineGroupId: target === 'group' ? `C${randomUUID().replace(/-/g, '')}` : null,
        lineDmEnabled: target === 'host',
        payAccount: JSON.stringify(ACCOUNT),
      },
    });
    const ids: string[] = [];
    for (const name of NAMES) {
      ids.push((await prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })).id);
    }
    const code = `q${randomUUID().slice(0, 8)}`;
    await prisma.session.create({
      data: {
        code, groupId: groupCode, rawImportText: '', date: '2026-10-29', venue: 'Bad@Mama',
        shuttleCount: 2, shuttlePriceSatang: 8000,
      },
    });
    for (const id of ids) await prisma.sessionRoster.create({ data: { sessionId: code, playerId: id } });
    const at = new Date('2026-10-29T13:00:00Z');
    await prisma.pairing.create({
      data: {
        sessionId: code, courtNumber: 1, matchNumber: 1,
        teamA: JSON.stringify(ids.slice(0, 2)), teamB: JSON.stringify(ids.slice(2)),
        winner: 'A', confirmedAt: at, endedAt: at,
      },
    });
    await fairBill(code, 61700);
    await prisma.session.update({ where: { code }, data: { endedAt: new Date('2026-10-29T15:00:00Z') } });
    return { code, groupCode, shareToken, ids };
  }

  it('serves only the LIFF id, the host-target messages and a preview to an anonymous caller with the token', async () => {
    const { code, groupCode } = await setup();
    const panel = (await confirm(code)).body as PaymentPanel;
    const token = await tokenOf(code);
    expect(panel.shareUrl).toBe(liffPayUrl(LIFF_ID, code, token));

    const res = await share(code, `?token=${encodeURIComponent(token)}`).expect(200);
    expect(Object.keys(res.body)).toEqual(['liffId', 'messages', 'preview']);
    expect(res.body.liffId).toBe(LIFF_ID);
    expect(res.body.messages).toEqual(
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
        'host',
        liffSlipUrl(LIFF_ID, code, token)
      )
    );
    expect(JSON.stringify(res.body.messages)).toContain('ส่งสลิป');
    expect(res.body.preview).toEqual({
      name: 'ตีชิล',
      date: '29 ต.ค. 2569',
      count: 4,
      totalSatang: panel.totalSatang,
      bank: ACCOUNT.bank,
      accountName: ACCOUNT.name,
    });
    // The account number is the card's whole point; nothing else private comes with it.
    expect(res.text).toContain(ACCOUNT.number);
    // The token is in the response on purpose now: it is the send-slip button's link, and the caller supplied it.
    for (const secret of [groupCode, ownerId, ownerEmail, 'lineUserId', 'confirmedHash', 'paymentCard', 'playerId']) {
      expect(res.text).not.toContain(secret);
    }
  });

  it('serves the card without the send-slip button when the LINE Login channel id is not set', async () => {
    const { code } = await setup();
    await confirm(code);
    const token = await tokenOf(code);
    delete process.env.LINE_LOGIN_CHANNEL_ID;
    const res = await share(code, `?token=${encodeURIComponent(token)}`).expect(200);
    expect(JSON.stringify(res.body.messages)).not.toContain('ส่งสลิป');
    expect(JSON.stringify(res.body.messages)).not.toContain('/slip/');
  });

  it('kills the old token on a re-confirm and serves the new one', async () => {
    const { code } = await setup();
    await confirm(code);
    const old = await tokenOf(code);
    await confirm(code);
    const fresh = await tokenOf(code);
    expect(fresh).not.toBe(old);
    await share(code, `?token=${old}`).expect(404);
    await share(code, `?token=${fresh}`).expect(200);
  });

  describe('answers every failure with the same 404', () => {
    let baseline: { status: number; body: unknown };

    beforeEach(async () => {
      const res = await share('nope-no-such-session', '?token=whatever');
      baseline = { status: res.status, body: res.body };
      expect(baseline.status).toBe(404);
    });

    const expectSame404 = async (code: string, query: string) => {
      const res = await share(code, query);
      expect({ status: res.status, body: res.body }).toEqual(baseline);
      await expect(payments.shareCard(code, new URLSearchParams(query).get('token') ?? undefined)).rejects.toBeInstanceOf(
        NotFoundException
      );
    };

    it('a wrong token of the same length, of another length, or none at all', async () => {
      const { code } = await setup();
      await confirm(code);
      const token = await tokenOf(code);
      const flipped = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
      await expectSame404(code, `?token=${flipped}`);
      await expectSame404(code, `?token=${token}x`);
      await expectSame404(code, `?token=${token.slice(0, 5)}`);
      await expectSame404(code, '?token=');
      await expectSame404(code, '');
      // A repeated parameter arrives as an array: never a token, even with the right value in it.
      const res = await share(code, `?token=${token}&token=${token}`);
      expect({ status: res.status, body: res.body }).toEqual(baseline);
    });

    it("another session's token", async () => {
      const one = await setup();
      const two = await setup();
      await confirm(one.code);
      await confirm(two.code);
      await expectSame404(one.code, `?token=${await tokenOf(two.code)}`);
    });

    it('a group-target session, even with its own token', async () => {
      const { code } = await setup('group');
      await confirm(code);
      await expectSame404(code, `?token=${await tokenOf(code)}`);
    });

    it('a session that was never confirmed', async () => {
      const { code } = await setup();
      await expectSame404(code, '?token=AAAAAAAAAAAAAAAAAAAAAA');
    });

    it('a card whose bill changed since the confirm', async () => {
      const { code } = await setup();
      await confirm(code);
      const token = await tokenOf(code);
      await fairBill(code, 80000);
      await expectSame404(code, `?token=${token}`);
    });

    it('a confirmed, current card on which every listed amount is 0', async () => {
      const { code, ids } = await setup();
      await request(server)
        .post(`/sessions/${code}/bill-config`)
        .set('Cookie', ownerCookie)
        .send({
          model: 'fair', courtFeeSatang: 61700, courtSplit: 'equal', shuttleSplit: 'byGames',
          perGameRateSatang: 0, entryFeeSatang: 0, capSatang: null, buffetPriceSatang: 0,
          buffetShuttlesIncluded: true, startingFeeSatang: 0, hostFeeSatang: 0, walkInFeeSatang: 0, roundingBaht: 1,
          addedIds: [], removedIds: [], overrides: ids.map((playerId) => ({ playerId, amountSatang: 0 })),
        })
        .expect(201);
      const panel = await payments.panel(code);
      expect(panel.rows.length).toBeGreaterThan(0);
      expect(panel.totalSatang).toBe(0);
      const token = await storeConfirmed(code);
      await expectSame404(code, `?token=${token}`);
    });

    it('a confirmed, current card while an amount is undefined', async () => {
      const { code } = await setup();
      await prisma.session.update({ where: { code }, data: { shuttlePriceSatang: null } });
      expect((await payments.panel(code)).ready).toBe(false);
      const token = await storeConfirmed(code);
      await expectSame404(code, `?token=${token}`);
    });

    it('a session that does not exist', async () => {
      await expectSame404('nope-no-such-session', '?token=AAAAAAAAAAAAAAAAAAAAAA');
    });

    it('a session no longer ended', async () => {
      const { code } = await setup();
      await confirm(code);
      const token = await tokenOf(code);
      await prisma.session.update({ where: { code }, data: { endedAt: null } });
      await expectSame404(code, `?token=${token}`);
    });

    it('a lapsed plan or the DM switch turned off', async () => {
      const { code, groupCode } = await setup();
      await confirm(code);
      const token = await tokenOf(code);
      await prisma.user.update({ where: { id: ownerId }, data: { plan: 'free' } });
      await expectSame404(code, `?token=${token}`);
      await prisma.user.update({ where: { id: ownerId }, data: { plan: 'host' } });
      await share(code, `?token=${token}`).expect(200);
      await prisma.group.update({ where: { code: groupCode }, data: { lineDmEnabled: false } });
      await expectSame404(code, `?token=${token}`);
    });

    it('the LIFF id or the public url unset, without a database lookup', async () => {
      const { code } = await setup();
      await confirm(code);
      const token = await tokenOf(code);
      delete process.env.LINE_LIFF_ID;
      const lookup = vi.spyOn(prisma.session, 'findUnique');
      try {
        await expectSame404(code, `?token=${token}`);
        expect(lookup).not.toHaveBeenCalled();
      } finally {
        lookup.mockRestore();
      }
      process.env.LINE_LIFF_ID = LIFF_ID;
      delete process.env.PUBLIC_APP_URL;
      await expectSame404(code, `?token=${token}`);
    });
  });

  it('adds no amount, account or token to the public summary, display feed, group dashboard or export', async () => {
    const { code, groupCode, shareToken } = await setup();
    await confirm(code);
    const token = await tokenOf(code);

    const display = await request(server).get(`/sessions/${code}`).expect(200);
    const summary = await request(server).get(`/sessions/${code}/summary`).expect(200);
    const dashboard = await request(server).get(`/dashboards/${shareToken}`).expect(200);
    const exported = await request(server).get(`/groups/${groupCode}/export`).set('Cookie', ownerCookie).expect(200);

    for (const res of [display, summary, dashboard, exported]) {
      const json = JSON.stringify(res.body);
      for (const secret of [ACCOUNT.number, '1234567890', ACCOUNT.name, token, 'paymentCard', 'payAccount']) {
        expect(json).not.toContain(secret);
      }
    }
    // Money never reaches the public reads at all (the owner's export is not public, so it is left out here).
    for (const res of [display, summary, dashboard]) {
      const json = JSON.stringify(res.body);
      for (const money of ['amountSatang', 'totalSatang', 'stillDue', '฿']) expect(json).not.toContain(money);
    }
  });
});
