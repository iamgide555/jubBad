import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsModule } from './sessions.module.js';
import { AUTO_CONFIRM_DELAY_MS, SessionsService } from './sessions.service.js';

/**
 * Lifecycle rules for numbered, reusable shuttles (host feedback D): a game
 * starts with one shuttle chosen atomically with confirmation, auto-confirm
 * reuses or opens one, finish keeps the log, and undo never erases a shuttle
 * that was physically opened. Written against the real service and DB.
 */
describe('shuttle lifecycle', () => {
  let prisma: PrismaService;
  let service: SessionsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [PrismaModule, SessionsModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(SessionsService);
  });

  async function fixture(playerCount: number, courtCount: number, advanced = true) {
    const groupCode = randomUUID();
    const sessionCode = randomUUID().slice(0, 8);
    await prisma.group.create({ data: { code: groupCode } });
    const players = await Promise.all(
      Array.from({ length: playerCount }, (_, i) =>
        prisma.player.create({ data: { groupId: groupCode, name: `P${i + 1}`, aliases: '[]' } })
      )
    );
    await prisma.session.create({
      data: { code: sessionCode, groupId: groupCode, courtCount, rawImportText: '', shuttleToolsEnabled: advanced },
    });
    await Promise.all(
      players.map((p) => prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } }))
    );
    const cleanup = async () => {
      await prisma.pairingShuttleUse.deleteMany({ where: { pairing: { sessionId: sessionCode } } });
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionShuttle.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { code: sessionCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    };
    return { sessionCode, cleanup };
  }

  async function propose(sessionCode: string, court: number) {
    const res = await service.propose(sessionCode, court);
    if (!res.ok) throw new Error(`propose failed: ${JSON.stringify(res)}`);
    return res.pairing;
  }

  const numbers = async (sessionCode: string) =>
    (await prisma.sessionShuttle.findMany({ where: { sessionId: sessionCode }, orderBy: { number: 'asc' } })).map((s) => s.number);
  const usesOf = (pairingId: string) => prisma.pairingShuttleUse.findMany({ where: { pairingId } });
  const row = (id: string) => prisma.pairing.findUniqueOrThrow({ where: { id } });
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      if (e instanceof HttpException) {
        const body = e.getResponse() as { code?: string };
        return { status: e.getStatus(), code: body.code };
      }
      throw e;
    }
    return null;
  };
  /** Makes a pending pairing due and runs the sweep. */
  async function makeDue(ids: string[]) {
    const pendingSince = new Date(Date.now() - AUTO_CONFIRM_DELAY_MS - 5_000);
    await prisma.pairing.updateMany({ where: { id: { in: ids } }, data: { pendingSince } });
    return new Date();
  }

  describe('shuttle confirm', () => {
    it('opening a new shuttle on manual confirm creates #1 and one use, atomically with confirmation', async () => {
      const { sessionCode, cleanup } = await fixture(4, 1);
      try {
        const p = await propose(sessionCode, 1);
        const confirmed = await service.confirmPairing(sessionCode, p.id, undefined, { kind: 'new' });
        expect(confirmed.confirmedAt).not.toBeNull();
        expect(confirmed.shuttleLogKnown).toBe(true);
        expect(await numbers(sessionCode)).toEqual([1]);
        const shuttle = (await prisma.sessionShuttle.findFirstOrThrow({ where: { sessionId: sessionCode } }));
        expect(confirmed.lastShuttleId).toBe(shuttle.id);
        expect((await usesOf(p.id)).map((u) => u.shuttleId)).toEqual([shuttle.id]);
      } finally {
        await cleanup();
      }
    });

    it('the next game on the court reuses #1 without growing the inventory', async () => {
      const { sessionCode, cleanup } = await fixture(4, 1);
      try {
        const first = await propose(sessionCode, 1);
        await service.confirmPairing(sessionCode, first.id, undefined, { kind: 'new' });
        await service.finishPairing(sessionCode, first.id, { winner: 'A' });
        const shuttle = await prisma.sessionShuttle.findFirstOrThrow({ where: { sessionId: sessionCode } });

        const second = await propose(sessionCode, 1);
        const confirmed = await service.confirmPairing(sessionCode, second.id, undefined, {
          kind: 'existing',
          shuttleId: shuttle.id,
        });
        expect(confirmed.lastShuttleId).toBe(shuttle.id);
        expect(await numbers(sessionCode)).toEqual([1]);
        expect(await prisma.pairingShuttleUse.count({ where: { shuttleId: shuttle.id } })).toBe(2);
      } finally {
        await cleanup();
      }
    });

    it('refuses an explicit shuttle that is current on another active court', async () => {
      const { sessionCode, cleanup } = await fixture(8, 2);
      try {
        const a = await propose(sessionCode, 1);
        await service.confirmPairing(sessionCode, a.id, undefined, { kind: 'new' });
        const shuttle = await prisma.sessionShuttle.findFirstOrThrow({ where: { sessionId: sessionCode } });
        const b = await propose(sessionCode, 2);
        const err = await code(
          service.confirmPairing(sessionCode, b.id, undefined, { kind: 'existing', shuttleId: shuttle.id })
        );
        expect(err).toEqual({ status: 409, code: 'SHUTTLE_UNAVAILABLE' });
        expect((await row(b.id)).confirmedAt).toBeNull();
      } finally {
        await cleanup();
      }
    });

    it('refuses a retired shuttle (409) and a foreign or voided one (404)', async () => {
      const { sessionCode, cleanup } = await fixture(4, 1);
      const other = await fixture(4, 1);
      try {
        const retired = await prisma.sessionShuttle.create({ data: { sessionId: sessionCode, number: 1, usable: false } });
        const voided = await prisma.sessionShuttle.create({ data: { sessionId: sessionCode, number: 2, voidedAt: new Date() } });
        const foreign = await prisma.sessionShuttle.create({ data: { sessionId: other.sessionCode, number: 1 } });
        const p = await propose(sessionCode, 1);
        const pick = (shuttleId: string) => code(service.confirmPairing(sessionCode, p.id, undefined, { kind: 'existing', shuttleId }));
        expect(await pick(retired.id)).toEqual({ status: 409, code: 'SHUTTLE_UNAVAILABLE' });
        expect(await pick(voided.id)).toEqual({ status: 404, code: 'SHUTTLE_NOT_FOUND' });
        expect(await pick(foreign.id)).toEqual({ status: 404, code: 'SHUTTLE_NOT_FOUND' });
        expect((await row(p.id)).confirmedAt).toBeNull();
      } finally {
        await cleanup();
        await other.cleanup();
      }
    });

    it('rejects an advanced manual confirm with no shuttle choice and leaves the match pending', async () => {
      const { sessionCode, cleanup } = await fixture(4, 1);
      try {
        const p = await propose(sessionCode, 1);
        expect(await code(service.confirmPairing(sessionCode, p.id))).toEqual({ status: 400, code: 'SHUTTLE_CHOICE_REQUIRED' });
        expect((await row(p.id)).confirmedAt).toBeNull();
        expect(await numbers(sessionCode)).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it('an ordinary session confirms with no payload, creates no shuttle, and refuses one', async () => {
      const { sessionCode, cleanup } = await fixture(4, 1, false);
      try {
        const p = await propose(sessionCode, 1);
        expect(await code(service.confirmPairing(sessionCode, p.id, undefined, { kind: 'new' }))).toEqual({
          status: 409,
          code: 'SHUTTLE_TRACKING_DISABLED',
        });
        const confirmed = await service.confirmPairing(sessionCode, p.id);
        expect(confirmed.confirmedAt).not.toBeNull();
        expect(confirmed.shuttleLogKnown).toBe(false);
        expect(await numbers(sessionCode)).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it('a stale confirm cannot leave an orphan opened shuttle', async () => {
      const { sessionCode, cleanup } = await fixture(4, 1);
      try {
        const p = await propose(sessionCode, 1);
        expect(await code(service.confirmPairing(sessionCode, p.id, p.revision + 5, { kind: 'new' }))).toEqual({
          status: 409,
          code: 'PAIRING_STALE',
        });
        expect(await numbers(sessionCode)).toEqual([]);
        expect((await row(p.id)).confirmedAt).toBeNull();
      } finally {
        await cleanup();
      }
    });
  });

  describe('shuttle auto', () => {
    it('auto-confirm opens #1 for a first game and reuses the last idle shuttle for the next', async () => {
      const { sessionCode, cleanup } = await fixture(4, 1);
      try {
        const first = await propose(sessionCode, 1);
        expect(await service.autoConfirmDue(await makeDue([first.id]))).toEqual([first.id]);
        const firstRow = await row(first.id);
        expect(firstRow.shuttleLogKnown).toBe(true);
        expect(await numbers(sessionCode)).toEqual([1]);

        await service.finishPairing(sessionCode, first.id, { winner: 'B' });
        const second = await propose(sessionCode, 1);
        expect(await service.autoConfirmDue(await makeDue([second.id]))).toEqual([second.id]);
        expect((await row(second.id)).lastShuttleId).toBe(firstRow.lastShuttleId);
        expect(await numbers(sessionCode)).toEqual([1]);
      } finally {
        await cleanup();
      }
    });

    it('two courts auto-confirming together get distinct starting shuttles, even from concurrent sweeps', async () => {
      const { sessionCode, cleanup } = await fixture(8, 2);
      try {
        const a = await propose(sessionCode, 1);
        const b = await propose(sessionCode, 2);
        const now = await makeDue([a.id, b.id]);
        await Promise.all([service.autoConfirmDue(now), service.autoConfirmDue(now)]);
        const [ra, rb] = [await row(a.id), await row(b.id)];
        expect(ra.confirmedAt).not.toBeNull();
        expect(rb.confirmedAt).not.toBeNull();
        expect(ra.lastShuttleId).not.toBe(rb.lastShuttleId);
        expect(await numbers(sessionCode)).toEqual([1, 2]);
      } finally {
        await cleanup();
      }
    });

    it('opens a new shuttle when the court\'s last one is retired or now busy on another court', async () => {
      const { sessionCode, cleanup } = await fixture(8, 2);
      try {
        const a1 = await propose(sessionCode, 1);
        await service.confirmPairing(sessionCode, a1.id, undefined, { kind: 'new' });
        await service.finishPairing(sessionCode, a1.id, { winner: 'A' });
        const shuttle1 = await prisma.sessionShuttle.findFirstOrThrow({ where: { sessionId: sessionCode } });
        // Court 2 takes #1 for itself, so court 1's suggestion is busy.
        const b1 = await propose(sessionCode, 2);
        await service.confirmPairing(sessionCode, b1.id, undefined, { kind: 'existing', shuttleId: shuttle1.id });
        const a2 = await propose(sessionCode, 1);
        expect(await service.autoConfirmDue(await makeDue([a2.id]))).toEqual([a2.id]);
        expect((await row(a2.id)).lastShuttleId).not.toBe(shuttle1.id);
        expect(await numbers(sessionCode)).toEqual([1, 2]);

        // Retire #2 and let court 1 finish; its suggestion is now unusable.
        await service.finishPairing(sessionCode, a2.id, { winner: 'A' });
        const shuttle2 = await prisma.sessionShuttle.findFirstOrThrow({ where: { sessionId: sessionCode, number: 2 } });
        await prisma.sessionShuttle.update({ where: { id: shuttle2.id }, data: { usable: false } });
        const a3 = await propose(sessionCode, 1);
        expect(await service.autoConfirmDue(await makeDue([a3.id]))).toEqual([a3.id]);
        expect((await row(a3.id)).lastShuttleId).not.toBe(shuttle2.id);
        expect(await numbers(sessionCode)).toEqual([1, 2, 3]);
      } finally {
        await cleanup();
      }
    });

    it('an ordinary session auto-confirms exactly as before, with no shuttle', async () => {
      const { sessionCode, cleanup } = await fixture(4, 1, false);
      try {
        const p = await propose(sessionCode, 1);
        expect(await service.autoConfirmDue(await makeDue([p.id]))).toEqual([p.id]);
        expect((await row(p.id)).shuttleLogKnown).toBe(false);
        expect(await numbers(sessionCode)).toEqual([]);
      } finally {
        await cleanup();
      }
    });
  });

  describe('shuttle undo', () => {
    it('undoing a confirmation removes the use but keeps #1, and the next new shuttle is #2', async () => {
      const { sessionCode, cleanup } = await fixture(4, 1);
      try {
        const p = await propose(sessionCode, 1);
        await service.confirmPairing(sessionCode, p.id, undefined, { kind: 'new' });
        expect(await service.undoLastOnCourt(sessionCode, 1)).toMatchObject({ ok: true, undone: 'confirm' });
        const after = await row(p.id);
        expect(after.confirmedAt).toBeNull();
        expect(after.shuttleLogKnown).toBe(false);
        expect(after.lastShuttleId).toBeNull();
        expect(await usesOf(p.id)).toEqual([]);
        expect(await numbers(sessionCode)).toEqual([1]);

        await service.confirmPairing(sessionCode, p.id, undefined, { kind: 'new' });
        expect(await numbers(sessionCode)).toEqual([1, 2]);
      } finally {
        await cleanup();
      }
    });

    it('a no-result finish keeps the game\'s use and last shuttle', async () => {
      const { sessionCode, cleanup } = await fixture(4, 1);
      try {
        const p = await propose(sessionCode, 1);
        const confirmed = await service.confirmPairing(sessionCode, p.id, undefined, { kind: 'new' });
        await service.finishPairing(sessionCode, p.id, {});
        const after = await row(p.id);
        expect(after.endedAt).not.toBeNull();
        expect(after.lastShuttleId).toBe(confirmed.lastShuttleId);
        expect(await usesOf(p.id)).toHaveLength(1);
      } finally {
        await cleanup();
      }
    });

    it('undoing a finish restores the match with its log and current shuttle when it is still idle', async () => {
      const { sessionCode, cleanup } = await fixture(4, 1);
      try {
        const p = await propose(sessionCode, 1);
        const confirmed = await service.confirmPairing(sessionCode, p.id, undefined, { kind: 'new' });
        await service.finishPairing(sessionCode, p.id, { winner: 'A' });
        expect(await service.undoLastOnCourt(sessionCode, 1)).toMatchObject({ ok: true, undone: 'finish' });
        const after = await row(p.id);
        expect(after.endedAt).toBeNull();
        expect(after.lastShuttleId).toBe(confirmed.lastShuttleId);
        expect(await usesOf(p.id)).toHaveLength(1);
      } finally {
        await cleanup();
      }
    });

    it('undoing a finish while another court holds #1 restores the log but leaves no current shuttle', async () => {
      const { sessionCode, cleanup } = await fixture(8, 2);
      try {
        // Both courts are proposed up front so they seat different players;
        // otherwise undoing court 1's finish would trip the players-busy guard.
        const a = await propose(sessionCode, 1);
        const b = await propose(sessionCode, 2);
        await service.confirmPairing(sessionCode, a.id, undefined, { kind: 'new' });
        const shuttle = await prisma.sessionShuttle.findFirstOrThrow({ where: { sessionId: sessionCode } });
        await service.finishPairing(sessionCode, a.id, { winner: 'A' });
        await service.confirmPairing(sessionCode, b.id, undefined, { kind: 'existing', shuttleId: shuttle.id });

        expect(await service.undoLastOnCourt(sessionCode, 1)).toMatchObject({ ok: true, undone: 'finish' });
        const after = await row(a.id);
        expect(after.endedAt).toBeNull();
        expect(after.shuttleLogKnown).toBe(true);
        expect(after.lastShuttleId).toBeNull();
        expect(await usesOf(a.id)).toHaveLength(1);
        expect((await row(b.id)).lastShuttleId).toBe(shuttle.id);
      } finally {
        await cleanup();
      }
    });

    it('a winner tap and a confirm keep their revision guard with shuttles on', async () => {
      const { sessionCode, cleanup } = await fixture(4, 1);
      try {
        const p = await propose(sessionCode, 1);
        const confirmed = await service.confirmPairing(sessionCode, p.id, undefined, { kind: 'new' });
        expect(await code(service.finishPairing(sessionCode, p.id, { winner: 'A', expectedRevision: confirmed.revision - 1 }))).toEqual({
          status: 409,
          code: 'PAIRING_STALE',
        });
        expect((await row(p.id)).endedAt).toBeNull();
      } finally {
        await cleanup();
      }
    });
  });
});
