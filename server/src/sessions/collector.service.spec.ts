import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module.js';
import { AuthBootstrapService } from '../auth/bootstrap.service.js';
import { assertCollectorEligible } from '../groups/pay-collector.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CollectorService } from './collector.service.js';
import { serializePaymentState, EMPTY_PAYMENT_STATE } from './payment-card-state.js';

const ACCOUNT = { bank: 'กสิกร', number: '123-4-56789-0', name: 'สมหญิง ใจดี' };
const OTHER_ACCOUNT = { bank: 'ไทยพาณิชย์', number: '987-6-54321-0', name: 'สมชาย' };

describe('CollectorService.forBill', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let collectors: CollectorService;
  const groupCodes: string[] = [];
  const lineUserIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuthBootstrapService)
      .useValue({ onModuleInit: async () => {} })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    collectors = app.get(CollectorService);
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { groupId: { in: groupCodes } } });
    await prisma.group.updateMany({ where: { code: { in: groupCodes } }, data: { payCollectorPlayerId: null } });
    await prisma.playerLineAccount.deleteMany({ where: { groupId: { in: groupCodes } } });
    await prisma.player.deleteMany({ where: { groupId: { in: groupCodes } } });
    await prisma.group.deleteMany({ where: { code: { in: groupCodes } } });
    await prisma.lineAccount.deleteMany({ where: { lineUserId: { in: lineUserIds } } });
    await app.close();
  });

  /** A group with a saved account, two players (p1 linked to LINE, p2 linked, p3 unlinked) and one session. */
  async function setup() {
    const groupCode = `col-${randomUUID().slice(0, 10)}`;
    groupCodes.push(groupCode);
    await prisma.group.create({ data: { code: groupCode, name: 'ตีชิล', payAccount: JSON.stringify(ACCOUNT) } });
    const make = (name: string) => prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } });
    const [p1, p2, p3] = [await make('มาลี'), await make('ต้อม'), await make('นิด')];
    const link = async (playerId: string, displayName: string) => {
      const lineUserId = `U${randomUUID().replace(/-/g, '')}`;
      lineUserIds.push(lineUserId);
      await prisma.lineAccount.create({ data: { lineUserId, displayName, pictureUrl: 'https://example.com/p.png' } });
      await prisma.playerLineAccount.create({ data: { groupId: groupCode, playerId, lineUserId, linkedBy: 'host' } });
      return lineUserId;
    };
    const u1 = await link(p1.id, 'Malee LINE');
    const u2 = await link(p2.id, 'Tom LINE');
    const code = `s${randomUUID().slice(0, 8)}`;
    await prisma.session.create({
      data: { code, groupId: groupCode, rawImportText: '', date: '2026-11-02', venue: 'Bad@Mama' },
    });
    const setCard = (state: object) =>
      prisma.session.update({
        where: { code },
        data: { paymentCard: serializePaymentState({ ...EMPTY_PAYMENT_STATE, ...state } as never) },
      });
    return { groupCode, code, p1, p2, p3, u1, u2, setCard };
  }

  it('resolves the saved collector for a card on the saved account', async () => {
    const s = await setup();
    await prisma.group.update({ where: { code: s.groupCode }, data: { payCollectorPlayerId: s.p1.id } });
    await s.setCard({ account: ACCOUNT, confirmedAt: '2026-11-02T10:00:00Z' });
    expect(await collectors.forBill(s.code)).toEqual({
      playerId: s.p1.id,
      playerName: 'มาลี',
      lineUserId: s.u1,
      lineName: 'Malee LINE',
      pictureUrl: 'https://example.com/p.png',
    });
  });

  it('resolves the saved collector for a card not yet confirmed (no snapshot)', async () => {
    const s = await setup();
    await prisma.group.update({ where: { code: s.groupCode }, data: { payCollectorPlayerId: s.p1.id } });
    expect((await collectors.forBill(s.code))?.playerId).toBe(s.p1.id);
  });

  it('is null when the saved collector has no LINE link', async () => {
    const s = await setup();
    await prisma.group.update({ where: { code: s.groupCode }, data: { payCollectorPlayerId: s.p3.id } });
    expect(await collectors.forBill(s.code)).toBeNull();
  });

  it('is null when nobody is the collector', async () => {
    const s = await setup();
    expect(await collectors.forBill(s.code)).toBeNull();
  });

  it('uses the night collector when the card was confirmed with a different account', async () => {
    const s = await setup();
    await prisma.group.update({ where: { code: s.groupCode }, data: { payCollectorPlayerId: s.p1.id } });
    await s.setCard({ account: OTHER_ACCOUNT, collectorPlayerId: s.p2.id, confirmedAt: '2026-11-02T10:00:00Z' });
    expect((await collectors.forBill(s.code))?.playerId).toBe(s.p2.id);
  });

  it('is null for a different account with no night collector, even if the group has one', async () => {
    const s = await setup();
    await prisma.group.update({ where: { code: s.groupCode }, data: { payCollectorPlayerId: s.p1.id } });
    await s.setCard({ account: OTHER_ACCOUNT, confirmedAt: '2026-11-02T10:00:00Z' });
    expect(await collectors.forBill(s.code)).toBeNull();
  });

  it('still uses the group collector after only the account name changed', async () => {
    const s = await setup();
    await prisma.group.update({ where: { code: s.groupCode }, data: { payCollectorPlayerId: s.p1.id } });
    await s.setCard({ account: ACCOUNT, confirmedAt: '2026-11-02T10:00:00Z' });
    await prisma.group.update({
      where: { code: s.groupCode },
      data: { payAccount: JSON.stringify({ ...ACCOUNT, name: 'ชื่อใหม่' }) },
    });
    expect((await collectors.forBill(s.code))?.playerId).toBe(s.p1.id);
  });

  it('falls back to the night collector after the group bank or number changed', async () => {
    const s = await setup();
    await prisma.group.update({ where: { code: s.groupCode }, data: { payCollectorPlayerId: s.p1.id } });
    await s.setCard({ account: ACCOUNT, confirmedAt: '2026-11-02T10:00:00Z' });
    await prisma.group.update({ where: { code: s.groupCode }, data: { payAccount: JSON.stringify(OTHER_ACCOUNT) } });
    expect(await collectors.forBill(s.code)).toBeNull();
  });

  it('is null once the collector is unlinked from LINE', async () => {
    const s = await setup();
    await prisma.group.update({ where: { code: s.groupCode }, data: { payCollectorPlayerId: s.p1.id } });
    await prisma.playerLineAccount.deleteMany({ where: { playerId: s.p1.id } });
    expect(await collectors.forBill(s.code)).toBeNull();
  });

  it('is null for an unknown session', async () => {
    expect(await collectors.forBill('nope-no-such')).toBeNull();
  });

  describe('assertCollectorEligible', () => {
    it('accepts a linked player of the group', async () => {
      const s = await setup();
      await expect(assertCollectorEligible(prisma, s.groupCode, s.p1.id)).resolves.toBeUndefined();
    });

    it('rejects an unlinked player', async () => {
      const s = await setup();
      await expect(assertCollectorEligible(prisma, s.groupCode, s.p3.id)).rejects.toMatchObject({
        response: { code: 'COLLECTOR_INVALID' },
      });
    });

    it('rejects a player of another group', async () => {
      const s = await setup();
      const other = await setup();
      await expect(assertCollectorEligible(prisma, s.groupCode, other.p1.id)).rejects.toMatchObject({
        response: { code: 'COLLECTOR_INVALID' },
      });
    });
  });
});
