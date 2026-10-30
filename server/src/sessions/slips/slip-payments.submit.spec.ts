import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import { ENDED_AT, slipDateLine } from '../../../test/slip-http.fixture.js';
import { AppModule } from '../../app.module.js';
import { AuthBootstrapService } from '../../auth/bootstrap.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { BillService } from '../bill.service.js';
import { newShareToken, serializePaymentState } from '../payment-card-state.js';
import { PaymentCardService } from '../payment-card.service.js';
import type { OcrLine } from './slip-match.js';
import { SlipPaymentsService, type LiffUser } from './slip-payments.service.js';
import { SlipReader, type SlipRead } from './slip-reader.js';

const ACCOUNT = { bank: 'กสิกร', number: '123-4-56789-0', name: 'สมหญิง ใจดี' };
const RECEIVER = 'น.ส. สมหญิง ใจดี';
const SENDER = 'นาย ทดสอบ ผู้โอน';
const NAMES = ['สมชาย', 'มาลี', 'ต้อม', 'นิด'];
/** Printed on every fake slip, so a test can prove no OCR text reached a stored row. */
const OCR_MARKER = 'OCRMARKER โอนเงินสำเร็จ';
const IMAGE = Buffer.from('fake image bytes');

const baht = (satang: number) =>
  `${Math.floor(satang / 100).toLocaleString('en-US')}.${String(satang % 100).padStart(2, '0')}`;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * A slip the way OCR reads it: a header, the date line, the sender block above, the receiver block below, then the
 * amount. Made an hour before the session ended unless `madeAt` says otherwise; `date: null` leaves no date line.
 */
function slip(
  reference: string,
  options: {
    amount?: string | null; sender?: string; receiver?: string; extra?: string[]; madeAt?: Date; date?: string | null;
  } = {}
): SlipRead {
  const { amount = null, sender = SENDER, receiver = RECEIVER, extra = [], madeAt = new Date(ENDED_AT.getTime() - HOUR) } =
    options;
  const date = options.date === undefined ? slipDateLine(madeAt) : options.date;
  const texts = [
    OCR_MARKER,
    ...(date === null ? [] : [date]),
    sender,
    'xxx-xxx-1234',
    receiver,
    'xxx-xxx-5953',
    ...(amount === null ? [] : [`จำนวน: ${amount} บาท`]),
    ...extra,
  ];
  const lines: OcrLine[] = texts.map((text, i) => ({ text, y0: i * 100, y1: i * 100 + 60 }));
  return { kind: 'slip', qr: { bankCode: '004', reference }, ocr: { text: texts.join('\n'), lines } };
}

const lineUser = (name = 'Somchai'): LiffUser => ({
  userId: `U${randomUUID().replace(/-/g, '')}`,
  displayName: name,
  pictureUrl: `https://profile.line-scdn.net/${encodeURIComponent(name)}`,
});

const newRef = () => `REF${randomUUID().replace(/-/g, '').slice(0, 16)}`;

