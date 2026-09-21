import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsModule } from './sessions.module.js';
import { AUTO_CONFIRM_DELAY_MS, AUTO_CONFIRM_WALK_ON_MS, SessionsService } from './sessions.service.js';

describe('SessionsService.autoConfirmDue', () => {
  let prisma: PrismaService;
  let service: SessionsService;

  async function fixture(names: string[], courtCount = 1) {
    const groupCode = randomUUID();
    const sessionCode = randomUUID().slice(0, 8);
    await prisma.group.create({ data: { code: groupCode } });
    const players = await Promise.all(
      names.map((name) => prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } }))
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount, rawImportText: '' },
    });
    await Promise.all(
      players.map((player) =>
        prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: player.id } })
      )
    );
    return { groupCode, sessionCode, players };
  }

  async function remove({ groupCode, sessionCode }: { groupCode: string; sessionCode: string }) {
    await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
    await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
    await prisma.session.deleteMany({ where: { code: sessionCode } });
    await prisma.player.deleteMany({ where: { groupId: groupCode } });
    await prisma.group.deleteMany({ where: { code: groupCode } });
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [PrismaModule, SessionsModule] }).compile();
    prisma = module.get(PrismaService);
    service = module.get(SessionsService);
  });

  it('confirms a match pending for exactly the delay, backdated by the walk-on offset, and leaves a fresher one alone', async () => {
    const data = await fixture(['A', 'B', 'C', 'D']);
    try {
      const proposed = await service.propose(data.sessionCode, 1);
      if (!proposed.ok) throw new Error('expected ok');
      const pendingSince = new Date('2026-09-22T10:00:00.000Z');
      await prisma.pairing.update({ where: { id: proposed.pairing.id }, data: { pendingSince } });

      const tooSoon = new Date(pendingSince.getTime() + AUTO_CONFIRM_DELAY_MS - 1000);
      expect(await service.autoConfirmDue(tooSoon)).toEqual([]);
      expect(
        (await prisma.pairing.findUniqueOrThrow({ where: { id: proposed.pairing.id } })).confirmedAt
      ).toBeNull();

      const dueAt = new Date(pendingSince.getTime() + AUTO_CONFIRM_DELAY_MS);
      const confirmedIds = await service.autoConfirmDue(dueAt);
      expect(confirmedIds).toEqual([proposed.pairing.id]);

      const row = await prisma.pairing.findUniqueOrThrow({ where: { id: proposed.pairing.id } });
      expect(row.confirmedAt?.toISOString()).toBe(
        new Date(pendingSince.getTime() + AUTO_CONFIRM_WALK_ON_MS).toISOString()
      );
      expect(row.revision).toBe(proposed.pairing.revision + 1);
    } finally {
      await remove(data);
    }
  });

  it('skips an empty seat, a resting player, and a null pendingSince, leaving each pending', async () => {
    const customData = await fixture(['A', 'B', 'C', 'D']);
    try {
      await prisma.session.update({ where: { code: customData.sessionCode }, data: { mode: 'custom' } });
      const draft = await service.propose(customData.sessionCode, 1);
      if (!draft.ok) throw new Error('expected ok');
      const overdue = new Date(Date.now() + AUTO_CONFIRM_DELAY_MS + 60_000);
      await prisma.pairing.update({
        where: { id: draft.pairing.id },
        data: { pendingSince: new Date(overdue.getTime() - AUTO_CONFIRM_DELAY_MS) },
      });
      await expect(service.autoConfirmDue(overdue)).resolves.not.toContain(draft.pairing.id);
      expect(
        (await prisma.pairing.findUniqueOrThrow({ where: { id: draft.pairing.id } })).confirmedAt
      ).toBeNull();
    } finally {
      await remove(customData);
    }

    const restingData = await fixture(['A', 'B', 'C', 'D']);
    try {
      const proposed = await service.propose(restingData.sessionCode, 1);
      if (!proposed.ok) throw new Error('expected ok');
      await service.setRosterActive(restingData.sessionCode, proposed.pairing.teamA[0], { active: false });
      const overdue = new Date(Date.now() + AUTO_CONFIRM_DELAY_MS + 60_000);
      await prisma.pairing.update({
        where: { id: proposed.pairing.id },
        data: { pendingSince: new Date(overdue.getTime() - AUTO_CONFIRM_DELAY_MS) },
      });
      await expect(service.autoConfirmDue(overdue)).resolves.not.toContain(proposed.pairing.id);
      expect(
        (await prisma.pairing.findUniqueOrThrow({ where: { id: proposed.pairing.id } })).confirmedAt
      ).toBeNull();
    } finally {
      await remove(restingData);
    }

    const untouchedData = await fixture(['A', 'B', 'C', 'D']);
    try {
      await prisma.pairing.create({
        data: {
          sessionId: untouchedData.sessionCode,
          courtNumber: 1,
          matchNumber: 1,
          teamA: JSON.stringify([untouchedData.players[0].id, untouchedData.players[1].id]),
          teamB: JSON.stringify([untouchedData.players[2].id, untouchedData.players[3].id]),
          // pendingSince left null on purpose — a row from before this column existed.
        },
      });
      const overdue = new Date(Date.now() + AUTO_CONFIRM_DELAY_MS + 60_000);
      expect(await service.autoConfirmDue(overdue)).toEqual([]);
    } finally {
      await remove(untouchedData);
    }
  });

  it('skips a row edited between the sweep\'s outer read and its per-row recheck', async () => {
    const data = await fixture(['A', 'B', 'C', 'D']);
    try {
      const proposed = await service.propose(data.sessionCode, 1);
      if (!proposed.ok) throw new Error('expected ok');
      const dueAt = new Date(Date.now() + AUTO_CONFIRM_DELAY_MS + 60_000);
      await prisma.pairing.update({
        where: { id: proposed.pairing.id },
        data: { pendingSince: new Date(dueAt.getTime() - AUTO_CONFIRM_DELAY_MS) },
      });

      // Simulates a concurrent edit landing in the real gap between
      // `autoConfirmDue`'s outer, unlocked query and the per-row recheck
      // that runs once it has the session lock — a gap `Promise` timing
      // can't reproduce deterministically in a test, so this splices the
      // edit into that exact window via the query that opens it.
      const originalFindMany = prisma.pairing.findMany.bind(prisma.pairing);
      const findManySpy = vi
        .spyOn(prisma.pairing, 'findMany')
        .mockImplementationOnce(async (args) => {
          const result = await originalFindMany(args);
          await prisma.pairing.update({
            where: { id: proposed.pairing.id },
            data: { revision: { increment: 1 } },
          });
          return result;
        });

      expect(await service.autoConfirmDue(dueAt)).toEqual([]);
      findManySpy.mockRestore();
      expect(
        (await prisma.pairing.findUniqueOrThrow({ where: { id: proposed.pairing.id } })).confirmedAt
      ).toBeNull();
    } finally {
      await remove(data);
    }
  });

  it('never throws on a row deleted between the sweep\'s outer read and its per-row recheck', async () => {
    const data = await fixture(['A', 'B', 'C', 'D']);
    try {
      const proposed = await service.propose(data.sessionCode, 1);
      if (!proposed.ok) throw new Error('expected ok');
      const dueAt = new Date(Date.now() + AUTO_CONFIRM_DELAY_MS + 60_000);
      await prisma.pairing.update({
        where: { id: proposed.pairing.id },
        data: { pendingSince: new Date(dueAt.getTime() - AUTO_CONFIRM_DELAY_MS) },
      });

      const originalFindMany = prisma.pairing.findMany.bind(prisma.pairing);
      const findManySpy = vi
        .spyOn(prisma.pairing, 'findMany')
        .mockImplementationOnce(async (args) => {
          const result = await originalFindMany(args);
          await prisma.pairing.delete({ where: { id: proposed.pairing.id } });
          return result;
        });

      await expect(service.autoConfirmDue(dueAt)).resolves.toEqual([]);
      findManySpy.mockRestore();
    } finally {
      await remove(data);
    }
  });
});
