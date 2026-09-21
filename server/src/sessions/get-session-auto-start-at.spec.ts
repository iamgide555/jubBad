import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsModule } from './sessions.module.js';
import { AUTO_CONFIRM_DELAY_MS, SessionsService } from './sessions.service.js';

describe('getSession — pending court autoStartAt', () => {
  let prisma: PrismaService;
  let service: SessionsService;

  async function fixture(names: string[], mode = 'variety') {
    const groupCode = randomUUID();
    const sessionCode = randomUUID().slice(0, 8);
    await prisma.group.create({ data: { code: groupCode } });
    const players = await Promise.all(
      names.map((name) => prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } }))
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '', mode },
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

  it('is pendingSince + the delay once a fully-seated court has a pendingSince', async () => {
    const data = await fixture(['A', 'B', 'C', 'D']);
    try {
      const proposed = await service.propose(data.sessionCode, 1);
      if (!proposed.ok) throw new Error('expected ok');
      const pendingSince = new Date('2026-09-22T10:00:00.000Z');
      await prisma.pairing.update({ where: { id: proposed.pairing.id }, data: { pendingSince } });

      const session = await service.getSession(data.sessionCode);
      const court = session.courts[0];
      expect(court.status).toBe('pending');
      if (court.status !== 'pending') return;
      expect(court.autoStartAt).toBe(new Date(pendingSince.getTime() + AUTO_CONFIRM_DELAY_MS).toISOString());
    } finally {
      await remove(data);
    }
  });

  it('is null with no pendingSince, an empty seat, or a resting player on the court', async () => {
    const noPendingSince = await fixture(['A', 'B', 'C', 'D']);
    try {
      const proposed = await service.propose(noPendingSince.sessionCode, 1);
      if (!proposed.ok) throw new Error('expected ok');
      await prisma.pairing.update({ where: { id: proposed.pairing.id }, data: { pendingSince: null } });
      const session = await service.getSession(noPendingSince.sessionCode);
      const court = session.courts[0];
      expect(court.status).toBe('pending');
      if (court.status === 'pending') expect(court.autoStartAt).toBeNull();
    } finally {
      await remove(noPendingSince);
    }

    const emptySeat = await fixture(['A', 'B', 'C', 'D'], 'custom');
    try {
      const draft = await service.propose(emptySeat.sessionCode, 1);
      if (!draft.ok) throw new Error('expected ok');
      await prisma.pairing.update({ where: { id: draft.pairing.id }, data: { pendingSince: new Date() } });
      const session = await service.getSession(emptySeat.sessionCode);
      const court = session.courts[0];
      expect(court.status).toBe('pending');
      if (court.status === 'pending') expect(court.autoStartAt).toBeNull();
    } finally {
      await remove(emptySeat);
    }

    const resting = await fixture(['A', 'B', 'C', 'D']);
    try {
      const proposed = await service.propose(resting.sessionCode, 1);
      if (!proposed.ok) throw new Error('expected ok');
      await prisma.pairing.update({ where: { id: proposed.pairing.id }, data: { pendingSince: new Date() } });
      await service.setRosterActive(resting.sessionCode, proposed.pairing.teamA[0], { active: false });
      const session = await service.getSession(resting.sessionCode);
      const court = session.courts[0];
      expect(court.status).toBe('pending');
      if (court.status === 'pending') expect(court.autoStartAt).toBeNull();
    } finally {
      await remove(resting);
    }
  });
});
