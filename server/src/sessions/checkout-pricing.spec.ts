import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  activeCheckouts,
  parseCheckoutBreakdown,
  parseCheckoutSnapshot,
  serializeCheckoutBreakdown,
  serializeCheckoutSnapshot,
  type CheckoutBreakdown,
  type CheckoutSnapshot,
} from './checkout-pricing.js';

const breakdown: CheckoutBreakdown = {
  baseSatang: 3000,
  shuttleSatang: 1234,
  hostFeeSatang: 500,
  walkInFeeSatang: 2000,
  discountSatang: 700,
};

const snapshot: CheckoutSnapshot = {
  version: 1,
  hash: 'abc123',
  games: 3,
  shuttleIds: ['n000001', 'n000002'],
  shuttlePriceSatang: 1000,
  walkIn: true,
};

describe('checkout ledger records', () => {
  it('checkout ledger: breakdown and snapshot round-trip integer satang exactly', () => {
    expect(parseCheckoutBreakdown(serializeCheckoutBreakdown(breakdown))).toEqual(breakdown);
    const big = { ...breakdown, baseSatang: 2147483647 };
    expect(parseCheckoutBreakdown(serializeCheckoutBreakdown(big)).baseSatang).toBe(2147483647);
    expect(parseCheckoutSnapshot(serializeCheckoutSnapshot(snapshot))).toEqual(snapshot);
  });

  it('checkout ledger: corrupt money fails loudly instead of reading as zero', () => {
    expect(() => parseCheckoutBreakdown('{not json')).toThrow(/checkout/i);
    expect(() => parseCheckoutBreakdown(JSON.stringify({ ...breakdown, baseSatang: 10.5 }))).toThrow(/checkout/i);
    expect(() => parseCheckoutBreakdown(JSON.stringify({ ...breakdown, shuttleSatang: -1 }))).toThrow(/checkout/i);
    expect(() => parseCheckoutBreakdown(JSON.stringify({ baseSatang: 1 }))).toThrow(/checkout/i);
    expect(() => parseCheckoutSnapshot(JSON.stringify({ ...snapshot, version: 99 }))).toThrow(/checkout/i);
    expect(() => parseCheckoutSnapshot('[]')).toThrow(/checkout/i);
  });

  it('checkout ledger: only entries not undone count as current settlements', () => {
    const rows = [
      { playerId: 'a', undoneAt: null },
      { playerId: 'b', undoneAt: new Date() },
      { playerId: 'c', undoneAt: null },
    ];
    expect([...activeCheckouts(rows)].sort()).toEqual(['a', 'c']);
    expect(activeCheckouts([])).toEqual(new Set());
  });
});

describe('checkout ledger persistence', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule] }).compile();
    prisma = moduleRef.get(PrismaService);
  });

  async function seed() {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode } });
    await prisma.session.create({ data: { code: sessionCode, groupId: groupCode, rawImportText: '', shuttleToolsEnabled: true } });
    const player = await prisma.player.create({ data: { groupId: groupCode, name: 'A', aliases: '[]' } });
    const cleanup = async () => {
      await prisma.sessionCheckout.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    };
    return { sessionCode, player, cleanup };
  }

  const entry = (sessionCode: string, playerId: string, key: string, extra: Record<string, unknown> = {}) => ({
    sessionId: sessionCode,
    playerId,
    model: 'perGame',
    amountSatang: 4200,
    breakdown: serializeCheckoutBreakdown(breakdown),
    snapshot: serializeCheckoutSnapshot(snapshot),
    idempotencyKey: key,
    ...extra,
  });

  it('checkout ledger: an undone settlement and a later active one persist as separate rows', async () => {
    const { sessionCode, player, cleanup } = await seed();
    try {
      await prisma.sessionCheckout.create({ data: entry(sessionCode, player.id, 'k1', { undoneAt: new Date() }) });
      await prisma.sessionCheckout.create({ data: entry(sessionCode, player.id, 'k2') });
      const rows = await prisma.sessionCheckout.findMany({ where: { sessionId: sessionCode }, orderBy: { settledAt: 'asc' } });
      expect(rows).toHaveLength(2);
      expect([...activeCheckouts(rows)]).toEqual([player.id]);
    } finally {
      await cleanup();
    }
  });

  it('checkout ledger: the database rejects a repeated (session, idempotency key)', async () => {
    const { sessionCode, player, cleanup } = await seed();
    try {
      await prisma.sessionCheckout.create({ data: entry(sessionCode, player.id, 'same') });
      await expect(prisma.sessionCheckout.create({ data: entry(sessionCode, player.id, 'same') })).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it('checkout ledger: the same idempotency key is fine in a different session', async () => {
    const a = await seed();
    const b = await seed();
    try {
      await prisma.sessionCheckout.create({ data: entry(a.sessionCode, a.player.id, 'shared') });
      await prisma.sessionCheckout.create({ data: entry(b.sessionCode, b.player.id, 'shared') });
      expect(await prisma.sessionCheckout.count({ where: { idempotencyKey: 'shared', sessionId: { in: [a.sessionCode, b.sessionCode] } } })).toBe(2);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });
});
