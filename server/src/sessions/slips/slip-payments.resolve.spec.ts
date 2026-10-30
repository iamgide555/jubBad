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
const OTHER_RECEIVER = 'นาย คนอื่น ไม่ใช่เรา';
const SENDER = 'นาย ทดสอบ ผู้โอน';
const NAMES = ['สมชาย', 'มาลี', 'ต้อม', 'นิด'];
const IMAGE = Buffer.from('fake image bytes');

const baht = (satang: number) =>
  `${Math.floor(satang / 100).toLocaleString('en-US')}.${String(satang % 100).padStart(2, '0')}`;

function slip(reference: string, options: { amount?: string | null; receiver?: string } = {}): SlipRead {
  const { amount = null, receiver = RECEIVER } = options;
  const texts = [
    'โอนเงินสำเร็จ',
    // Made an hour before the session ended: inside the slip date window.
    slipDateLine(new Date(ENDED_AT.getTime() - 3_600_000)),
    SENDER,
    'xxx-xxx-1234',
    receiver,
    'xxx-xxx-5953',
    ...(amount === null ? [] : [`จำนวน: ${amount} บาท`]),
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

describe('slip payments: host review', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cards: PaymentCardService;
  let bills: BillService;
  let slips: SlipPaymentsService;
  const reader = { read: vi.fn<(image: Buffer) => Promise<SlipRead>>() };
  const groupCodes: string[] = [];

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
    await app.close();
  });

  const configure = (code: string, over: object = {}) =>
    bills.setBillConfig(code, {
      model: 'fair', courtFeeSatang: 60000, courtSplit: 'equal', shuttleSplit: 'byGames',
      perGameRateSatang: 0, entryFeeSatang: 0, capSatang: null, buffetPriceSatang: 0,
      buffetShuttlesIncluded: true, startingFeeSatang: 0, hostFeeSatang: 0, walkInFeeSatang: 0, roundingBaht: 1,
      addedIds: [], removedIds: [], overrides: [], ...over,
    } as never);

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
    await write('pending');
    await write((await cards.panel(code)).contentHash);
    expect(await cards.panel(code)).toMatchObject({ confirmed: true, stale: false });
  }

  async function newSession(groupCode: string, ids: string[], over: object = {}) {
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
    await confirm(code, token);
    return { code, token };
  }

  /** Four players; ids[2] and ids[3] are re-priced so that only ids[0] and ids[1] share an amount. */
  async function setup(options: { payAccount?: typeof ACCOUNT | null } = {}) {
    const { payAccount = ACCOUNT } = options;
    const groupCode = `res-${randomUUID().slice(0, 10)}`;
    groupCodes.push(groupCode);
    await prisma.group.create({
      data: { code: groupCode, name: 'ตีชิล', payAccount: payAccount ? JSON.stringify(payAccount) : null },
    });
    const ids: string[] = [];
    for (const name of NAMES) {
      ids.push((await prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })).id);
    }
    const { code, token } = await newSession(groupCode, ids, {
      overrides: [
        { playerId: ids[2], amountSatang: 11100 },
        { playerId: ids[3], amountSatang: 22200 },
      ],
    });
    return { groupCode, ids, code, token };
  }

  const owed = async (code: string, playerId: string) =>
    (await cards.panel(code)).rows.find((r) => r.playerId === playerId)!.amountSatang;

  /** A slip from an unlinked account that shows `amount` baht: held as 'unmapped'. */
  async function waiting(code: string, token: string, amountSatang: number | null, options: { receiver?: string; user?: LiffUser } = {}) {
    const user = options.user ?? lineUser('Sender');
    reader.read.mockResolvedValue(
      slip(newRef(), { amount: amountSatang === null ? null : baht(amountSatang), receiver: options.receiver })
    );
    await slips.submitSlip(code, token, user, IMAGE);
    const rows = await slips.listWaiting(code);
    return { user, row: rows[rows.length - 1] };
  }

  const paymentsOf = (code: string) => prisma.sessionPayment.findMany({ where: { sessionId: code } });
  const savedAccount = async (groupCode: string) =>
    JSON.parse((await prisma.group.findUniqueOrThrow({ where: { code: groupCode } })).payAccount!);

  describe('listWaiting', () => {
    it('lists this session\'s unresolved slips oldest first, with candidates narrowed to the equal-amount unpaid players', async () => {
      const { code, token, ids } = await setup();
      const amount = await owed(code, ids[0]);
      expect(await owed(code, ids[1])).toBe(amount);
      const first = await waiting(code, token, amount);
      const second = await waiting(code, token, 11100);

      const rows = await slips.listWaiting(code);
      expect(rows.map((r) => r.id)).toEqual([first.row.id, second.row.id]);
      expect(rows[0]).toMatchObject({
        reason: 'unmapped', displayName: 'Sender', lineUserId: first.user.userId, amountSatang: amount,
        receiverName: null, receiverTail: null,
      });
      expect(rows[0].pictureUrl).toContain('profile.line-scdn.net');
      expect(typeof rows[0].createdAt).toBe('string');
      expect([...rows[0].candidatePlayerIds].sort()).toEqual([ids[0], ids[1]].sort());
      expect(rows[1].candidatePlayerIds).toEqual([ids[2]]);
    });

    it('offers every unpaid player when the slip shows no single amount, and leaves out paid players', async () => {
      const { code, token, ids } = await setup();
      await slips.tick(code, ids[3]);
      const { row } = await waiting(code, token, null);
      expect(row.amountSatang).toBeNull();
      expect([...row.candidatePlayerIds].sort()).toEqual([ids[0], ids[1], ids[2]].sort());
    });

    it('does not list resolved slips or another session\'s slips', async () => {
      const a = await setup();
      const b = await setup();
      const sa = await waiting(a.code, a.token, await owed(a.code, a.ids[0]));
      await waiting(b.code, b.token, await owed(b.code, b.ids[0]));
      expect(await slips.listWaiting(a.code)).toHaveLength(1);
      await slips.dismissWaiting(a.code, sa.row.id);
      expect(await slips.listWaiting(a.code)).toEqual([]);
      expect(await slips.listWaiting(b.code)).toHaveLength(1);
    });

    it('rejects an unknown session', async () => {
      await expect(slips.listWaiting('nope-nope')).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('resolveWaiting', () => {
    it('marks every covered player paid by slip, with no amount and the slip\'s reference, and clears the slip', async () => {
      const { code, token, ids } = await setup();
      const { row } = await waiting(code, token, 33300);
      const stored = await prisma.pendingSlip.findUniqueOrThrow({ where: { id: row.id } });

      await slips.resolveWaiting(code, row.id, { coversPlayerIds: [ids[0], ids[2]], senderPlayerId: null });

      const payments = await paymentsOf(code);
      expect(payments.map((p) => p.playerId).sort()).toEqual([ids[0], ids[2]].sort());
      for (const p of payments) {
        expect(p).toMatchObject({ source: 'slip', amountSatang: null, reference: stored.reference });
      }
      expect(await slips.listWaiting(code)).toEqual([]);
      expect((await prisma.pendingSlip.findUniqueOrThrow({ where: { id: row.id } })).resolvedAt).not.toBeNull();
      const paid = await slips.getPaid(code);
      expect(paid.map((p) => p.amountChangedSince)).toEqual([false, false]);
      // The sender stays unlinked.
      expect(await slips.listLinks(code)).toEqual([]);
    });

    it('links the slip\'s account to the sender player as a host link', async () => {
      const { code, token, groupCode, ids } = await setup();
      const { row, user } = await waiting(code, token, await owed(code, ids[0]));

      await slips.resolveWaiting(code, row.id, { coversPlayerIds: [ids[0]], senderPlayerId: ids[0] });

      expect(await slips.linkedPlayerOf(groupCode, user.userId)).toBe(ids[0]);
      expect(await slips.listLinks(code)).toEqual([{ playerId: ids[0], displayName: 'Sender', linkedBy: 'host' }]);
      expect(await paymentsOf(code)).toHaveLength(1);
    });

    it('links a sender who is not among the covered players', async () => {
      const { code, token, groupCode, ids } = await setup();
      const { row, user } = await waiting(code, token, 33300);
      await slips.resolveWaiting(code, row.id, { coversPlayerIds: [ids[1]], senderPlayerId: ids[3] });
      expect(await slips.linkedPlayerOf(groupCode, user.userId)).toBe(ids[3]);
      expect((await paymentsOf(code)).map((p) => p.playerId)).toEqual([ids[1]]);
    });

    it('refuses with ACCOUNT_ALREADY_LINKED and writes nothing when the account is linked to another player', async () => {
      const { code, token, ids } = await setup();
      const user = lineUser('Sender');
      expect(await slips.claimPlayer(code, user, ids[1])).toBe('linked');
      // Mapped sender with the wrong amount: held for the host.
      const { row } = await waiting(code, token, 33300, { user });
      expect(row.reason).toBe('amount');

      await expect(
        slips.resolveWaiting(code, row.id, { coversPlayerIds: [ids[0], ids[2]], senderPlayerId: ids[0] })
      ).rejects.toMatchObject({ response: { code: 'ACCOUNT_ALREADY_LINKED' } });

      expect(await paymentsOf(code)).toEqual([]);
      expect(await slips.listWaiting(code)).toHaveLength(1);
      expect((await slips.listLinks(code)).map((l) => l.playerId)).toEqual([ids[1]]);
    });

    it('requires at least one covered player', async () => {
      const { code, token } = await setup();
      const { row } = await waiting(code, token, 33300);
      await expect(slips.resolveWaiting(code, row.id, { coversPlayerIds: [], senderPlayerId: null })).rejects.toMatchObject({
        response: { code: 'COVERS_REQUIRED' },
      });
      expect(await slips.listWaiting(code)).toHaveLength(1);
    });

    it('refuses a covered player who is not on the bill and writes nothing', async () => {
      const { code, token, groupCode, ids } = await setup();
      const stranger = (await prisma.player.create({ data: { groupId: groupCode, name: 'คนนอก', aliases: '[]' } })).id;
      const { row } = await waiting(code, token, 33300);
      await expect(
        slips.resolveWaiting(code, row.id, { coversPlayerIds: [ids[0], stranger], senderPlayerId: null })
      ).rejects.toMatchObject({ response: { code: 'PLAYER_NOT_ON_BILL' } });
      expect(await paymentsOf(code)).toEqual([]);
      expect(await slips.listWaiting(code)).toHaveLength(1);
    });

    it('skips a covered player who is already paid without overwriting the mark', async () => {
      const { code, token, ids } = await setup();
      await slips.tick(code, ids[0]);
      const before = (await paymentsOf(code))[0];
      const { row } = await waiting(code, token, 33300);

      await slips.resolveWaiting(code, row.id, { coversPlayerIds: [ids[0], ids[1]], senderPlayerId: null });

      const payments = await paymentsOf(code);
      expect(payments).toHaveLength(2);
      expect(payments.find((p) => p.playerId === ids[0])).toMatchObject({
        id: before.id, source: 'host', amountSatang: null, reference: null,
      });
      expect(payments.find((p) => p.playerId === ids[1])).toMatchObject({ source: 'slip' });
      expect(await slips.listWaiting(code)).toEqual([]);
    });

    it('is not found for another session\'s slip, an unknown id, or one already resolved', async () => {
      const a = await setup();
      const b = await setup();
      const { row } = await waiting(a.code, a.token, 33300);
      const input = { coversPlayerIds: [b.ids[0]], senderPlayerId: null };
      await expect(slips.resolveWaiting(b.code, row.id, input)).rejects.toMatchObject({ status: 404 });
      await expect(slips.resolveWaiting(b.code, 'nope', input)).rejects.toMatchObject({ status: 404 });

      await slips.resolveWaiting(a.code, row.id, { coversPlayerIds: [a.ids[0]], senderPlayerId: null });
      await expect(
        slips.resolveWaiting(a.code, row.id, { coversPlayerIds: [a.ids[1]], senderPlayerId: null })
      ).rejects.toMatchObject({ status: 404 });
      expect(await paymentsOf(a.code)).toHaveLength(1);
      expect(await paymentsOf(b.code)).toEqual([]);
    });
  });

  describe('dismissWaiting', () => {
    it('resolves the slip without paying anyone', async () => {
      const { code, token } = await setup();
      const { row } = await waiting(code, token, 33300);
      await slips.dismissWaiting(code, row.id);
      expect(await slips.listWaiting(code)).toEqual([]);
      expect(await paymentsOf(code)).toEqual([]);
      await expect(slips.dismissWaiting(code, row.id)).rejects.toMatchObject({ status: 404 });
    });

    it('is not found for another session\'s slip', async () => {
      const a = await setup();
      const b = await setup();
      const { row } = await waiting(a.code, a.token, 33300);
      await expect(slips.dismissWaiting(b.code, row.id)).rejects.toMatchObject({ status: 404 });
      expect(await slips.listWaiting(a.code)).toHaveLength(1);
    });
  });

  describe('duplicates', () => {
    /** A slip paid for by a linked player, then sent again by another account: a duplicate. */
    async function duplicate(s: Awaited<ReturnType<typeof setup>>) {
      const payer = lineUser('Payer');
      expect(await slips.claimPlayer(s.code, payer, s.ids[0])).toBe('linked');
      const reference = newRef();
      reader.read.mockResolvedValue(slip(reference, { amount: baht(await owed(s.code, s.ids[0])) }));
      expect((await slips.submitSlip(s.code, s.token, payer, IMAGE)).kind).toBe('paid');
      const sender = lineUser('Sender');
      expect((await slips.submitSlip(s.code, s.token, sender, IMAGE)).kind).toBe('duplicate');
      return { reference, sender };
    }

    it('lists this session\'s undismissed duplicates with the last six characters of the reference', async () => {
      const a = await setup();
      const b = await setup();
      const { reference, sender } = await duplicate(a);
      await duplicate(b);

      const rows = await slips.listDuplicates(a.code);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        displayName: 'Sender', lineUserId: sender.userId, referenceTail: reference.slice(-6), originalPlayerIds: [a.ids[0]],
      });
      expect(rows[0].referenceTail).toHaveLength(6);
      expect(JSON.stringify(rows[0])).not.toContain(reference);
      expect(typeof rows[0].createdAt).toBe('string');
    });

    it('dismisses a duplicate once, only from its own session', async () => {
      const a = await setup();
      const b = await setup();
      await duplicate(a);
      const [row] = await slips.listDuplicates(a.code);

      await expect(slips.dismissDuplicate(b.code, row.id)).rejects.toMatchObject({ status: 404 });
      await slips.dismissDuplicate(a.code, row.id);
      expect(await slips.listDuplicates(a.code)).toEqual([]);
      await expect(slips.dismissDuplicate(a.code, row.id)).rejects.toMatchObject({ status: 404 });
    });

    it('rejects an unknown session', async () => {
      await expect(slips.listDuplicates('nope-nope')).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('updateSavedReceiverName', () => {
    /** A linked sender with the right amount whose slip is addressed to a differently named receiver. */
    async function receiverWaiting(s: Awaited<ReturnType<typeof setup>>) {
      const user = lineUser('Sender');
      expect(await slips.claimPlayer(s.code, user, s.ids[0])).toBe('linked');
      return waiting(s.code, s.token, await owed(s.code, s.ids[0]), { receiver: OTHER_RECEIVER, user });
    }

    it('sets only the name of the saved account, leaves the slip waiting and pays no one', async () => {
      const s = await setup();
      const { row } = await receiverWaiting(s);
      expect(row).toMatchObject({ reason: 'receiver', receiverTail: '5953' });
      expect(row.receiverName).toContain('คนอื่น');

      await slips.updateSavedReceiverName(s.code, row.id);

      expect(await savedAccount(s.groupCode)).toEqual({ bank: ACCOUNT.bank, number: ACCOUNT.number, name: row.receiverName });
      expect(await slips.listWaiting(s.code)).toHaveLength(1);
      expect(await paymentsOf(s.code)).toEqual([]);
    });

    it('refuses a slip held for another reason', async () => {
      const s = await setup();
      const { row } = await waiting(s.code, s.token, 33300);
      expect(row.reason).toBe('unmapped');
      await expect(slips.updateSavedReceiverName(s.code, row.id)).rejects.toMatchObject({
        response: { code: 'NAME_UPDATE_NOT_APPLICABLE' },
      });
      expect(await savedAccount(s.groupCode)).toEqual(ACCOUNT);
    });

    it('refuses an amount-reason slip even for a linked sender', async () => {
      const s = await setup();
      const user = lineUser('Sender');
      await slips.claimPlayer(s.code, user, s.ids[0]);
      const { row } = await waiting(s.code, s.token, 33300, { user });
      expect(row.reason).toBe('amount');
      await expect(slips.updateSavedReceiverName(s.code, row.id)).rejects.toMatchObject({
        response: { code: 'NAME_UPDATE_NOT_APPLICABLE' },
      });
    });

    it('refuses when no account is saved any more', async () => {
      const s = await setup();
      const { row } = await receiverWaiting(s);
      await prisma.group.update({ where: { code: s.groupCode }, data: { payAccount: null } });
      await expect(slips.updateSavedReceiverName(s.code, row.id)).rejects.toMatchObject({
        response: { code: 'NAME_UPDATE_NOT_APPLICABLE' },
      });
    });

    it('refuses a resolved slip, and another session\'s slip is not found', async () => {
      const a = await setup();
      const b = await setup();
      const { row } = await receiverWaiting(a);
      await expect(slips.updateSavedReceiverName(b.code, row.id)).rejects.toMatchObject({ status: 404 });
      await slips.dismissWaiting(a.code, row.id);
      await expect(slips.updateSavedReceiverName(a.code, row.id)).rejects.toMatchObject({ status: 404 });
    });

    it('refuses a name the pay-account rules reject, leaving the account as it was', async () => {
      const s = await setup();
      const { row } = await receiverWaiting(s);
      await prisma.pendingSlip.update({ where: { id: row.id }, data: { receiverName: 'ก'.repeat(81) } });
      await expect(slips.updateSavedReceiverName(s.code, row.id)).rejects.toMatchObject({
        response: { code: 'PAY_ACCOUNT_INVALID' },
      });
      expect(await savedAccount(s.groupCode)).toEqual(ACCOUNT);
    });
  });
});
