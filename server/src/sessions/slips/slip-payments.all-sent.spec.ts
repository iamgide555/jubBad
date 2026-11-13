import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import { ENDED_AT, slipDateLine } from '../../../test/slip-http.fixture.js';
import { AppModule } from '../../app.module.js';
import { AuthBootstrapService } from '../../auth/bootstrap.service.js';
import { LineClient } from '../../line/line-client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { BillService } from '../bill.service.js';
import { newShareToken, parsePaymentState, serializePaymentState } from '../payment-card-state.js';
import { PaymentCardService } from '../payment-card.service.js';
import type { OcrLine } from './slip-match.js';
import { SlipPaymentsService, type LiffUser } from './slip-payments.service.js';
import { SlipReader, type SlipRead } from './slip-reader.js';

const ACCOUNT = { bank: 'กสิกร', number: '123-4-56789-0', name: 'สมหญิง ใจดี' };
const RECEIVER = 'น.ส. สมหญิง ใจดี';
const NAMES = ['สมชาย', 'มาลี', 'ต้อม', 'นิด'];
const IMAGE = Buffer.from('fake image bytes');
const LIFF_ID = '1234567890-AbCdEfGh';

const baht = (satang: number) =>
  `${Math.floor(satang / 100).toLocaleString('en-US')}.${String(satang % 100).padStart(2, '0')}`;

function slip(reference: string, amount: string | null): SlipRead {
  const madeAt = new Date(ENDED_AT.getTime() - 3_600_000);
  const texts = [
    'โอนเงินสำเร็จ',
    slipDateLine(madeAt),
    'นาย ทดสอบ ผู้โอน',
    'xxx-xxx-1234',
    RECEIVER,
    'xxx-xxx-5953',
    ...(amount === null ? [] : [`จำนวน: ${amount} บาท`]),
  ];
  const lines: OcrLine[] = texts.map((text, i) => ({ text, y0: i * 100, y1: i * 100 + 60 }));
  return { kind: 'slip', qr: { bankCode: '004', reference }, ocr: { text: texts.join('\n'), lines } };
}

const lineUserIds: string[] = [];
const newLineId = () => {
  const id = `U${randomUUID().replace(/-/g, '')}`;
  lineUserIds.push(id);
  return id;
};
const lineUser = (name = 'Somchai'): LiffUser => ({ userId: newLineId(), displayName: name, pictureUrl: null });
const newRef = () => `REF${randomUUID().replace(/-/g, '').slice(0, 16)}`;

