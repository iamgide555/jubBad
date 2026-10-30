import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { SESSION_SECRET } from '../src/auth/auth.module.js';
import { LoginThrottle } from '../src/auth/login-throttle.js';
import { AuthBootstrapService } from '../src/auth/bootstrap.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { UsersService } from '../src/users/users.service.js';
import { BillService } from '../src/sessions/bill.service.js';
import { newShareToken, serializePaymentState } from '../src/sessions/payment-card-state.js';
import { PaymentCardService } from '../src/sessions/payment-card.service.js';
import { LiffIdentity } from '../src/sessions/slips/liff-identity.js';
import type { OcrLine } from '../src/sessions/slips/slip-match.js';
import type { LiffUser } from '../src/sessions/slips/slip-payments.service.js';
import { SlipReader, type SlipRead } from '../src/sessions/slips/slip-reader.js';
import { SLIP_FAILURE_THROTTLE, SLIP_UPLOAD_THROTTLE } from '../src/sessions/slips/slip-throttles.js';

/** Shared setup for the slip HTTP specs: the whole AppModule with the LINE and OCR edges stubbed, and a real DB. */
export const SECRET = 'slip-http-test-secret';
export const PASSWORD = 'a genuinely correct password';
export const ACCOUNT = { bank: 'กสิกร', number: '123-4-56789-0', name: 'สมหญิง ใจดี' };
export const NAMES = ['สมชาย', 'มาลี', 'ต้อม', 'นิด'];
const RECEIVER = 'น.ส. สมหญิง ใจดี';
const SENDER = 'นาย ทดสอบ ผู้โอน';

export const baht = (satang: number) =>
  `${Math.floor(satang / 100).toLocaleString('en-US')}.${String(satang % 100).padStart(2, '0')}`;

export const newRef = () => `REF${randomUUID().replace(/-/g, '').slice(0, 16)}`;

export const lineUser = (name = 'Somchai'): LiffUser => ({
  userId: `U${randomUUID().replace(/-/g, '')}`,
  displayName: name,
  pictureUrl: null,
});

/** A slip the way OCR reads it, showing `amount` (satang) as the transferred amount. */
export function slipRead(reference: string, amountSatang: number | null): SlipRead {
  const texts = [
    '30 ต.ค. 69 21:04',
    SENDER,
    'xxx-xxx-1234',
    RECEIVER,
    'xxx-xxx-5953',
    ...(amountSatang === null ? [] : [`จำนวน: ${baht(amountSatang)} บาท`]),
  ];
  const lines: OcrLine[] = texts.map((text, i) => ({ text, y0: i * 100, y1: i * 100 + 60 }));
  return { kind: 'slip', qr: { bankCode: '004', reference }, ocr: { text: texts.join('\n'), lines } };
}

/** A `LoginThrottle` a spec can empty between tests (the address key is shared by every request from this process). */
export class ResettableThrottle {
  private inner = new LoginThrottle();
  check = (key: string) => this.inner.check(key);
  recordFailure = (key: string) => this.inner.recordFailure(key);
  recordSuccess = (key: string) => this.inner.recordSuccess(key);
  reset() {
    this.inner = new LoginThrottle();
  }
}

export async function bootSlipApp() {
  const failures = new ResettableThrottle();
  const uploads = new ResettableThrottle();
  const liff = { verify: vi.fn<(accessToken: string) => Promise<LiffUser | null>>() };
  const reader = { read: vi.fn<(image: Buffer) => Promise<SlipRead>>() };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SESSION_SECRET)
    .useValue(SECRET)
    .overrideProvider(AuthBootstrapService)
    .useValue({ onModuleInit: async () => {} })
    .overrideProvider(LiffIdentity)
    .useValue(liff)
    .overrideProvider(SlipReader)
    .useValue(reader)
    .overrideProvider(SLIP_FAILURE_THROTTLE)
    .useValue(failures)
    .overrideProvider(SLIP_UPLOAD_THROTTLE)
    .useValue(uploads)
    .compile();
  const app: INestApplication = moduleRef.createNestApplication({ rawBody: true });
  app.use(cookieParser(SECRET));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();
  const server = app.getHttpServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const prisma = app.get(PrismaService);
  const cards = app.get(PaymentCardService);
  const bills = app.get(BillService);
  const groupCodes: string[] = [];
  const userIds: string[] = [];

  /** A host account (plan `host` unless told otherwise) that is logged in. */
  async function owner(plan = 'host', planRenewsAt: Date | null = null) {
    const email = `slip-http-${randomUUID()}@example.test`;
    const user = await app.get(UsersService).create(email, PASSWORD);
    userIds.push(user.id);
    await prisma.user.update({ where: { id: user.id }, data: { plan, planRenewsAt } });
    const res = await request(server).post('/auth/login').send({ email, password: PASSWORD }).expect(201);
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0];
    return { id: user.id, cookie };
  }

  /** Writes a confirmed card for the bill as it stands. */
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
  }

  /** An ended session of four players with a bill and a confirmed card, owned by `ownerId`. */
  async function setup(ownerId: string) {
    const groupCode = `sh-${randomUUID().slice(0, 10)}`;
    groupCodes.push(groupCode);
    await prisma.group.create({
      data: { code: groupCode, name: 'ตีชิล', payAccount: JSON.stringify(ACCOUNT), ownerId },
    });
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
    await bills.setBillConfig(code, {
      model: 'fair', courtFeeSatang: 60000, courtSplit: 'equal', shuttleSplit: 'byGames',
      perGameRateSatang: 0, entryFeeSatang: 0, capSatang: null, buffetPriceSatang: 0,
      buffetShuttlesIncluded: true, startingFeeSatang: 0, hostFeeSatang: 0, walkInFeeSatang: 0, roundingBaht: 1,
      addedIds: [], removedIds: [], overrides: [],
    } as never);
    await prisma.session.update({ where: { code }, data: { endedAt: new Date('2026-10-30T15:00:00Z') } });
    const token = newShareToken();
    await confirm(code, token);
    return { groupCode, ids, code, token };
  }

  const owed = async (code: string, playerId: string) =>
    (await cards.panel(code)).rows.find((r) => r.playerId === playerId)!.amountSatang;

  async function cleanup() {
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
  }

  const resetThrottles = () => {
    failures.reset();
    uploads.reset();
  };

  return { app, server, prisma, cards, liff, reader, owner, confirm, setup, owed, cleanup, resetThrottles };
}
