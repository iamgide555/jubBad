import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

describe('slip payment schema', () => {
  const prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: process.env.DATABASE_URL! }),
  });
  const groupCodes: string[] = [];
  const lineUserIds: string[] = [];

  afterAll(async () => {
    const where = { groupId: { in: groupCodes } };
    await prisma.session.deleteMany({ where });
    await prisma.player.deleteMany({ where });
    await prisma.group.deleteMany({ where: { code: { in: groupCodes } } });
    await prisma.lineAccount.deleteMany({ where: { lineUserId: { in: lineUserIds } } });
    await prisma.$disconnect();
  });

  /** A LINE user id unique to this run, so the global account rows never collide with other specs. */
  const lineUser = (label: string) => {
    const id = `${label}-${randomUUID()}`;
    lineUserIds.push(id);
    return id;
  };

  async function seed() {
    const groupId = `slip-group-${randomUUID()}`;
    const sessionId = `slip-session-${randomUUID()}`;
    groupCodes.push(groupId);
    await prisma.group.create({ data: { code: groupId, name: 'Slip Group' } });
    const player = await prisma.player.create({
      data: { groupId, name: 'Alice', aliases: '[]' },
    });
    const other = await prisma.player.create({
      data: { groupId, name: 'Bob', aliases: '[]' },
    });
    await prisma.session.create({
      data: { code: sessionId, groupId, rawImportText: '' },
    });
    return { groupId, sessionId, playerId: player.id, otherId: other.id, u1: lineUser('U1'), u2: lineUser('U2') };
  }

  /** A link needs its LINE account to exist first (foreign key), as LineAccountsService.touch guarantees. */
  const link = async (groupId: string, playerId: string, lineUserId: string) => {
    await prisma.lineAccount.upsert({ where: { lineUserId }, create: { lineUserId }, update: {} });
    return prisma.playerLineAccount.create({
      data: { groupId, playerId, lineUserId, linkedBy: 'self' },
    });
  };

  it('rejects a link to a LINE account that does not exist', async () => {
    const s = await seed();
    await expect(
      prisma.playerLineAccount.create({ data: { groupId: s.groupId, playerId: s.playerId, lineUserId: s.u1, linkedBy: 'self' } }),
    ).rejects.toThrow();
  });

  it("removes the account's links when the account is deleted", async () => {
    const s = await seed();
    await link(s.groupId, s.playerId, s.u1);
    await prisma.lineAccount.delete({ where: { lineUserId: s.u1 } });
    expect(await prisma.playerLineAccount.count({ where: { groupId: s.groupId } })).toBe(0);
  });

  it('rejects a second link for the same LINE user in a group', async () => {
    const s = await seed();
    await link(s.groupId, s.playerId, s.u1);
    await expect(link(s.groupId, s.otherId, s.u1)).rejects.toThrow();
  });

  it('rejects a second LINE account for the same player in a group', async () => {
    const s = await seed();
    await link(s.groupId, s.playerId, s.u1);
    await expect(link(s.groupId, s.playerId, s.u2)).rejects.toThrow();
  });

  it('rejects a second paid row for the same player in a session', async () => {
    const s = await seed();
    const data = {
      sessionId: s.sessionId,
      playerId: s.playerId,
      source: 'slip',
      amountSatang: 5000,
      reference: 'R1',
    };
    await prisma.sessionPayment.create({ data });
    await expect(prisma.sessionPayment.create({ data })).rejects.toThrow();
  });

  it('rejects a second use of the same slip reference in a group', async () => {
    const s = await seed();
    const data = { groupId: s.groupId, reference: 'REF1', bankCode: '004' };
    await prisma.slipReference.create({ data });
    await expect(prisma.slipReference.create({ data })).rejects.toThrow();
  });

  it('removes every slip table row when the group is deleted', async () => {
    const s = await seed();
    await link(s.groupId, s.playerId, s.u1);
    await prisma.lineAccountGroup.create({
      data: { group: { connect: { code: s.groupId } }, lineAccount: { connect: { lineUserId: s.u1 } }, source: 'claim' },
    });
    await prisma.sessionPayment.create({
      data: { sessionId: s.sessionId, playerId: s.playerId, source: 'host' },
    });
    await prisma.slipReference.create({
      data: { groupId: s.groupId, reference: 'REF1', bankCode: '004' },
    });
    await prisma.pendingSlip.create({
      data: {
        sessionId: s.sessionId,
        groupId: s.groupId,
        reference: 'REF2',
        lineUserId: 'U1',
        pictureUrl: 'https://example.test/p.jpg',
        reason: 'unmapped',
      },
    });
    await prisma.slipDuplicate.create({
      data: {
        groupId: s.groupId,
        reference: 'REF3',
        lineUserId: 'U1',
        originalPlayerIds: JSON.stringify([s.playerId]),
      },
    });

    // Group deletion removes sessions and players first (GroupsService), and
    // the slip tables must follow all three parents without a manual step.
    await prisma.session.deleteMany({ where: { groupId: s.groupId } });
    await prisma.player.deleteMany({ where: { groupId: s.groupId } });
    await prisma.group.delete({ where: { code: s.groupId } });

    const where = { groupId: s.groupId };
    expect(await prisma.playerLineAccount.count({ where })).toBe(0);
    expect(await prisma.lineAccountGroup.count({ where })).toBe(0);
    expect(
      await prisma.sessionPayment.count({ where: { sessionId: s.sessionId } }),
    ).toBe(0);
    expect(await prisma.slipReference.count({ where })).toBe(0);
    expect(await prisma.pendingSlip.count({ where })).toBe(0);
    expect(await prisma.slipDuplicate.count({ where })).toBe(0);
  });

  it('cascades group-scoped rows directly from the group', async () => {
    const groupId = `slip-group-${randomUUID()}`;
    groupCodes.push(groupId);
    await prisma.group.create({ data: { code: groupId } });
    await prisma.slipReference.create({
      data: { groupId, reference: 'REF1', bankCode: '004' },
    });
    await prisma.slipDuplicate.create({
      data: {
        groupId,
        reference: 'REF1',
        lineUserId: 'U1',
        originalPlayerIds: '[]',
      },
    });

    await prisma.group.delete({ where: { code: groupId } });

    expect(await prisma.slipReference.count({ where: { groupId } })).toBe(0);
    expect(await prisma.slipDuplicate.count({ where: { groupId } })).toBe(0);
  });

  it("removes a deleted player's account link and paid row", async () => {
    const s = await seed();
    await link(s.groupId, s.playerId, s.u1);
    await prisma.sessionPayment.create({
      data: { sessionId: s.sessionId, playerId: s.playerId, source: 'host' },
    });
    await link(s.groupId, s.otherId, s.u2);

    await prisma.player.delete({ where: { id: s.playerId } });

    expect(
      await prisma.playerLineAccount.count({ where: { playerId: s.playerId } }),
    ).toBe(0);
    expect(
      await prisma.sessionPayment.count({ where: { playerId: s.playerId } }),
    ).toBe(0);
    expect(
      await prisma.playerLineAccount.count({ where: { playerId: s.otherId } }),
    ).toBe(1);
    // The account itself outlives its link.
    expect(await prisma.lineAccount.count({ where: { lineUserId: s.u1 } })).toBe(1);
  });
});
