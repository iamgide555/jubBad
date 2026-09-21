import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsModule } from './sessions.module.js';
import { SessionsService } from './sessions.service.js';

describe('Pairing.pendingSince is kept current', () => {
  let prisma: PrismaService;
  let service: SessionsService;

  async function fixture(names: string[], courtCount = 1, mode = 'variety') {
    const groupCode = randomUUID();
    const sessionCode = randomUUID().slice(0, 8);
    await prisma.group.create({ data: { code: groupCode } });
    const players = await Promise.all(
      names.map((name) => prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } }))
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount, rawImportText: '', mode },
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

  async function backdate(pairingId: string, isoTime: string) {
    await prisma.pairing.update({ where: { id: pairingId }, data: { pendingSince: new Date(isoTime) } });
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [PrismaModule, SessionsModule] }).compile();
    prisma = module.get(PrismaService);
    service = module.get(SessionsService);
  });

  it('propose sets it, and reshuffling on the same court bumps it forward', async () => {
    const data = await fixture(['A', 'B', 'C', 'D']);
    try {
      const first = await service.propose(data.sessionCode, 1);
      if (!first.ok) throw new Error('expected ok');
      const firstRow = await prisma.pairing.findUniqueOrThrow({ where: { id: first.pairing.id } });
      expect(firstRow.pendingSince).not.toBeNull();

      await backdate(first.pairing.id, '2020-01-01T00:00:00.000Z');
      const reshuffled = await service.propose(data.sessionCode, 1);
      if (!reshuffled.ok) throw new Error('expected ok');
      const reshuffledRow = await prisma.pairing.findUniqueOrThrow({ where: { id: reshuffled.pairing.id } });
      expect(reshuffledRow.pendingSince!.getTime()).toBeGreaterThan(new Date('2020-01-01').getTime());
    } finally {
      await remove(data);
    }
  });

  it('fillIdleCourts sets it, in both variety and custom mode', async () => {
    const variety = await fixture(['A', 'B', 'C', 'D'], 1, 'variety');
    const custom = await fixture(['A', 'B', 'C', 'D'], 1, 'custom');
    try {
      await service.fillIdleCourts(variety.sessionCode);
      const varietyRow = await prisma.pairing.findFirstOrThrow({ where: { sessionId: variety.sessionCode } });
      expect(varietyRow.pendingSince).not.toBeNull();

      await service.fillIdleCourts(custom.sessionCode);
      const customRow = await prisma.pairing.findFirstOrThrow({ where: { sessionId: custom.sessionCode } });
      expect(customRow.pendingSince).not.toBeNull();
    } finally {
      await remove(variety);
      await remove(custom);
    }
  });

  it('swap (auto-pick and chosen-player) bumps it, on both rows in a cross-court trade', async () => {
    const data = await fixture(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'], 2);
    try {
      const near = await service.propose(data.sessionCode, 1);
      const far = await service.propose(data.sessionCode, 2);
      if (!near.ok || !far.ok) throw new Error('expected ok');
      await backdate(near.pairing.id, '2020-01-01T00:00:00.000Z');
      await backdate(far.pairing.id, '2020-01-01T00:00:00.000Z');

      const nearOnCourt = near.pairing.teamA[0];
      const autoSwapped = await service.swapPlayer(data.sessionCode, near.pairing.id, {
        playerId: nearOnCourt,
        expectedRevision: near.pairing.revision,
      });
      expect(autoSwapped.ok).toBe(true);
      const nearRow = await prisma.pairing.findUniqueOrThrow({ where: { id: near.pairing.id } });
      expect(nearRow.pendingSince!.getTime()).toBeGreaterThan(new Date('2020-01-01').getTime());

      await backdate(near.pairing.id, '2020-01-01T00:00:00.000Z');
      const farOnCourt = far.pairing.teamA[0];
      const nearNowOnCourt = JSON.parse(nearRow.teamA)[0];
      const traded = await service.swapPlayer(data.sessionCode, near.pairing.id, {
        playerId: nearNowOnCourt,
        withPlayerId: farOnCourt,
        expectedRevision: nearRow.revision,
      });
      expect(traded.ok).toBe(true);
      const nearAfterTrade = await prisma.pairing.findUniqueOrThrow({ where: { id: near.pairing.id } });
      const farAfterTrade = await prisma.pairing.findUniqueOrThrow({ where: { id: far.pairing.id } });
      expect(nearAfterTrade.pendingSince!.getTime()).toBeGreaterThan(new Date('2020-01-01').getTime());
      expect(farAfterTrade.pendingSince!.getTime()).toBeGreaterThan(new Date('2020-01-01').getTime());
    } finally {
      await remove(data);
    }
  });

  it('setSeat and autoPair bump it, in custom mode', async () => {
    const data = await fixture(['A', 'B', 'C', 'D'], 1, 'custom');
    try {
      const proposed = await service.propose(data.sessionCode, 1);
      if (!proposed.ok) throw new Error('expected ok');
      await backdate(proposed.pairing.id, '2020-01-01T00:00:00.000Z');

      const seated = await service.setSeat(data.sessionCode, proposed.pairing.id, {
        team: 'A',
        index: 0,
        playerId: data.players[0].id,
        expectedRevision: proposed.pairing.revision,
      });
      expect(seated.ok).toBe(true);
      const afterSeat = await prisma.pairing.findUniqueOrThrow({ where: { id: proposed.pairing.id } });
      expect(afterSeat.pendingSince!.getTime()).toBeGreaterThan(new Date('2020-01-01').getTime());

      await backdate(proposed.pairing.id, '2020-01-01T00:00:00.000Z');
      const autoPaired = await service.autoPair(data.sessionCode, proposed.pairing.id, afterSeat.revision);
      expect(autoPaired.ok).toBe(true);
      const afterAutoPair = await prisma.pairing.findUniqueOrThrow({ where: { id: proposed.pairing.id } });
      expect(afterAutoPair.pendingSince!.getTime()).toBeGreaterThan(new Date('2020-01-01').getTime());
    } finally {
      await remove(data);
    }
  });

  it('resting or returning a seated player bumps it on their pending court', async () => {
    const data = await fixture(['A', 'B', 'C', 'D']);
    try {
      const proposed = await service.propose(data.sessionCode, 1);
      if (!proposed.ok) throw new Error('expected ok');
      await backdate(proposed.pairing.id, '2020-01-01T00:00:00.000Z');

      const onCourt = proposed.pairing.teamA[0];
      await service.setRosterActive(data.sessionCode, onCourt, { active: false });
      const afterRest = await prisma.pairing.findUniqueOrThrow({ where: { id: proposed.pairing.id } });
      expect(afterRest.pendingSince!.getTime()).toBeGreaterThan(new Date('2020-01-01').getTime());

      await backdate(proposed.pairing.id, '2020-01-01T00:00:00.000Z');
      await service.setRosterActive(data.sessionCode, onCourt, { active: true });
      const afterReturn = await prisma.pairing.findUniqueOrThrow({ where: { id: proposed.pairing.id } });
      expect(afterReturn.pendingSince!.getTime()).toBeGreaterThan(new Date('2020-01-01').getTime());
    } finally {
      await remove(data);
    }
  });

  it('undoing a confirm clears it, and the next edit sets it again', async () => {
    const data = await fixture(['A', 'B', 'C', 'D']);
    try {
      const proposed = await service.propose(data.sessionCode, 1);
      if (!proposed.ok) throw new Error('expected ok');
      await service.confirmPairing(data.sessionCode, proposed.pairing.id, proposed.pairing.revision);

      const undone = await service.undoLastOnCourt(data.sessionCode, 1);
      expect(undone).toEqual({ ok: true, undone: 'confirm' });
      const afterUndo = await prisma.pairing.findUniqueOrThrow({ where: { id: proposed.pairing.id } });
      expect(afterUndo.pendingSince).toBeNull();

      const reshuffled = await service.propose(data.sessionCode, 1);
      if (!reshuffled.ok) throw new Error('expected ok');
      const afterReshuffle = await prisma.pairing.findUniqueOrThrow({ where: { id: reshuffled.pairing.id } });
      expect(afterReshuffle.pendingSince).not.toBeNull();
    } finally {
      await remove(data);
    }
  });
});
