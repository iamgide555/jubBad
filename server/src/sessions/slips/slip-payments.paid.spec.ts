import { randomUUID } from 'node:crypto';
import { ConflictException, INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../app.module.js';
import { AuthBootstrapService } from '../../auth/bootstrap.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { BillService } from '../bill.service.js';
import { newShareToken, serializePaymentState } from '../payment-card-state.js';
import { PaymentCardService } from '../payment-card.service.js';
import { SlipPaymentsService } from './slip-payments.service.js';

const ACCOUNT = { bank: 'กสิกร', number: '123-4-56789-0', name: 'สมหญิง ใจดี' };
const NAMES = ['สมชาย', 'มาลี', 'ต้อม', 'นิด'];

describe('slip payments: paid state, manual tick, token check', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cards: PaymentCardService;
  let bills: BillService;
  let paid: SlipPaymentsService;
  const groupCodes: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuthBootstrapService)
      .useValue({ onModuleInit: async () => {} })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    cards = app.get(PaymentCardService);
    bills = app.get(BillService);
    paid = app.get(SlipPaymentsService);
  });

  afterAll(async () => {
    const where = { session: { groupId: { in: groupCodes } } };
    await prisma.sessionPayment.deleteMany({ where });
    await prisma.pairing.deleteMany({ where });
    await prisma.sessionRoster.deleteMany({ where });
    await prisma.session.deleteMany({ where: { groupId: { in: groupCodes } } });
    await prisma.player.deleteMany({ where: { groupId: { in: groupCodes } } });
    await prisma.group.deleteMany({ where: { code: { in: groupCodes } } });
    await app.close();
  });

  const configure = (code: string, over: object = {}) =>
    bills.setBillConfig(code, {
      model: 'fair', courtFeeSatang: 60000, courtSplit: 'equal', shuttleSplit: 'byGames',
      perGameRateSatang: 0, entryFeeSatang: 0, capSatang: null, buffetPriceSatang: 0,
      buffetShuttlesIncluded: true, startingFeeSatang: 0, hostFeeSatang: 0, walkInFeeSatang: 0, roundingBaht: 1,
      addedIds: [], removedIds: [], overrides: [], ...over,
    } as never);

  /** Four players who played one game, an ended session with a bill; confirmed unless `confirmed` is false. */
  async function setup(options: { confirmed?: boolean } = {}) {
    const { confirmed = true } = options;
    const groupCode = `slp-${randomUUID().slice(0, 10)}`;
    groupCodes.push(groupCode);
    await prisma.group.create({ data: { code: groupCode, name: 'ตีชิล', payAccount: JSON.stringify(ACCOUNT) } });
    const ids: string[] = [];
    for (const name of NAMES) {
      ids.push((await prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })).id);
    }
    const code = `s${randomUUID().slice(0, 8)}`;
    await prisma.session.create({
      data: {
        code, groupId: groupCode, rawImportText: '', date: '2026-10-30', venue: 'Bad@Mama',
        shuttleCount: 3, shuttlePriceSatang: 8000,
      },
    });
    for (const id of ids) await prisma.sessionRoster.create({ data: { sessionId: code, playerId: id } });
    const at = new Date('2026-10-30T13:00:00Z');
    await prisma.pairing.create({
      data: {
        sessionId: code, courtNumber: 1, matchNumber: 1,
        teamA: JSON.stringify(ids.slice(0, 2)), teamB: JSON.stringify(ids.slice(2)),
        winner: 'A', confirmedAt: at, endedAt: at,
      },
    });
    await configure(code);
    await prisma.session.update({ where: { code }, data: { endedAt: new Date('2026-10-30T15:00:00Z') } });
    let token: string | null = null;
    if (confirmed) {
      token = newShareToken();
      const panel = await cards.panel(code);
      await prisma.session.update({
        where: { code },
        data: {
          paymentCard: serializePaymentState({
            account: panel.account, token, confirmedAt: new Date().toISOString(),
            confirmedHash: panel.contentHash, lastSentAt: null, lastDmAt: null,
          }),
        },
      });
      expect(await cards.panel(code)).toMatchObject({ confirmed: true, stale: false });
    }
    return { code, ids, token };
  }

  describe('PaymentCardService.tokenValid', () => {
    it('is true only for the confirmed card token', async () => {
      const { code, token } = await setup();
      expect(await cards.tokenValid(code, token!)).toBe(true);
      expect(await cards.tokenValid(code, 'not-the-token')).toBe(false);
      expect(await cards.tokenValid(code, undefined)).toBe(false);
      expect(await cards.tokenValid(code, '')).toBe(false);
    });

    it('is false for an unconfirmed session and for an unknown code, without throwing', async () => {
      const { code } = await setup({ confirmed: false });
      expect(await cards.tokenValid(code, 'anything')).toBe(false);
      expect(await cards.tokenValid('no-such-session', 'anything')).toBe(false);
    });
  });

  describe('host tick', () => {
    it('marks a player paid with source host', async () => {
      const { code, ids } = await setup();
      expect(await paid.getPaid(code)).toEqual([]);
      await paid.tick(code, ids[0]);
      const rows = await paid.getPaid(code);
      expect(rows).toEqual([
        { playerId: ids[0], source: 'host', at: expect.any(String), amountChangedSince: false },
      ]);
      expect(new Date(rows[0].at).toISOString()).toBe(rows[0].at);
    });

    it('leaves one row when ticked twice', async () => {
      const { code, ids } = await setup();
      await paid.tick(code, ids[1]);
      await paid.tick(code, ids[1]);
      expect(await paid.getPaid(code)).toHaveLength(1);
      expect(await prisma.sessionPayment.count({ where: { sessionId: code } })).toBe(1);
    });

    it('does not overwrite an existing slip payment', async () => {
      const { code, ids } = await setup();
      await prisma.sessionPayment.create({
        data: { sessionId: code, playerId: ids[0], source: 'slip', amountSatang: 17200, reference: 'REF1' },
      });
      await paid.tick(code, ids[0]);
      expect(await paid.getPaid(code)).toMatchObject([{ playerId: ids[0], source: 'slip' }]);
    });

    it('untick removes the mark and is idempotent', async () => {
      const { code, ids } = await setup();
      await paid.tick(code, ids[0]);
      await paid.untick(code, ids[0]);
      expect(await paid.getPaid(code)).toEqual([]);
      await expect(paid.untick(code, ids[0])).resolves.toBeUndefined();
    });

    it('refuses a player who is not on the bill', async () => {
      const { code } = await setup();
      const stranger = await prisma.player.create({
        data: { groupId: (await prisma.session.findUniqueOrThrow({ where: { code } })).groupId, name: 'คนนอก', aliases: '[]' },
      });
      const error = await paid.tick(code, stranger.id).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'PLAYER_NOT_ON_BILL' });
      expect(await paid.getPaid(code)).toEqual([]);
    });

    it('throws NotFound for an unknown session code', async () => {
      await expect(paid.getPaid('no-such-session')).rejects.toBeInstanceOf(NotFoundException);
      await expect(paid.tick('no-such-session', 'x')).rejects.toBeInstanceOf(NotFoundException);
      await expect(paid.untick('no-such-session', 'x')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('amount changed since a slip', () => {
    it('flags a slip-paid row whose bill amount moved, and keeps the row', async () => {
      const { code, ids } = await setup();
      await prisma.sessionPayment.create({
        data: { sessionId: code, playerId: ids[0], source: 'slip', amountSatang: 17200, reference: 'REF1' },
      });
      await configure(code, { overrides: [{ playerId: ids[0], amountSatang: 17200 }] });
      expect(await paid.getPaid(code)).toMatchObject([{ playerId: ids[0], source: 'slip', amountChangedSince: false }]);

      await configure(code, { overrides: [{ playerId: ids[0], amountSatang: 18000 }] });
      const panel = await cards.panel(code);
      expect(panel.rows.find((r) => r.playerId === ids[0])!.amountSatang).toBe(18000);
      expect(await paid.getPaid(code)).toMatchObject([{ playerId: ids[0], source: 'slip', amountChangedSince: true }]);
      expect(await prisma.sessionPayment.count({ where: { sessionId: code } })).toBe(1);
    });

    it('never flags a host tick, which stores no amount', async () => {
      const { code, ids } = await setup();
      await paid.tick(code, ids[0]);
      await configure(code, { overrides: [{ playerId: ids[0], amountSatang: 18000 }] });
      expect(await paid.getPaid(code)).toMatchObject([{ playerId: ids[0], source: 'host', amountChangedSince: false }]);
    });
  });
});
