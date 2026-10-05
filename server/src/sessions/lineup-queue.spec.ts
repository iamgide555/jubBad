import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsModule } from './sessions.module.js';
import { SessionsService } from './sessions.service.js';

describe('lineup queue', () => {
  let prisma: PrismaService;
  let service: SessionsService;

  async function fixture(count: number, courtCount = 2) {
    const groupCode = randomUUID();
    const sessionCode = randomUUID().slice(0, 8);
    await prisma.group.create({ data: { code: groupCode } });
    const players = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        prisma.player.create({ data: { groupId: groupCode, name: `P${i + 1}`, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount, rawImportText: '' },
    });
    for (const p of players) {
      await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    }
    return { groupCode, sessionCode, ids: players.map((p) => p.id) };
  }

  async function remove({ groupCode, sessionCode }: { groupCode: string; sessionCode: string }) {
    await prisma.queuedMatch.deleteMany({ where: { sessionId: sessionCode } });
    await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
    await prisma.playerRule.deleteMany({ where: { groupId: groupCode } });
    await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
    await prisma.session.deleteMany({ where: { code: sessionCode } });
    await prisma.player.deleteMany({ where: { groupId: groupCode } });
    await prisma.group.deleteMany({ where: { code: groupCode } });
  }

  const pendingOn = (sessionCode: string, courtNumber: number) =>
    prisma.pairing.findFirstOrThrow({ where: { sessionId: sessionCode, courtNumber, endedAt: null } });
  const seated = (p: { teamA: string; teamB: string }) => [...JSON.parse(p.teamA), ...JSON.parse(p.teamB)];

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [PrismaModule, SessionsModule] }).compile();
    prisma = module.get(PrismaService);
    service = module.get(SessionsService);
  });

  it('seats a full lineup on the court that propose asks for, without auto-confirm', async () => {
    const d = await fixture(8);
    try {
      const [a, b, c, e] = d.ids.slice(4);
      await service.addLineup(d.sessionCode, { teamA: [a, b], teamB: [c, e] });
      const res = await service.propose(d.sessionCode, 1);
      expect(res.ok).toBe(true);
      const row = await pendingOn(d.sessionCode, 1);
      expect(JSON.parse(row.teamA)).toEqual([a, b]);
      expect(JSON.parse(row.teamB)).toEqual([c, e]);
      expect(row.pendingSince).toBeNull();
      expect(await prisma.queuedMatch.count({ where: { sessionId: d.sessionCode } })).toBe(0);
    } finally {
      await remove(d);
    }
  });

  it('completes a partial lineup with the engine and keeps the chosen seats', async () => {
    const d = await fixture(8);
    try {
      await service.addLineup(d.sessionCode, { teamA: [d.ids[0], null], teamB: [d.ids[1], null] });
      await service.fillIdleCourts(d.sessionCode);
      const first = await pendingOn(d.sessionCode, 1);
      const ids = seated(first);
      expect(JSON.parse(first.teamA)[0]).toBe(d.ids[0]);
      expect(JSON.parse(first.teamB)[0]).toBe(d.ids[1]);
      expect(ids.every((id: string | null) => id !== null)).toBe(true);
      expect(first.pendingSince).toBeNull();
      // The other court was filled by the engine from the remaining players.
      const second = await pendingOn(d.sessionCode, 2);
      expect(seated(second).filter((id: string) => ids.includes(id))).toEqual([]);
    } finally {
      await remove(d);
    }
  });

  it('keeps queued players off other courts when the engine fills', async () => {
    const d = await fixture(10);
    try {
      // Court 1 is busy; court 2 is singles, so the doubles lineup waits and
      // the engine must seat only the two players nobody has spoken for.
      await prisma.session.update({ where: { code: d.sessionCode }, data: { courtFormats: JSON.stringify(['doubles', 'singles']) } });
      await prisma.pairing.create({
        data: {
          sessionId: d.sessionCode, courtNumber: 1, matchNumber: 1,
          teamA: JSON.stringify([d.ids[0], d.ids[1]]), teamB: JSON.stringify([d.ids[2], d.ids[3]]),
          confirmedAt: new Date(),
        },
      });
      await service.addLineup(d.sessionCode, { teamA: [d.ids[4], d.ids[5]], teamB: [d.ids[6], d.ids[7]] });
      const res = await service.fillIdleCourts(d.sessionCode);
      expect(res.ok).toBe(true);
      expect(seated(await pendingOn(d.sessionCode, 2)).sort()).toEqual([d.ids[8], d.ids[9]].sort());
      expect(await prisma.queuedMatch.count({ where: { sessionId: d.sessionCode } })).toBe(1);
    } finally {
      await remove(d);
    }
  });

  it('vacates a seated player who is resting at apply time and lets the engine fill the seat', async () => {
    const d = await fixture(8);
    try {
      await service.addLineup(d.sessionCode, { teamA: [d.ids[0], d.ids[1]], teamB: [d.ids[2], d.ids[3]] });
      await service.setRosterActive(d.sessionCode, d.ids[1], { active: false });
      await service.propose(d.sessionCode, 1);
      const row = await pendingOn(d.sessionCode, 1);
      expect(seated(row)).not.toContain(d.ids[1]);
      expect(seated(row)).toEqual(expect.arrayContaining([d.ids[0], d.ids[2], d.ids[3]]));
      expect(seated(row).every((id: string | null) => id !== null)).toBe(true);
    } finally {
      await remove(d);
    }
  });

  it('applies queued lineups in order and does not consume the queue on a reshuffle', async () => {
    const d = await fixture(12, 3);
    try {
      await service.addLineup(d.sessionCode, { teamA: [d.ids[0], d.ids[1]], teamB: [d.ids[2], d.ids[3]] });
      await service.addLineup(d.sessionCode, { teamA: [d.ids[4], d.ids[5]], teamB: [d.ids[6], d.ids[7]] });
      await service.propose(d.sessionCode, 1);
      expect(seated(await pendingOn(d.sessionCode, 1))).toEqual(d.ids.slice(0, 4));
      // Re-proposing the pending court is a reshuffle: the second lineup stays queued.
      await service.propose(d.sessionCode, 1);
      expect(await prisma.queuedMatch.count({ where: { sessionId: d.sessionCode } })).toBe(1);
      await service.propose(d.sessionCode, 2);
      expect(seated(await pendingOn(d.sessionCode, 2))).toEqual(d.ids.slice(4, 8));
    } finally {
      await remove(d);
    }
  });

  it('rejects bad lineups at queue time', async () => {
    const d = await fixture(8);
    try {
      const [a, b, c, e, f] = d.ids;
      await expect(service.addLineup(d.sessionCode, { teamA: [null, null], teamB: [null, null] })).rejects.toMatchObject({ response: { code: 'LINEUP_EMPTY' } });
      await expect(service.addLineup(d.sessionCode, { teamA: [a, a], teamB: [b, null] })).rejects.toMatchObject({ response: { code: 'LINEUP_DUPLICATE' } });
      await expect(service.addLineup(d.sessionCode, { teamA: [a, b], teamB: [c] })).rejects.toMatchObject({ response: { code: 'LINEUP_INVALID' } });
      await expect(service.addLineup(d.sessionCode, { teamA: ['nope', b], teamB: [c, e] })).rejects.toMatchObject({ response: { code: 'ROSTER_PLAYER_NOT_FOUND' } });

      await service.addLineup(d.sessionCode, { teamA: [a, b], teamB: [c, e] });
      await expect(service.addLineup(d.sessionCode, { teamA: [a, f], teamB: [null, null] })).rejects.toMatchObject({ response: { code: 'PLAYER_ALREADY_QUEUED' } });

      await service.setRosterActive(d.sessionCode, f, { active: false });
      await expect(service.addLineup(d.sessionCode, { teamA: [f, null], teamB: [null, null] })).rejects.toMatchObject({ response: { code: 'PLAYER_UNAVAILABLE' } });
    } finally {
      await remove(d);
    }
  });

  it('rejects a lineup that breaks a pair rule', async () => {
    const d = await fixture(8);
    try {
      await prisma.pairing.create({
        data: {
          sessionId: d.sessionCode, courtNumber: 1, matchNumber: 1,
          teamA: JSON.stringify([d.ids[0], d.ids[1]]), teamB: JSON.stringify([d.ids[2], d.ids[3]]),
          confirmedAt: new Date(),
        },
      });
      const [x, y] = [d.ids[4], d.ids[5]].sort();
      await prisma.playerRule.create({ data: { groupId: d.groupCode, playerAId: x, playerBId: y, kind: 'never-teammates' } });
      await expect(service.addLineup(d.sessionCode, { teamA: [x, y], teamB: [d.ids[6], d.ids[7]] })).rejects.toMatchObject({ response: { code: 'PAIR_RULE_VIOLATION' } });
    } finally {
      await remove(d);
    }
  });

  it('accepts players who are still playing and holds the lineup until all of them are free', async () => {
    const d = await fixture(14, 2);
    try {
      const court1 = await prisma.pairing.create({
        data: {
          sessionId: d.sessionCode, courtNumber: 1, matchNumber: 1,
          teamA: JSON.stringify([d.ids[0], d.ids[1]]), teamB: JSON.stringify([d.ids[2], d.ids[3]]),
          confirmedAt: new Date(),
        },
      });
      // d.ids[0] is still playing on court 1; the other three are free.
      await service.addLineup(d.sessionCode, { teamA: [d.ids[0], d.ids[4]], teamB: [d.ids[5], d.ids[6]] });

      // Court 2 is idle, but the lineup must not be seated with its player missing.
      await service.propose(d.sessionCode, 2);
      const court2 = await pendingOn(d.sessionCode, 2);
      for (const id of [d.ids[0], d.ids[4], d.ids[5], d.ids[6]]) expect(seated(court2)).not.toContain(id);
      expect(await prisma.queuedMatch.count({ where: { sessionId: d.sessionCode } })).toBe(1);
      expect((await service.getSession(d.sessionCode)).lineupQueue[0].blocked).toEqual([
        { playerId: d.ids[0], reason: 'on-court' },
      ]);

      // Court 1 finishes, so everyone is free and the lineup takes the next idle court.
      await prisma.pairing.update({ where: { id: court1.id }, data: { endedAt: new Date() } });
      await prisma.pairing.deleteMany({ where: { id: court2.id } });
      await service.propose(d.sessionCode, 2);
      expect(seated(await pendingOn(d.sessionCode, 2))).toEqual([d.ids[0], d.ids[4], d.ids[5], d.ids[6]]);
      expect(await prisma.queuedMatch.count({ where: { sessionId: d.sessionCode } })).toBe(0);
    } finally {
      await remove(d);
    }
  });

  it('reorders, edits and removes entries and reports blocked players', async () => {
    const d = await fixture(8);
    try {
      const one = await service.addLineup(d.sessionCode, { teamA: [d.ids[0], null], teamB: [null, null] });
      const two = await service.addLineup(d.sessionCode, { teamA: [d.ids[1], null], teamB: [null, null] });
      await service.moveLineup(d.sessionCode, two.id, { direction: 'up' });
      let view = (await service.getSession(d.sessionCode)).lineupQueue;
      expect(view.map((e) => e.id)).toEqual([two.id, one.id]);

      await service.replaceLineup(d.sessionCode, one.id, { teamA: [d.ids[0], d.ids[2]], teamB: [null, null] });
      await service.setRosterActive(d.sessionCode, d.ids[2], { active: false });
      view = (await service.getSession(d.sessionCode)).lineupQueue;
      expect(view.find((e) => e.id === one.id)!.blocked).toEqual([{ playerId: d.ids[2], reason: 'resting' }]);

      await service.removeLineup(d.sessionCode, one.id);
      await service.removeLineup(d.sessionCode, one.id); // idempotent
      expect((await service.getSession(d.sessionCode)).lineupQueue.map((e) => e.id)).toEqual([two.id]);
    } finally {
      await remove(d);
    }
  });

  it('leaves a lineup queued, and falls through to the engine, when no court it fits is idle', async () => {
    const d = await fixture(8, 1);
    try {
      // A singles lineup does not fit a doubles court.
      await service.addLineup(d.sessionCode, { teamA: [d.ids[0]], teamB: [d.ids[1]] });
      await service.propose(d.sessionCode, 1);
      expect(seated(await pendingOn(d.sessionCode, 1)).length).toBe(4);
      expect(await prisma.queuedMatch.count({ where: { sessionId: d.sessionCode } })).toBe(1);
    } finally {
      await remove(d);
    }
  });
});
