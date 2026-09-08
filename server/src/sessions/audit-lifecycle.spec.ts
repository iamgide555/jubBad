import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsModule } from './sessions.module.js';
import { SessionsService } from './sessions.service.js';

describe('session audit lifecycle regressions', () => {
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
    const module = await Test.createTestingModule({
      imports: [PrismaModule, SessionsModule],
    }).compile();
    prisma = module.get(PrismaService);
    service = module.get(SessionsService);
  });

  it('refuses invalid courts and never replaces an active court with an open proposal', async () => {
    const data = await fixture(['A', 'B', 'C', 'D']);
    try {
      for (const court of [0, -1, 2, 1.5]) {
        await expect(service.propose(data.sessionCode, court)).rejects.toBeInstanceOf(
          BadRequestException
        );
      }

      const proposed = await service.propose(data.sessionCode, 1);
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) return;
      await service.confirmPairing(data.sessionCode, proposed.pairing.id, proposed.pairing.revision);

      await expect(service.propose(data.sessionCode, 1)).rejects.toBeInstanceOf(ConflictException);
      const pairings = await prisma.pairing.findMany({ where: { sessionId: data.sessionCode } });
      expect(pairings).toHaveLength(1);
      expect(pairings[0].confirmedAt).not.toBeNull();
    } finally {
      await remove(data);
    }
  });

  it('rejects stale confirmation after a proposal is reshuffled', async () => {
    const data = await fixture(['A', 'B', 'C', 'D']);
    try {
      const first = await service.propose(data.sessionCode, 1);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const reshuffled = await service.propose(data.sessionCode, 1);
      expect(reshuffled.ok).toBe(true);
      if (!reshuffled.ok) return;

      await expect(
        service.confirmPairing(data.sessionCode, first.pairing.id, first.pairing.revision)
      ).rejects.toBeInstanceOf(ConflictException);
      await service.confirmPairing(
        data.sessionCode,
        reshuffled.pairing.id,
        reshuffled.pairing.revision
      );
    } finally {
      await remove(data);
    }
  });

  it('gives the court to whoever has waited when someone must sit out', async () => {
    // Rotation priority, asserted in the only shape it can actually take.
    //
    // This replaces a test that gave four players six games and four players
    // zero, then required the proposal to take the rested four. That state is
    // not reachable through the API: the roster is fixed when the session is
    // created, there is no add-player-mid-session route, and re-activating a
    // player credits their gamesOffset up to the highest count on the roster
    // precisely so a late arrival cannot arrive on zero and monopolise. The
    // old test could only build its premise by writing rows directly, and it
    // then forced `propose` to abandon planning across idle courts — a fix
    // made after a real session — to satisfy a scenario that cannot happen.
    //
    // Rotation only decides anything when someone has to sit, so that is what
    // is pinned here: five free players, one court's worth of space, and the
    // player who has already played is the one left out.
    const data = await fixture(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'], 3);
    const [a, b, c, d, e, f, g, h, i] = data.players;
    try {
      // Court 3 is mid-match, so only A-E are free for the two idle courts.
      await prisma.pairing.create({
        data: {
          sessionId: data.sessionCode,
          courtNumber: 3,
          matchNumber: 1,
          teamA: JSON.stringify([f.id, g.id]),
          teamB: JSON.stringify([h.id, i.id]),
          confirmedAt: new Date(),
        },
      });
      // A has already had a game tonight; B-E have not.
      await prisma.pairing.create({
        data: {
          sessionId: data.sessionCode,
          courtNumber: 1,
          matchNumber: 1,
          teamA: JSON.stringify([a.id, f.id]),
          teamB: JSON.stringify([g.id, h.id]),
          confirmedAt: new Date(),
          endedAt: new Date(),
          winner: 'A',
        },
      });

      const proposed = await service.propose(data.sessionCode, 1);
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) return;
      // Five free players and room for four: the one who has played sits.
      expect(new Set([...proposed.pairing.teamA, ...proposed.pairing.teamB])).toEqual(
        new Set([b.id, c.id, d.id, e.id])
      );
    } finally {
      await remove(data);
    }
  });

  it('uses balanced-mode Elo when choosing equally-rested substitutes', async () => {
    const data = await fixture(['A', 'B', 'C', 'D', 'E', 'F']);
    const [a, b, c, d, e, f] = data.players;
    const [x, y, z] = await Promise.all(
      ['X', 'Y', 'Z'].map((name) =>
        prisma.player.create({ data: { groupId: data.groupCode, name, aliases: '[]' } })
      )
    );
    const oldSession = randomUUID().slice(0, 8);
    await prisma.session.create({
      data: {
        code: oldSession,
        groupId: data.groupCode,
        courtCount: 1,
        rawImportText: '',
        endedAt: new Date(),
      },
    });

    try {
      await service.setMode(data.sessionCode, { mode: 'balanced' });
      for (let matchNumber = 1; matchNumber <= 60; matchNumber++) {
        await prisma.pairing.create({
          data: {
            sessionId: oldSession,
            courtNumber: 1,
            matchNumber,
            teamA: JSON.stringify([e.id, x.id]),
            teamB: JSON.stringify([y.id, z.id]),
            confirmedAt: new Date(matchNumber),
            endedAt: new Date(matchNumber),
            winner: 'B',
          },
        });
      }
      await prisma.pairing.create({
        data: {
          sessionId: oldSession,
          courtNumber: 1,
          matchNumber: 61,
          teamA: JSON.stringify([f.id, b.id]),
          teamB: JSON.stringify([y.id, z.id]),
          confirmedAt: new Date(61),
          endedAt: new Date(61),
          winner: 'A',
        },
      });
      const pending = await prisma.pairing.create({
        data: {
          sessionId: data.sessionCode,
          courtNumber: 1,
          matchNumber: 1,
          teamA: JSON.stringify([a.id, b.id]),
          teamB: JSON.stringify([c.id, d.id]),
        },
      });

      const swapped = await service.swapPlayer(data.sessionCode, pending.id, { playerId: a.id });
      expect(swapped.ok).toBe(true);
      if (!swapped.ok) return;
      expect(swapped.pairing.teamA).toEqual([f.id, b.id]);
    } finally {
      await prisma.pairing.deleteMany({ where: { sessionId: { in: [data.sessionCode, oldSession] } } });
      await prisma.session.deleteMany({ where: { code: oldSession } });
      await remove(data);
    }
  });

  it('rolls back every fill when a later court write fails', async () => {
    const data = await fixture(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], 2);
    const trigger = 'fail_second_audit_fill';
    try {
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER "${trigger}" BEFORE INSERT ON "Pairing"
         WHEN NEW."sessionId" = '${data.sessionCode}' AND NEW."courtNumber" = 2
         BEGIN SELECT RAISE(ABORT, 'injected second court failure'); END`
      );

      await expect(service.fillIdleCourts(data.sessionCode)).rejects.toThrow();
      expect(await prisma.pairing.count({ where: { sessionId: data.sessionCode } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}"`);
      await remove(data);
    }
  });

  it('keeps end-state roster immutable and permits only coherent results', async () => {
    const data = await fixture(['A', 'B', 'C', 'D']);
    try {
      const proposed = await service.propose(data.sessionCode, 1);
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) return;
      await service.confirmPairing(data.sessionCode, proposed.pairing.id, proposed.pairing.revision);

      await expect(
        service.finishPairing(data.sessionCode, proposed.pairing.id, {
          scoreA: 0,
          scoreB: 21,
          winner: 'A',
        })
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.finishPairing(data.sessionCode, proposed.pairing.id, {
          scoreA: 21,
          winner: 'A',
        })
      ).rejects.toBeInstanceOf(BadRequestException);

      await service.finishPairing(data.sessionCode, proposed.pairing.id, { winner: 'A' });
      await service.endSession(data.sessionCode);
      await expect(
        service.setRosterActive(data.sessionCode, data.players[0].id, { active: false })
      ).rejects.toBeInstanceOf(ConflictException);
    } finally {
      await remove(data);
    }
  });
});
