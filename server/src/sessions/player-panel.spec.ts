import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsModule } from './sessions.module.js';
import { SessionsService } from './sessions.service.js';

describe('SessionsService.getPlayerPanel', () => {
  let prisma: PrismaService;
  let service: SessionsService;

  async function fixture() {
    const groupCode = randomUUID();
    const sessionCode = randomUUID().slice(0, 8);
    await prisma.group.create({ data: { code: groupCode } });
    return { groupCode, sessionCode };
  }

  async function remove({ groupCode, sessionCode }: { groupCode: string; sessionCode: string }) {
    await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
    await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
    await prisma.session.deleteMany({ where: { code: sessionCode } });
    await prisma.player.deleteMany({ where: { groupId: groupCode } });
    await prisma.group.deleteMany({ where: { code: groupCode } });
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [PrismaModule, SessionsModule],
    }).compile();
    prisma = module.get(PrismaService);
    service = module.get(SessionsService);
  });

  it('throws SESSION_NOT_FOUND for an unknown code', async () => {
    await expect(service.getPlayerPanel(randomUUID())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reports played/won/lost tonight, resting state, and a null delta for an unlevelled player', async () => {
    const data = await fixture();
    try {
      const a = await prisma.player.create({
        data: { groupId: data.groupCode, name: 'A', aliases: '[]' },
      });
      const b = await prisma.player.create({
        data: { groupId: data.groupCode, name: 'B', aliases: '[]' },
      });
      await prisma.session.create({
        data: { code: data.sessionCode, groupId: data.groupCode, courtCount: 1, rawImportText: '' },
      });
      await prisma.sessionRoster.create({
        data: { sessionId: data.sessionCode, playerId: a.id, active: true },
      });
      // Resting.
      await prisma.sessionRoster.create({
        data: { sessionId: data.sessionCode, playerId: b.id, active: false },
      });
      await prisma.pairing.create({
        data: {
          sessionId: data.sessionCode,
          courtNumber: 1,
          matchNumber: 1,
          teamA: JSON.stringify([a.id]),
          teamB: JSON.stringify([b.id]),
          confirmedAt: new Date(),
          endedAt: new Date(),
          winner: 'A',
        },
      });

      const rows = await service.getPlayerPanel(data.sessionCode);
      const rowA = rows.find((r) => r.playerId === a.id)!;
      const rowB = rows.find((r) => r.playerId === b.id)!;

      expect(rowA).toEqual({
        playerId: a.id,
        name: 'A',
        level: null,
        resting: false,
        played: 1,
        won: 1,
        lost: 0,
        ratingDelta: null,
      });
      expect(rowB).toMatchObject({ resting: true, played: 1, won: 0, lost: 1, level: null, ratingDelta: null });
    } finally {
      await remove(data);
    }
  });

  it('does not count an abandoned (no-result) match as won or lost', async () => {
    const data = await fixture();
    try {
      const a = await prisma.player.create({
        data: { groupId: data.groupCode, name: 'A', aliases: '[]' },
      });
      const b = await prisma.player.create({
        data: { groupId: data.groupCode, name: 'B', aliases: '[]' },
      });
      await prisma.session.create({
        data: { code: data.sessionCode, groupId: data.groupCode, courtCount: 1, rawImportText: '' },
      });
      await prisma.sessionRoster.create({ data: { sessionId: data.sessionCode, playerId: a.id } });
      await prisma.sessionRoster.create({ data: { sessionId: data.sessionCode, playerId: b.id } });
      await prisma.pairing.create({
        data: {
          sessionId: data.sessionCode,
          courtNumber: 1,
          matchNumber: 1,
          teamA: JSON.stringify([a.id]),
          teamB: JSON.stringify([b.id]),
          confirmedAt: new Date(),
          endedAt: new Date(),
          // no winner: abandoned
        },
      });

      const rows = await service.getPlayerPanel(data.sessionCode);
      const rowA = rows.find((r) => r.playerId === a.id)!;
      expect(rowA).toMatchObject({ played: 1, won: 0, lost: 0 });
    } finally {
      await remove(data);
    }
  });

  it('shows the rating as a delta from the level\'s seed once a level is set', async () => {
    const data = await fixture();
    try {
      const a = await prisma.player.create({
        data: { groupId: data.groupCode, name: 'A', aliases: '[]', level: 'P', levelSetAt: new Date() },
      });
      await prisma.session.create({
        data: { code: data.sessionCode, groupId: data.groupCode, courtCount: 1, rawImportText: '' },
      });
      await prisma.sessionRoster.create({ data: { sessionId: data.sessionCode, playerId: a.id } });

      const rows = await service.getPlayerPanel(data.sessionCode);
      const rowA = rows.find((r) => r.playerId === a.id)!;

      // Freshly leveled, no matches yet — the rating is exactly the seed, so
      // the delta is 0, not null (null means "no level", not "no games").
      expect(rowA.level).toBe('P');
      expect(rowA.ratingDelta).toBe(0);
    } finally {
      await remove(data);
    }
  });

  it('a match played tonight before a level was set moves the delta once the level is set', async () => {
    const data = await fixture();
    try {
      const a = await prisma.player.create({
        data: { groupId: data.groupCode, name: 'A', aliases: '[]' },
      });
      const b = await prisma.player.create({
        data: { groupId: data.groupCode, name: 'B', aliases: '[]' },
      });
      await prisma.session.create({
        data: { code: data.sessionCode, groupId: data.groupCode, courtCount: 1, rawImportText: '' },
      });
      await prisma.sessionRoster.create({ data: { sessionId: data.sessionCode, playerId: a.id } });
      await prisma.sessionRoster.create({ data: { sessionId: data.sessionCode, playerId: b.id } });
      await prisma.pairing.create({
        data: {
          sessionId: data.sessionCode,
          courtNumber: 1,
          matchNumber: 1,
          teamA: JSON.stringify([a.id]),
          teamB: JSON.stringify([b.id]),
          confirmedAt: new Date(),
          endedAt: new Date(),
          winner: 'A',
        },
      });

      // Level set after the win above — per the reset-on-set rule this wipes
      // the win's effect on the rating, so the delta starts back at 0.
      await prisma.player.update({
        where: { id: a.id },
        data: { level: 'P', levelSetAt: new Date() },
      });

      const rows = await service.getPlayerPanel(data.sessionCode);
      const rowA = rows.find((r) => r.playerId === a.id)!;
      expect(rowA.played).toBe(1);
      expect(rowA.won).toBe(1);
      expect(rowA.ratingDelta).toBe(0);
    } finally {
      await remove(data);
    }
  });
});