describe('slip payments: submit pipeline', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cards: PaymentCardService;
  let bills: BillService;
  let slips: SlipPaymentsService;
  const reader = { read: vi.fn<(image: Buffer) => Promise<SlipRead>>() };
  const groupCodes: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuthBootstrapService)
      .useValue({ onModuleInit: async () => {} })
      .overrideProvider(SlipReader)
      .useValue(reader)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    cards = app.get(PaymentCardService);
    bills = app.get(BillService);
    slips = app.get(SlipPaymentsService);
  });

  beforeEach(() => reader.read.mockReset());
  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    const byGroup = { groupId: { in: groupCodes } };
    const where = { session: byGroup };
    await prisma.pendingSlip.deleteMany({ where: byGroup });
    await prisma.slipDuplicate.deleteMany({ where: byGroup });
    await prisma.slipReference.deleteMany({ where: byGroup });
    await prisma.sessionPayment.deleteMany({ where });
    await prisma.playerLineAccount.deleteMany({ where: byGroup });
    await prisma.pairing.deleteMany({ where });
    await prisma.sessionRoster.deleteMany({ where });
    await prisma.session.deleteMany({ where: byGroup });
    await prisma.player.deleteMany({ where: byGroup });
    await prisma.group.deleteMany({ where: { code: { in: groupCodes } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  const configure = (code: string, over: object = {}) =>
    bills.setBillConfig(code, {
      model: 'fair', courtFeeSatang: 60000, courtSplit: 'equal', shuttleSplit: 'byGames',
      perGameRateSatang: 0, entryFeeSatang: 0, capSatang: null, buffetPriceSatang: 0,
      buffetShuttlesIncluded: true, startingFeeSatang: 0, hostFeeSatang: 0, walkInFeeSatang: 0, roundingBaht: 1,
      addedIds: [], removedIds: [], overrides: [], ...over,
    } as never);

  async function group(options: { payAccount?: typeof ACCOUNT | null; ownerId?: string } = {}) {
    const { payAccount = ACCOUNT, ownerId } = options;
    const groupCode = `sub-${randomUUID().slice(0, 10)}`;
    groupCodes.push(groupCode);
    await prisma.group.create({
      data: { code: groupCode, name: 'ตีชิล', payAccount: payAccount ? JSON.stringify(payAccount) : null, ownerId },
    });
    const ids: string[] = [];
    for (const name of NAMES) {
      ids.push((await prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })).id);
    }
    return { groupCode, ids };
  }

  /** Writes a confirmed card for the bill as it stands (tonight's account: the group's, else ACCOUNT). */
  async function confirm(code: string, token: string) {
    const write = (confirmedHash: string) =>
      prisma.session.update({
        where: { code },
        data: {
          paymentCard: serializePaymentState({
            account: ACCOUNT, token, confirmedAt: new Date().toISOString(), confirmedHash,
            lastSentAt: null, lastDmAt: null,
          }),
        },
      });
    // The hash covers tonight's account, so write the account first and then the hash the panel computes with it.
    await write('pending');
    await write((await cards.panel(code)).contentHash);
    expect(await cards.panel(code)).toMatchObject({ confirmed: true, stale: false });
  }

  /** An ended session of the four players with a bill, confirmed unless `confirmed` is false. */
  async function session(groupCode: string, ids: string[], options: { confirmed?: boolean; over?: object } = {}) {
    const { confirmed = true, over = {} } = options;
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
    await configure(code, over);
    await prisma.session.update({ where: { code }, data: { endedAt: ENDED_AT } });
    const token = newShareToken();
    if (confirmed) await confirm(code, token);
    return { code, token };
  }

  async function setup(options: Parameters<typeof group>[0] & { confirmed?: boolean; over?: object } = {}) {
    const { groupCode, ids } = await group(options);
    const { code, token } = await session(groupCode, ids, options);
    return { groupCode, ids, code, token };
  }

  const owed = async (code: string, playerId: string) =>
    (await cards.panel(code)).rows.find((r) => r.playerId === playerId)!.amountSatang;

  /** A LINE account linked to the player through the pay page's claim. */
  async function linked(code: string, playerId: string, name = 'Somchai') {
    const u = lineUser(name);
    expect(await slips.claimPlayer(code, u, playerId)).toBe('linked');
    return u;
  }

  const pendingOf = (code: string) => prisma.pendingSlip.findMany({ where: { sessionId: code } });
  const paymentsOf = (code: string) => prisma.sessionPayment.findMany({ where: { sessionId: code } });
  const referencesOf = (groupCode: string) => prisma.slipReference.findMany({ where: { groupId: groupCode } });
  const duplicatesOf = (groupCode: string) => prisma.slipDuplicate.findMany({ where: { groupId: groupCode } });

  /** Nothing about any slip was recorded for this group or session. */
  async function expectNothingRecorded(groupCode: string, code: string) {
    expect(await referencesOf(groupCode)).toEqual([]);
    expect(await prisma.pendingSlip.count({ where: { groupId: groupCode } })).toBe(0);
    expect(await duplicatesOf(groupCode)).toEqual([]);
    expect(await paymentsOf(code)).toEqual([]);
  }

  /** No stored column holds OCR text, an OCR line, or image bytes. */
  function expectNoOcrText(row: object) {
    for (const value of Object.values(row)) {
      if (typeof value !== 'string') continue;
      expect(value).not.toContain('OCRMARKER');
      expect(value).not.toContain('จำนวน');
      expect(value).not.toContain('xxx-xxx');
      expect(value).not.toContain('fake image');
    }
  }


  /** Re-prices players (`overrides`) and, unless `reconfirm` is false, confirms the card again with the same token. */
  async function reprice(code: string, token: string, overrides: { playerId: string; amountSatang: number }[], reconfirm = true) {
    await configure(code, { overrides });
    if (reconfirm) await confirm(code, token);
  }

  async function owner(plan: string, planRenewsAt: Date | null) {
    const user = await prisma.user.create({
      data: { email: `${randomUUID()}@slips.test`, passwordHash: 'x', plan, planRenewsAt },
    });
    userIds.push(user.id);
    return user.id;
  }

  /** The one waiting slip of the session, checked to hold no OCR text. */
  async function onePending(code: string) {
    const rows = await pendingOf(code);
    expect(rows).toHaveLength(1);
    expectNoOcrText(rows[0]);
    return rows[0];
  }

  describe('paid', () => {
    it('pays a linked sender whose own amount and receiver match, as a slip payment', async () => {
      const { code, groupCode, ids, token } = await setup();
      const a = await linked(code, ids[0]);
      const amount = await owed(code, ids[0]);
      const reference = newRef();
      reader.read.mockResolvedValue(slip(reference, { amount: baht(amount) }));

      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'paid', playerIds: [ids[0]] });
      expect(reader.read).toHaveBeenCalledWith(IMAGE);
      expect(await paymentsOf(code)).toEqual([
        expect.objectContaining({ playerId: ids[0], source: 'slip', amountSatang: amount, reference }),
      ]);
      const refs = await referencesOf(groupCode);
      expect(refs).toEqual([
        expect.objectContaining({ reference, bankCode: '004', sessionId: code, lineUserId: a.userId }),
      ]);
      expectNoOcrText(refs[0]);
      expect(await pendingOf(code)).toEqual([]);
      expect(await duplicatesOf(groupCode)).toEqual([]);
      expect(await slips.getPaid(code)).toMatchObject([{ playerId: ids[0], source: 'slip', amountChangedSince: false }]);
    });

    it('still pays when other unpaid players owe the same amount as the sender (repeated values are one amount)', async () => {
      const { code, ids, token } = await setup();
      const amount = await owed(code, ids[0]);
      const rows = (await cards.panel(code)).rows;
      expect(rows.filter((r) => r.playerId !== ids[0] && r.amountSatang === amount).length).toBeGreaterThanOrEqual(2);
      const a = await linked(code, ids[0]);
      reader.read.mockResolvedValue(slip(newRef(), { amount: baht(amount), extra: [`ยอดรวม ${baht(amount)}`] }));
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'paid', playerIds: [ids[0]] });
      expect(await paymentsOf(code)).toMatchObject([{ playerId: ids[0], source: 'slip', amountSatang: amount }]);
    });

    it('pays a comma-grouped amount', async () => {
      const { code, ids, token } = await setup();
      await reprice(code, token, [{ playerId: ids[0], amountSatang: 117200 }]);
      const a = await linked(code, ids[0]);
      reader.read.mockResolvedValue(slip(newRef(), { amount: '1,172.00' }));
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'paid', playerIds: [ids[0]] });
      expect(await paymentsOf(code)).toMatchObject([{ amountSatang: 117200 }]);
    });

    it("checks the confirmed card's account name when the group has no saved account", async () => {
      // The host typed an account for tonight only: it lives in the card snapshot, not on the group.
      const { code, ids, token } = await setup({ payAccount: null });
      const a = await linked(code, ids[0]);
      reader.read.mockResolvedValue(slip(newRef(), { amount: baht(await owed(code, ids[0])) }));
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'paid', playerIds: [ids[0]] });
    });

    it("the group's saved name wins over the confirmed card's account name", async () => {
      const { code, groupCode, ids, token } = await setup();
      await prisma.group.update({
        where: { code: groupCode },
        data: { payAccount: JSON.stringify({ ...ACCOUNT, name: 'จิตติญา' }) },
      });
      const a = await linked(code, ids[0]);
      // RECEIVER is the card's account name; the group now saves another, so the slip is held.
      reader.read.mockResolvedValue(slip(newRef(), { amount: baht(await owed(code, ids[0])) }));
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'waiting', reason: 'receiver' });
      expect(await paymentsOf(code)).toEqual([]);
    });

    it("checks the group's current saved name, not the one frozen in the confirmed card", async () => {
      const { code, groupCode, ids, token } = await setup();
      await prisma.group.update({
        where: { code: groupCode },
        data: { payAccount: JSON.stringify({ ...ACCOUNT, name: 'จิตติญา' }) },
      });
      expect(await cards.panel(code)).toMatchObject({ confirmed: true, stale: false });
      const a = await linked(code, ids[0]);
      reader.read.mockResolvedValue(
        slip(newRef(), { amount: baht(await owed(code, ids[0])), receiver: 'น.ส. จิตติญา ฉัตรเฉลิมวิทย์' })
      );
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'paid', playerIds: [ids[0]] });
    });

    it('pays on an active host plan', async () => {
      const ownerId = await owner('host', new Date(Date.now() + 86_400_000));
      const { code, ids, token } = await setup({ ownerId });
      const a = await linked(code, ids[0]);
      reader.read.mockResolvedValue(slip(newRef(), { amount: baht(await owed(code, ids[0])) }));
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'paid', playerIds: [ids[0]] });
    });
  });

  describe('slip date', () => {
    /** A linked sender of player 0 and a slip of exactly their amount: only the date can hold it. */
    async function ready() {
      const { code, ids, token } = await setup();
      const a = await linked(code, ids[0]);
      return { code, ids, token, a, amount: await owed(code, ids[0]) };
    }

    it('pays a slip made on the day the session ended', async () => {
      const { code, ids, token, a, amount } = await ready();
      reader.read.mockResolvedValue(slip(newRef(), { amount: baht(amount), madeAt: new Date(ENDED_AT.getTime() - HOUR) }));
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'paid', playerIds: [ids[0]] });
    });

    it('pays a slip made the day before the session ended (paid ahead)', async () => {
      const { code, ids, token, a, amount } = await ready();
      reader.read.mockResolvedValue(slip(newRef(), { amount: baht(amount), madeAt: new Date(ENDED_AT.getTime() - DAY) }));
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'paid', playerIds: [ids[0]] });
    });

    it('holds a week-old slip of the right amount and pays nobody', async () => {
      // A genuine old slip (say last week's, same amount, made before this feature recorded references).
      const { code, token, a, amount } = await ready();
      reader.read.mockResolvedValue(slip(newRef(), { amount: baht(amount), madeAt: new Date(ENDED_AT.getTime() - 7 * DAY) }));
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'waiting', reason: 'date' });
      expect(await paymentsOf(code)).toEqual([]);
      expect(await onePending(code)).toMatchObject({ reason: 'date', amountSatang: amount, receiverName: null });
    });

    it('holds a slip dated three days after today', async () => {
      const { code, token, a, amount } = await ready();
      const now = new Date(ENDED_AT.getTime() + HOUR);
      reader.read.mockResolvedValue(slip(newRef(), { amount: baht(amount), madeAt: new Date(now.getTime() + 3 * DAY) }));
      expect(await slips.submitSlip(code, token, a, IMAGE, now)).toEqual({ kind: 'waiting', reason: 'date' });
      expect(await paymentsOf(code)).toEqual([]);
    });

    it('pays a slip dated the day after today (a phone clock a little ahead)', async () => {
      const { code, ids, token, a, amount } = await ready();
      const now = new Date(ENDED_AT.getTime() + HOUR);
      reader.read.mockResolvedValue(slip(newRef(), { amount: baht(amount), madeAt: new Date(now.getTime() + DAY) }));
      expect(await slips.submitSlip(code, token, a, IMAGE, now)).toEqual({ kind: 'paid', playerIds: [ids[0]] });
    });

    it('holds a slip whose date cannot be read (fails closed)', async () => {
      const { code, token, a, amount } = await ready();
      reader.read.mockResolvedValue(slip(newRef(), { amount: baht(amount), date: null }));
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'waiting', reason: 'date' });
      reader.read.mockResolvedValue(slip(newRef(), { amount: baht(amount), date: '3O ตุ.ค. 6? 21:04' }));
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'waiting', reason: 'date' });
      expect(await paymentsOf(code)).toEqual([]);
    });

    it('reads the other bank formats: 4-digit Buddhist year and English', async () => {
      for (const date of ['30 ต.ค. 2569 - 21:04', '30 Oct 2026 21:04']) {
        const { code, ids, token, a, amount } = await ready();
        reader.read.mockResolvedValue(slip(newRef(), { amount: baht(amount), date }));
        expect(await slips.submitSlip(code, token, a, IMAGE), date).toEqual({ kind: 'paid', playerIds: [ids[0]] });
      }
    });

    it('is checked after the amount and before the receiver', async () => {
      const { code, token, a, amount } = await ready();
      const old = new Date(ENDED_AT.getTime() - 7 * DAY);
      reader.read.mockResolvedValue(slip(newRef(), { amount: '999.00', madeAt: old }));
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'waiting', reason: 'amount' });
      reader.read.mockResolvedValue(slip(newRef(), { amount: baht(amount), madeAt: old, receiver: 'นาย ใครก็ได้ ไม่รู้จัก' }));
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'waiting', reason: 'date' });
    });
  });

  describe('duplicates', () => {
    it('never pays the same reference twice and records one duplicate with the original player', async () => {
      const { code, groupCode, ids, token } = await setup();
      const a = await linked(code, ids[0], 'A');
      const b = await linked(code, ids[1], 'B');
      const reference = newRef();
      reader.read.mockResolvedValue(slip(reference, { amount: baht(await owed(code, ids[0])) }));
      expect(await slips.submitSlip(code, token, a, IMAGE)).toMatchObject({ kind: 'paid' });

      expect(await slips.submitSlip(code, token, b, IMAGE)).toEqual({ kind: 'duplicate' });
      expect(await paymentsOf(code)).toHaveLength(1);
      expect(await referencesOf(groupCode)).toHaveLength(1);
      expect(await pendingOf(code)).toEqual([]);
      const dups = await duplicatesOf(groupCode);
      expect(dups).toEqual([
        expect.objectContaining({
          sessionId: code, reference, lineUserId: b.userId, displayName: 'B', dismissedAt: null,
        }),
      ]);
      expect(JSON.parse(dups[0].originalPlayerIds)).toEqual([ids[0]]);
      expectNoOcrText(dups[0]);
    });

    it('is a duplicate again after the paid mark is undone, and pays nobody', async () => {
      const { code, groupCode, ids, token } = await setup();
      const a = await linked(code, ids[0]);
      const reference = newRef();
      reader.read.mockResolvedValue(slip(reference, { amount: baht(await owed(code, ids[0])) }));
      expect(await slips.submitSlip(code, token, a, IMAGE)).toMatchObject({ kind: 'paid' });
      await slips.untick(code, ids[0]);

      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'duplicate' });
      expect(await paymentsOf(code)).toEqual([]);
      const dups = await duplicatesOf(groupCode);
      expect(dups).toHaveLength(1);
      expect(JSON.parse(dups[0].originalPlayerIds)).toEqual([]);
    });

    it('remembers a waiting slip too: the same reference again is a duplicate', async () => {
      const { code, groupCode, ids, token } = await setup();
      const stranger = lineUser('Stranger');
      reader.read.mockResolvedValue(slip(newRef(), { amount: baht(await owed(code, ids[0])) }));
      expect(await slips.submitSlip(code, token, stranger, IMAGE)).toEqual({ kind: 'waiting', reason: 'unmapped' });
      expect(await slips.submitSlip(code, token, stranger, IMAGE)).toEqual({ kind: 'duplicate' });
      expect(await pendingOf(code)).toHaveLength(1);
      expect(await duplicatesOf(groupCode)).toHaveLength(1);
    });

    it('is a duplicate in another session of the same group', async () => {
      const { code, groupCode, ids, token } = await setup();
      const second = await session(groupCode, ids);
      const a = await linked(code, ids[0]);
      reader.read.mockResolvedValue(slip(newRef(), { amount: baht(await owed(code, ids[0])) }));
      expect(await slips.submitSlip(code, token, a, IMAGE)).toMatchObject({ kind: 'paid' });

      expect(await slips.submitSlip(second.code, second.token, a, IMAGE)).toEqual({ kind: 'duplicate' });
      expect(await paymentsOf(second.code)).toEqual([]);
      const dups = await duplicatesOf(groupCode);
      expect(dups).toEqual([expect.objectContaining({ sessionId: second.code })]);
      expect(JSON.parse(dups[0].originalPlayerIds)).toEqual([ids[0]]);
    });

    it('lets the same reference through in a different group', async () => {
      const first = await setup();
      const other = await setup();
      const reference = newRef();
      const a = await linked(first.code, first.ids[0]);
      const b = await linked(other.code, other.ids[0]);
      reader.read.mockResolvedValue(slip(reference, { amount: baht(await owed(first.code, first.ids[0])) }));
      expect(await slips.submitSlip(first.code, first.token, a, IMAGE)).toMatchObject({ kind: 'paid' });
      expect(await slips.submitSlip(other.code, other.token, b, IMAGE)).toMatchObject({ kind: 'paid' });
    });

    it('two simultaneous submits of one slip in one session: exactly one paid, one duplicate', async () => {
      const { code, groupCode, ids, token } = await setup();
      const a = await linked(code, ids[0], 'A');
      const b = await linked(code, ids[1], 'B');
      const amount = await owed(code, ids[0]);
      expect(await owed(code, ids[1])).toBe(amount);
      reader.read.mockResolvedValue(slip(newRef(), { amount: baht(amount) }));

      const outcomes = await Promise.all([
        slips.submitSlip(code, token, a, IMAGE),
        slips.submitSlip(code, token, b, IMAGE),
      ]);
      expect(outcomes.map((o) => o.kind).sort()).toEqual(['duplicate', 'paid']);
      expect(await paymentsOf(code)).toHaveLength(1);
      expect(await referencesOf(groupCode)).toHaveLength(1);
      expect(await duplicatesOf(groupCode)).toHaveLength(1);
    });

    it('two sessions of one group at once with one slip: one winner, one duplicate, never a thrown error', async () => {
      const { code, groupCode, ids, token } = await setup();
      const second = await session(groupCode, ids);
      const a = await linked(code, ids[0]);
      reader.read.mockResolvedValue(slip(newRef(), { amount: baht(await owed(code, ids[0])) }));

      const outcomes = await Promise.all([
        slips.submitSlip(code, token, a, IMAGE),
        slips.submitSlip(second.code, second.token, a, IMAGE),
      ]);
      const kinds = outcomes.map((o) => o.kind);
      expect(kinds.filter((k) => k === 'duplicate')).toHaveLength(1);
      expect(kinds.filter((k) => k === 'paid' || k === 'waiting')).toHaveLength(1);
      expect(await referencesOf(groupCode)).toHaveLength(1);
      expect(await duplicatesOf(groupCode)).toHaveLength(1);
      const payments = await prisma.sessionPayment.count({ where: { sessionId: { in: [code, second.code] } } });
      expect(payments).toBeLessThanOrEqual(1);
    });

    it('turns a reference claimed by another session between check and create into a duplicate', async () => {
      const { code, groupCode, ids, token } = await setup();
      const second = await session(groupCode, ids);
      const a = await linked(code, ids[0]);
      const reference = newRef();
      reader.read.mockResolvedValue(slip(reference, { amount: baht(await owed(code, ids[0])) }));
      // The other session wins the race: its row lands first, so this create hits the real unique index.
      const create = prisma.slipReference.create.bind(prisma.slipReference);
      vi.spyOn(prisma.slipReference, 'create').mockImplementationOnce((async (args: Parameters<typeof create>[0]) => {
        await create({ data: { groupId: groupCode, reference, bankCode: '004', sessionId: second.code } });
        return create(args);
      }) as never);

      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'duplicate' });
      expect(await paymentsOf(code)).toEqual([]);
      expect(await pendingOf(code)).toEqual([]);
      expect(await duplicatesOf(groupCode)).toEqual([expect.objectContaining({ sessionId: code, reference })]);
    });

    it('rethrows a reference write error that is not a unique violation', async () => {
      const { code, ids, token } = await setup();
      const a = await linked(code, ids[0]);
      reader.read.mockResolvedValue(slip(newRef(), { amount: baht(await owed(code, ids[0])) }));
      vi.spyOn(prisma.slipReference, 'create').mockRejectedValueOnce(new Error('disk full') as never);
      await expect(slips.submitSlip(code, token, a, IMAGE)).rejects.toThrow('disk full');
      expect(await paymentsOf(code)).toEqual([]);
    });

    it('releases the reference when recording the outcome fails, so the slip can be sent again', async () => {
      const { code, groupCode, ids, token } = await setup();
      const a = await linked(code, ids[0]);
      reader.read.mockResolvedValue(slip(newRef(), { amount: baht(await owed(code, ids[0])) }));
      vi.spyOn(prisma.sessionPayment, 'create').mockRejectedValueOnce(new Error('disk full') as never);
      await expect(slips.submitSlip(code, token, a, IMAGE)).rejects.toThrow('disk full');
      expect(await referencesOf(groupCode)).toEqual([]);
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'paid', playerIds: [ids[0]] });
    });
  });

  describe('unavailable: checked before the image is read, recording nothing', () => {
    it('refuses a wrong token and an unknown session', async () => {
      const { code, groupCode, ids, token } = await setup();
      const a = await linked(code, ids[0]);
      reader.read.mockResolvedValue(slip(newRef(), { amount: baht(await owed(code, ids[0])) }));
      expect(await slips.submitSlip(code, 'not-the-token', a, IMAGE)).toEqual({ kind: 'unavailable' });
      expect(await slips.submitSlip(code, '', a, IMAGE)).toEqual({ kind: 'unavailable' });
      expect(await slips.submitSlip('no-such-session', token, a, IMAGE)).toEqual({ kind: 'unavailable' });
      expect(reader.read).not.toHaveBeenCalled();
      await expectNothingRecorded(groupCode, code);
    });

    it('refuses a lapsed paid plan and a free plan', async () => {
      for (const ownerId of [
        await owner('host', new Date(Date.now() - 86_400_000)),
        await owner('free', null),
      ]) {
        const { code, groupCode, ids, token } = await setup({ ownerId });
        const a = await linked(code, ids[0]);
        reader.read.mockResolvedValue(slip(newRef(), { amount: baht(await owed(code, ids[0])) }));
        expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'unavailable' });
        expect(reader.read).not.toHaveBeenCalled();
        await expectNothingRecorded(groupCode, code);
      }
    });

    it('refuses a card holding a token that was never confirmed', async () => {
      const { code, groupCode, ids, token } = await setup({ confirmed: false });
      await prisma.session.update({
        where: { code },
        data: {
          paymentCard: serializePaymentState({
            account: ACCOUNT, token, confirmedAt: null, confirmedHash: null, lastSentAt: null, lastDmAt: null,
          }),
        },
      });
      expect(await cards.tokenValid(code, token)).toBe(true);
      const a = lineUser();
      await prisma.playerLineAccount.create({
        data: { groupId: groupCode, playerId: ids[0], lineUserId: a.userId, linkedBy: 'self' },
      });
      reader.read.mockResolvedValue(slip(newRef(), { amount: baht(await owed(code, ids[0])) }));
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'unavailable' });
      expect(reader.read).not.toHaveBeenCalled();
      await expectNothingRecorded(groupCode, code);
    });

    it('checks again under the lock: a card reconfirmed while the slip was being read refuses the old token', async () => {
      const { code, groupCode, ids, token } = await setup();
      const a = await linked(code, ids[0]);
      const read = slip(newRef(), { amount: baht(await owed(code, ids[0])) });
      reader.read.mockImplementation(async () => {
        await confirm(code, newShareToken());
        return read;
      });
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'unavailable' });
      await expectNothingRecorded(groupCode, code);
    });
  });

  it('records nothing for an image that is not a slip', async () => {
    const { code, groupCode, ids, token } = await setup();
    const a = await linked(code, ids[0]);
    reader.read.mockResolvedValue({ kind: 'not-slip' });
    expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'not-slip' });
    await expectNothingRecorded(groupCode, code);
  });

  describe('waiting for the host', () => {
    it('holds a slip while the card is stale, with the one owed amount it shows', async () => {
      const { code, groupCode, ids, token } = await setup();
      const a = await linked(code, ids[0], 'A');
      await reprice(code, token, [{ playerId: ids[0], amountSatang: 17200 }], false);
      expect(await cards.panel(code)).toMatchObject({ confirmed: true, stale: true });
      const reference = newRef();
      reader.read.mockResolvedValue(slip(reference, { amount: '172.00' }));

      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'waiting', reason: 'stale' });
      expect(await paymentsOf(code)).toEqual([]);
      expect(await onePending(code)).toMatchObject({
        sessionId: code, groupId: groupCode, reference, lineUserId: a.userId, displayName: 'A',
        pictureUrl: a.pictureUrl, amountSatang: 17200, receiverName: null, receiverTail: null, reason: 'stale',
        resolvedAt: null,
      });
      expect(await referencesOf(groupCode)).toEqual([expect.objectContaining({ reference, lineUserId: a.userId })]);
    });

    it('holds a slip from a sender who is not linked', async () => {
      const { code, ids, token } = await setup();
      const amount = await owed(code, ids[0]);
      reader.read.mockResolvedValue(slip(newRef(), { amount: baht(amount) }));
      expect(await slips.submitSlip(code, token, lineUser(), IMAGE)).toEqual({ kind: 'waiting', reason: 'unmapped' });
      expect(await paymentsOf(code)).toEqual([]);
      expect(await onePending(code)).toMatchObject({ reason: 'unmapped', amountSatang: amount });
    });

    it("holds a slip when the sender's player is already paid", async () => {
      const { code, ids, token } = await setup();
      const a = await linked(code, ids[0]);
      await slips.tick(code, ids[0]);
      reader.read.mockResolvedValue(slip(newRef(), { amount: baht(await owed(code, ids[0])) }));
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'waiting', reason: 'collision' });
      expect(await paymentsOf(code)).toMatchObject([{ playerId: ids[0], source: 'host' }]);
      expect(await onePending(code)).toMatchObject({ reason: 'collision' });
    });

    it("holds a slip when the sender's player is not on the bill", async () => {
      const { code, groupCode, ids, token } = await setup();
      const stranger = await prisma.player.create({ data: { groupId: groupCode, name: 'คนนอก', aliases: '[]' } });
      const a = lineUser();
      await prisma.playerLineAccount.create({
        data: { groupId: groupCode, playerId: stranger.id, lineUserId: a.userId, linkedBy: 'host' },
      });
      reader.read.mockResolvedValue(slip(newRef(), { amount: baht(await owed(code, ids[0])) }));
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'waiting', reason: 'collision' });
      expect(await paymentsOf(code)).toEqual([]);
    });

    it('holds a slip as a collision when the player is paid in between (unique violation on the payment)', async () => {
      const { code, ids, token } = await setup();
      const a = await linked(code, ids[0]);
      reader.read.mockResolvedValue(slip(newRef(), { amount: baht(await owed(code, ids[0])) }));
      const create = prisma.sessionPayment.create.bind(prisma.sessionPayment);
      vi.spyOn(prisma.sessionPayment, 'create').mockImplementationOnce((async (args: Parameters<typeof create>[0]) => {
        await create({ data: { sessionId: code, playerId: ids[0], source: 'host' } });
        return create(args);
      }) as never);
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'waiting', reason: 'collision' });
      expect(await paymentsOf(code)).toMatchObject([{ playerId: ids[0], source: 'host' }]);
      expect(await onePending(code)).toMatchObject({ reason: 'collision' });
    });

    it('holds a slip whose amount is not the sender\'s own; stores an amount only when exactly one owed amount shows', async () => {
      const { code, ids, token } = await setup();
      await reprice(code, token, [
        { playerId: ids[1], amountSatang: 25000 },
        { playerId: ids[2], amountSatang: 30000 },
      ]);
      const a = await linked(code, ids[0]);

      reader.read.mockResolvedValue(slip(newRef(), { amount: '999.00' }));
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'waiting', reason: 'amount' });
      reader.read.mockResolvedValue(slip(newRef(), { amount: '250.00' }));
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'waiting', reason: 'amount' });
      reader.read.mockResolvedValue(slip(newRef(), { amount: '250.00', extra: ['ยอดรวม 300.00'] }));
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'waiting', reason: 'amount' });

      const rows = await prisma.pendingSlip.findMany({ where: { sessionId: code }, orderBy: { createdAt: 'asc' } });
      expect(rows.map((r) => [r.reason, r.amountSatang])).toEqual([
        ['amount', null],
        ['amount', 25000],
        ['amount', null],
      ]);
      expect(await paymentsOf(code)).toEqual([]);
    });

    it("holds a slip showing the sender's own amount and another unpaid player's different amount", async () => {
      const { code, ids, token } = await setup();
      await reprice(code, token, [
        { playerId: ids[0], amountSatang: 17200 },
        { playerId: ids[1], amountSatang: 15000 },
      ]);
      const a = await linked(code, ids[0]);
      reader.read.mockResolvedValue(slip(newRef(), { amount: '172.00', extra: ['ยอดคงเหลือ 150.00'] }));
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'waiting', reason: 'amount' });
      expect(await paymentsOf(code)).toEqual([]);
      expect(await onePending(code)).toMatchObject({ reason: 'amount', amountSatang: null });
    });

    it('holds a slip with no amount token at all as unreadable', async () => {
      const { code, ids, token } = await setup();
      const a = await linked(code, ids[0]);
      reader.read.mockResolvedValue(slip(newRef(), { amount: null, extra: ['จำนวน 210 บาท'] }));
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'waiting', reason: 'unreadable' });
      expect(await onePending(code)).toMatchObject({ reason: 'unreadable', amountSatang: null });
    });

    it('holds a slip paid to someone else, keeping the receiver name and account tail as read', async () => {
      const { code, ids, token } = await setup();
      const a = await linked(code, ids[0]);
      const amount = await owed(code, ids[0]);
      reader.read.mockResolvedValue(
        slip(newRef(), { amount: baht(amount), receiver: 'น.ส. จิตติญา ฉัตรเฉลิมวิทย์' })
      );
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'waiting', reason: 'receiver' });
      expect(await paymentsOf(code)).toEqual([]);
      expect(await onePending(code)).toMatchObject({
        reason: 'receiver', amountSatang: amount, receiverName: 'จิตติญา ฉัตรเฉลิมวิทย์', receiverTail: '5953',
      });
    });

    it("holds a slip paid to someone else when only the confirmed card has an account name", async () => {
      const { code, ids, token } = await setup({ payAccount: null });
      const a = await linked(code, ids[0]);
      reader.read.mockResolvedValue(
        slip(newRef(), { amount: baht(await owed(code, ids[0])), receiver: 'นาย ใครก็ได้ ไม่รู้จัก' })
      );
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'waiting', reason: 'receiver' });
      expect(await paymentsOf(code)).toEqual([]);
      expect(await onePending(code)).toMatchObject({ reason: 'receiver', receiverName: 'ใครก็ได้ ไม่รู้จัก' });
    });

    it('holds a slip where the saved name is the sender (the host paying someone back)', async () => {
      const { code, ids, token } = await setup();
      const a = await linked(code, ids[0]);
      reader.read.mockResolvedValue(
        slip(newRef(), { amount: baht(await owed(code, ids[0])), sender: RECEIVER, receiver: 'นาย ทดสอบ ผู้รับเงิน' })
      );
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'waiting', reason: 'receiver' });
      expect(await onePending(code)).toMatchObject({ reason: 'receiver', receiverName: 'ทดสอบ ผู้รับเงิน' });
      expect(await paymentsOf(code)).toEqual([]);
    });

    it('never auto-pays a player who owes nothing', async () => {
      const { code, ids, token } = await setup();
      await reprice(code, token, [{ playerId: ids[2], amountSatang: 0 }]);
      // The zero row is still on the bill, so this is the amount rule refusing it, not a missing row.
      expect(await owed(code, ids[2])).toBe(0);
      const a = await linked(code, ids[2]);
      reader.read.mockResolvedValue(slip(newRef(), { amount: '0.00' }));
      expect(await slips.submitSlip(code, token, a, IMAGE)).toEqual({ kind: 'waiting', reason: 'amount' });
      expect(await paymentsOf(code)).toEqual([]);
      // Zero is never an owed amount found on a slip either.
      expect(await onePending(code)).toMatchObject({ amountSatang: null });
    });
  });
});