describe('slip payments: all-sent notice', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cards: PaymentCardService;
  let bills: BillService;
  let slips: SlipPaymentsService;
  const reader = { read: vi.fn<(image: Buffer) => Promise<SlipRead>>() };
  const fakeClient = {
    push: vi.fn<(to: string, messages: unknown[], key?: string) => Promise<string>>(),
    friendStatus: vi.fn<(id: string) => Promise<boolean | null>>(),
  };
  const groupCodes: string[] = [];
  const userIds: string[] = [];
  const saved = { ...process.env };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuthBootstrapService)
      .useValue({ onModuleInit: async () => {} })
      .overrideProvider(SlipReader)
      .useValue(reader)
      .overrideProvider(LineClient)
      .useValue(fakeClient)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    cards = app.get(PaymentCardService);
    bills = app.get(BillService);
    slips = app.get(SlipPaymentsService);
  });

  beforeEach(() => {
    reader.read.mockReset();
    fakeClient.push.mockReset().mockResolvedValue('ok');
    fakeClient.friendStatus.mockReset().mockResolvedValue(true);
    process.env.LINE_CHANNEL_SECRET = 's';
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 't';
    process.env.PUBLIC_APP_URL = 'https://jubbad.test';
    process.env.LINE_LIFF_ID = LIFF_ID;
    process.env.LINE_LOGIN_CHANNEL_ID = '1234567890';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

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
    await prisma.lineAccount.deleteMany({ where: { lineUserId: { in: lineUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  /** A host-plan owner who linked their own LINE account (so the bot can message them). */
  async function host(lineId: string | null = newLineId()) {
    const user = await prisma.user.create({
      data: { email: `${randomUUID()}@allsent.test`, passwordHash: 'x', plan: 'host', planRenewsAt: null, lineUserId: lineId },
    });
    userIds.push(user.id);
    return { ownerId: user.id, lineId };
  }

  /** Writes a confirmed card for the bill as it stands. Calling it again is a re-confirm: a fresh state, no notice mark. */
  async function confirm(code: string, token: string) {
    const write = (confirmedHash: string) =>
      prisma.session.update({
        where: { code },
        data: {
          paymentCard: serializePaymentState({
            account: ACCOUNT, token, confirmedAt: new Date().toISOString(), confirmedHash, lastSentAt: null, lastDmAt: null,
          }),
        },
      });
    await write('pending');
    await write((await cards.panel(code)).contentHash);
  }

  async function setup(options: { ownerId?: string } = {}) {
    const groupCode = `all-${randomUUID().slice(0, 10)}`;
    groupCodes.push(groupCode);
    await prisma.group.create({
      data: { code: groupCode, name: 'ตีชิล', payAccount: JSON.stringify(ACCOUNT), ownerId: options.ownerId },
    });
    const ids: string[] = [];
    for (const name of NAMES) ids.push((await prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })).id);
    const code = `s${randomUUID().slice(0, 8)}`;
    await prisma.session.create({
      data: { code, groupId: groupCode, rawImportText: '', date: '2026-10-30', venue: 'Bad@Mama', shuttleCount: 3, shuttlePriceSatang: 8000 },
    });
    for (const id of ids) await prisma.sessionRoster.create({ data: { sessionId: code, playerId: id } });
    const at = new Date('2026-10-30T13:00:00Z');
    await prisma.pairing.create({
      data: {
        sessionId: code, courtNumber: 1, matchNumber: 1, teamA: JSON.stringify(ids.slice(0, 2)), teamB: JSON.stringify(ids.slice(2)),
        winner: 'A', confirmedAt: at, endedAt: at,
      },
    });
    await bills.setBillConfig(code, {
      model: 'fair', courtFeeSatang: 60000, courtSplit: 'equal', shuttleSplit: 'byGames', perGameRateSatang: 0, entryFeeSatang: 0,
      capSatang: null, buffetPriceSatang: 0, buffetShuttlesIncluded: true, startingFeeSatang: 0, hostFeeSatang: 0, walkInFeeSatang: 0,
      roundingBaht: 1, addedIds: [], removedIds: [], overrides: [],
    } as never);
    await prisma.session.update({ where: { code }, data: { endedAt: ENDED_AT } });
    const token = newShareToken();
    await confirm(code, token);
    return { groupCode, ids, code, token };
  }

  const tickAll = async (code: string, ids: string[]) => {
    for (const id of ids) await slips.tick(code, id);
  };
  const owed = async (code: string, playerId: string) =>
    (await cards.panel(code)).rows.find((r) => r.playerId === playerId)!.amountSatang;
  const notifiedAt = async (code: string) =>
    parsePaymentState((await prisma.session.findUniqueOrThrow({ where: { code } })).paymentCard).allSentNotifiedAt;
  const pushedTo = () => fakeClient.push.mock.calls.map((c) => c[0]);
  const altText = (call = 0) => (fakeClient.push.mock.calls[call][1][0] as { altText: string }).altText;

  /** Makes `playerId` the bill's เจ้าของบัญชี, linked to its own LINE account. */
  async function makeCollector(groupCode: string, code: string, playerId: string) {
    const u = lineUser('Collector');
    expect(await slips.claimPlayer(code, u, playerId)).toBe('linked');
    await prisma.group.update({ where: { code: groupCode }, data: { payCollectorPlayerId: playerId, payCollectorLineUserId: u.userId } });
    return u;
  }

  it('tells the host once the last person pays by slip, and says everyone paid', async () => {
    const { ownerId, lineId } = await host();
    const { code, ids, token } = await setup({ ownerId });
    await tickAll(code, ids.slice(0, 3));
    const sender = lineUser();
    expect(await slips.claimPlayer(code, sender, ids[3])).toBe('linked');
    reader.read.mockResolvedValue(slip(newRef(), baht(await owed(code, ids[3]))));

    expect(await slips.submitSlip(code, token, sender, IMAGE)).toEqual({ kind: 'paid', playerIds: [ids[3]] });
    await vi.waitFor(() => expect(fakeClient.push).toHaveBeenCalledTimes(1));

    expect(pushedTo()).toEqual([lineId]);
    expect(altText()).toContain('ทุกคนจ่ายครบแล้ว');
    expect(await notifiedAt(code)).not.toBeNull();
  });

  it('does not tell anyone while somebody still owes and has sent nothing', async () => {
    const { ownerId } = await host();
    const { code, ids } = await setup({ ownerId });
    await tickAll(code, ids.slice(0, 2));
    expect(await cards.notifyAllSent(code)).toBe('unavailable');
    expect(fakeClient.push).not.toHaveBeenCalled();
    expect(await notifiedAt(code)).toBeNull();
  });

  it('counts a slip held for review as sent, and says how many are waiting', async () => {
    const { ownerId, lineId } = await host();
    const { code, ids, token } = await setup({ ownerId });
    await tickAll(code, ids.slice(0, 3));
    const sender = lineUser();
    expect(await slips.claimPlayer(code, sender, ids[3])).toBe('linked');
    // The wrong amount: held for the host, but the sender has done their part.
    reader.read.mockResolvedValue(slip(newRef(), baht((await owed(code, ids[3])) + 5000)));

    expect((await slips.submitSlip(code, token, sender, IMAGE)).kind).not.toBe('paid');
    await vi.waitFor(() => expect(fakeClient.push).toHaveBeenCalledTimes(1));

    expect(pushedTo()).toEqual([lineId]);
    expect(altText()).toContain('ทุกคนส่งสลิปครบแล้ว');
    expect(altText()).toContain('รอตรวจ 1 ใบ');
  });

  it('lets a waiting slip from an unlinked sender stand in for the last unpaid person', async () => {
    const { ownerId } = await host();
    const { code, ids, token } = await setup({ ownerId });
    await tickAll(code, ids.slice(0, 3));
    reader.read.mockResolvedValue(slip(newRef(), baht(await owed(code, ids[3]))));

    expect((await slips.submitSlip(code, token, lineUser('Stranger'), IMAGE)).kind).toBe('waiting');
    await vi.waitFor(() => expect(fakeClient.push).toHaveBeenCalledTimes(1));
    expect(altText()).toContain('รอตรวจ 1 ใบ');
  });

  it('notifies once per confirm: a repeat does nothing, a re-confirmed card can notify again', async () => {
    const { ownerId } = await host();
    const { code, ids, token } = await setup({ ownerId });
    await tickAll(code, ids);

    expect(await cards.notifyAllSent(code)).toBe('sent');
    expect(await cards.notifyAllSent(code)).toBe('unavailable');
    expect(fakeClient.push).toHaveBeenCalledTimes(1);

    await confirm(code, token);
    expect(await notifiedAt(code)).toBeNull();
    expect(await cards.notifyAllSent(code)).toBe('sent');
    expect(fakeClient.push).toHaveBeenCalledTimes(2);
    // Different confirms, different retry keys: LINE must not drop the second as a retry of the first.
    expect(fakeClient.push.mock.calls[0][2]).not.toEqual(fakeClient.push.mock.calls[1][2]);
  });

  it('also tells a เจ้าของบัญชี who is someone else, and counts them as owing nothing', async () => {
    const { ownerId, lineId } = await host();
    const { groupCode, code, ids } = await setup({ ownerId });
    const collector = await makeCollector(groupCode, code, ids[3]);
    // Three people pay; the เจ้าของบัญชี (ids[3]) never has to.
    await tickAll(code, ids.slice(0, 3));

    expect(await cards.notifyAllSent(code)).toBe('sent');
    expect(pushedTo().sort()).toEqual([lineId, collector.userId].sort());
  });

  it('sends a single message when the host is also the เจ้าของบัญชี', async () => {
    const shared = newLineId();
    const { ownerId } = await host(shared);
    const { groupCode, code, ids } = await setup({ ownerId });
    expect(await slips.claimPlayer(code, { userId: shared, displayName: 'Host', pictureUrl: null }, ids[3])).toBe('linked');
    await prisma.group.update({ where: { code: groupCode }, data: { payCollectorPlayerId: ids[3], payCollectorLineUserId: shared } });
    await tickAll(code, ids.slice(0, 3));

    expect(await cards.notifyAllSent(code)).toBe('sent');
    expect(pushedTo()).toEqual([shared]);
  });

  it('skips a เจ้าของบัญชี who has not added the bot, without spending a push, and still tells the host', async () => {
    const { ownerId, lineId } = await host();
    const { groupCode, code, ids } = await setup({ ownerId });
    const collector = await makeCollector(groupCode, code, ids[3]);
    fakeClient.friendStatus.mockImplementation(async (id) => id !== collector.userId);
    await tickAll(code, ids.slice(0, 3));

    expect(await cards.notifyAllSent(code)).toBe('sent');
    expect(pushedTo()).toEqual([lineId]);
    expect(await notifiedAt(code)).not.toBeNull();
  });

  it('tries anyway when LINE cannot say whether the recipient is a friend', async () => {
    const { ownerId, lineId } = await host();
    const { code, ids } = await setup({ ownerId });
    fakeClient.friendStatus.mockResolvedValue(null);
    await tickAll(code, ids);

    expect(await cards.notifyAllSent(code)).toBe('sent');
    expect(pushedTo()).toEqual([lineId]);
  });

  it('sends nothing when nobody can be messaged (no linked LINE for the owner)', async () => {
    const { ownerId } = await host(null);
    const { code, ids } = await setup({ ownerId });
    await tickAll(code, ids);
    expect(await cards.notifyAllSent(code)).toBe('unavailable');
    expect(fakeClient.push).not.toHaveBeenCalled();
  });

  it('sends nothing, and records nothing, when the only recipient is not a friend', async () => {
    const { ownerId } = await host();
    const { code, ids } = await setup({ ownerId });
    fakeClient.friendStatus.mockResolvedValue(false);
    await tickAll(code, ids);
    expect(await cards.notifyAllSent(code)).toBe('failed');
    expect(fakeClient.push).not.toHaveBeenCalled();
    expect(await notifiedAt(code)).toBeNull();
  });

  it.each(['LINE_LIFF_ID', 'LINE_LOGIN_CHANNEL_ID'])('sends nothing without %s (the button could not work)', async (name) => {
    const { ownerId } = await host();
    const { code, ids } = await setup({ ownerId });
    await tickAll(code, ids);
    delete process.env[name];
    expect(await cards.notifyAllSent(code)).toBe('unavailable');
    expect(fakeClient.push).not.toHaveBeenCalled();
  });

  it('sends nothing once collection is closed', async () => {
    const { ownerId } = await host();
    const { code, ids } = await setup({ ownerId });
    await tickAll(code, ids);
    await prisma.session.update({ where: { code }, data: { paymentCollectionClosedAt: new Date() } });
    expect(await cards.notifyAllSent(code)).toBe('unavailable');
    expect(fakeClient.push).not.toHaveBeenCalled();
  });

  it('is not triggered by the host ticking the last person', async () => {
    const { ownerId } = await host();
    const { code, ids } = await setup({ ownerId });
    await tickAll(code, ids);
    // Give any stray fire-and-forget work a turn to run before asserting there was none.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fakeClient.push).not.toHaveBeenCalled();
  });

  it('keeps no mark after a failed push, so a later slip tries again', async () => {
    const { ownerId } = await host();
    const { code, ids } = await setup({ ownerId });
    await tickAll(code, ids);
    fakeClient.push.mockResolvedValueOnce('failed');

    expect(await cards.notifyAllSent(code)).toBe('failed');
    expect(await notifiedAt(code)).toBeNull();
    expect(await cards.notifyAllSent(code)).toBe('sent');
    expect(fakeClient.push).toHaveBeenCalledTimes(2);
  });

  it('never throws to the caller, even when LINE does', async () => {
    const { ownerId } = await host();
    const { code, ids } = await setup({ ownerId });
    await tickAll(code, ids);
    fakeClient.push.mockRejectedValueOnce(new Error('boom'));
    expect(await cards.notifyAllSent(code)).toBe('failed');
  });
});
