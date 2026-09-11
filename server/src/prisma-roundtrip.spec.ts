import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

describe('Prisma schema round-trip', () => {
  it('persists and reads back every model, including JSON-encoded array columns', async () => {
    const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL! });
    const prisma = new PrismaClient({ adapter });
    const groupCode = `test-group-${randomUUID()}`;
    const sessionCode = `test-session-${randomUUID()}`;
    try {
      const group = await prisma.group.create({
        data: { code: groupCode, name: 'Test Group' },
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
          code: sessionCode,
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
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
      await prisma.$disconnect();
    }
  });

  it('persists and reads back the auth models added for per-user login', async () => {
    const adapter = new PrismaBetterSqlite3({ url: process.env.DATABASE_URL! });
    const prisma = new PrismaClient({ adapter });
    const email = `test-user-${randomUUID()}@example.test`;
    const groupCode = `test-owned-group-${randomUUID()}`;
    let userId: string | undefined;
    try {
      const user = await prisma.user.create({
        data: { email, passwordHash: 'scrypt$test$hash' },
      });
      userId = user.id;

      // Group.ownerId is nullable at the schema level, but every group created
      // through the app always has one — see the schema comment on the column.
      const group = await prisma.group.create({
        data: { code: groupCode, name: 'Owned Group', ownerId: user.id },
      });

      const reset = await prisma.passwordReset.create({
        data: {
          userId: user.id,
          tokenHash: `hash-${randomUUID()}`,
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });

      const request = await prisma.passwordResetRequest.create({
        data: { email },
      });

      const readBackGroup = await prisma.group.findUniqueOrThrow({
        where: { code: groupCode },
      });
      const readBackReset = await prisma.passwordReset.findUniqueOrThrow({
        where: { id: reset.id },
      });
      const readBackRequest = await prisma.passwordResetRequest.findUniqueOrThrow({
        where: { id: request.id },
      });

      expect(readBackGroup.ownerId).toBe(user.id);
      expect(readBackReset.userId).toBe(user.id);
      expect(readBackReset.usedAt).toBeNull();
      expect(readBackRequest.email).toBe(email);
      expect(readBackRequest.handledAt).toBeNull();
    } finally {
      await prisma.passwordResetRequest.deleteMany({ where: { email } });
      await prisma.passwordReset.deleteMany({ where: { userId } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
      if (userId) await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.$disconnect();
    }
  });
});
