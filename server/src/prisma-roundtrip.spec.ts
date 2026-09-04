import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@prisma/client';

describe('Prisma schema round-trip', () => {
  it('persists and reads back every model, including JSON-encoded array columns', async () => {
    const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL! });
    const prisma = new PrismaClient({ adapter });
    try {
      const group = await prisma.group.create({
        data: { code: 'test-group', name: 'Test Group' },
      });

      const player = await prisma.player.create({
        data: {
          groupId: group.code,
          name: 'Alice',
          aliases: JSON.stringify(['Al', 'Ally']),
        },
      });

      const session = await prisma.session.create({
        data: {
          code: 'test-session',
          groupId: group.code,
          date: '2026-09-04',
          venue: 'Court A',
          courtCount: 2,
          rawImportText: '1. Alice',
        },
      });

      await prisma.sessionRoster.create({
        data: { sessionId: session.code, playerId: player.id },
      });

      const pairing = await prisma.pairing.create({
        data: {
          sessionId: session.code,
          courtNumber: 1,
          matchNumber: 1,
          teamA: JSON.stringify([player.id, player.id]),
          teamB: JSON.stringify([player.id, player.id]),
        },
      });

      const readBackPlayer = await prisma.player.findUniqueOrThrow({
        where: { id: player.id },
      });
      const readBackPairing = await prisma.pairing.findUniqueOrThrow({
        where: { id: pairing.id },
      });
      const roster = await prisma.sessionRoster.findMany({
        where: { sessionId: session.code },
      });

      expect(JSON.parse(readBackPlayer.aliases)).toEqual(['Al', 'Ally']);
      expect(JSON.parse(readBackPairing.teamA)).toEqual([player.id, player.id]);
      expect(JSON.parse(readBackPairing.teamB)).toEqual([player.id, player.id]);
      expect(roster.map((r) => r.playerId)).toEqual([player.id]);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: 'test-session' } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: 'test-session' } });
      await prisma.session.deleteMany({ where: { code: 'test-session' } });
      await prisma.player.deleteMany({ where: { groupId: 'test-group' } });
      await prisma.group.deleteMany({ where: { code: 'test-group' } });
      await prisma.$disconnect();
    }
  });
});
