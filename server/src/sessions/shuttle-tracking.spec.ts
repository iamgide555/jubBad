import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Persistence rules for numbered, reusable shuttles (host feedback D): a
 * session-owned identity per physical shuttle, a many-to-many link from games
 * to the shuttles they used, and an explicit known/unknown log marker so a
 * legacy game is never confused with a game that really used none.
 */
describe('numbered shuttle persistence', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule] }).compile();
    prisma = moduleRef.get(PrismaService);
  });

  async function seed() {
    const groupCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'S' } });
    const sessionA = randomUUID();
    const sessionB = randomUUID();
    for (const code of [sessionA, sessionB]) {
      await prisma.session.create({ data: { code, groupId: groupCode, rawImportText: '', shuttleToolsEnabled: true } });
    }
    const cleanup = async () => {
      await prisma.pairingShuttleUse.deleteMany({ where: { pairing: { sessionId: { in: [sessionA, sessionB] } } } });
      await prisma.pairing.deleteMany({ where: { sessionId: { in: [sessionA, sessionB] } } });
      await prisma.sessionShuttle.deleteMany({ where: { sessionId: { in: [sessionA, sessionB] } } });
      await prisma.session.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    };
    return { sessionA, sessionB, cleanup };
  }

  const pairing = (sessionId: string, extra: Record<string, unknown> = {}) =>
    prisma.pairing.create({
      data: { sessionId, courtNumber: 1, matchNumber: 1, teamA: '["a","b"]', teamB: '["c","d"]', ...extra },
    });

  it('numbered shuttle: a legacy pairing is unknown, a known game with no uses is zero', async () => {
    const { sessionA, cleanup } = await seed();
    try {
      const legacy = await pairing(sessionA);
      expect(legacy.shuttleLogKnown).toBe(false);
      expect(legacy.lastShuttleId).toBeNull();

      const known = await pairing(sessionA, { matchNumber: 2, shuttleLogKnown: true });
      expect(known.shuttleLogKnown).toBe(true);
      const uses = await prisma.pairingShuttleUse.findMany({ where: { pairingId: known.id } });
      expect(uses).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('numbered shuttle: rejects a duplicate session number and a duplicate game/shuttle link', async () => {
    const { sessionA, cleanup } = await seed();
    try {
      const shuttle = await prisma.sessionShuttle.create({ data: { sessionId: sessionA, number: 1 } });
      await expect(
        prisma.sessionShuttle.create({ data: { sessionId: sessionA, number: 1 } })
      ).rejects.toThrow();

      const game = await pairing(sessionA);
      await prisma.pairingShuttleUse.create({ data: { pairingId: game.id, shuttleId: shuttle.id } });
      await expect(
        prisma.pairingShuttleUse.create({ data: { pairingId: game.id, shuttleId: shuttle.id } })
      ).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it('numbered shuttle: two sessions may each own a number 1, usable and unvoided by default', async () => {
    const { sessionA, sessionB, cleanup } = await seed();
    try {
      const a = await prisma.sessionShuttle.create({ data: { sessionId: sessionA, number: 1 } });
      const b = await prisma.sessionShuttle.create({ data: { sessionId: sessionB, number: 1 } });
      expect(a.id).not.toBe(b.id);
      expect(a.usable).toBe(true);
      expect(a.voidedAt).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('numbered shuttle: a voided identity stays stored and keeps reserving its number', async () => {
    const { sessionA, cleanup } = await seed();
    try {
      const shuttle = await prisma.sessionShuttle.create({ data: { sessionId: sessionA, number: 1 } });
      await prisma.sessionShuttle.update({ where: { id: shuttle.id }, data: { voidedAt: new Date() } });
      expect(await prisma.sessionShuttle.count({ where: { sessionId: sessionA } })).toBe(1);
      await expect(
        prisma.sessionShuttle.create({ data: { sessionId: sessionA, number: 1 } })
      ).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});
