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

  /** Proposes, confirms with a new shuttle, and returns the live pairing and its shuttle id. */
  async function startActive(sessionCode: string, court: number, choice: Parameters<SessionsService['confirmPairing']>[3] = { kind: 'new' }) {
    const p = await propose(sessionCode, court);
    const confirmed = await service.confirmPairing(sessionCode, p.id, undefined, choice);
    return { id: p.id, revision: confirmed.revision, shuttleId: confirmed.lastShuttleId! };
  }
  const shuttleRow = (id: string) => prisma.sessionShuttle.findUniqueOrThrow({ where: { id } });
  const openOne = (sessionCode: string, number: number, extra: Record<string, unknown> = {}) =>
    prisma.sessionShuttle.create({ data: { sessionId: sessionCode, number, ...extra } });

  describe('shuttle switch', () => {
    it('switching among session shuttles writes each use once, even when returning to one', async () => {
      const { sessionCode, cleanup } = await fixture(4, 1);
      try {
        const g = await startActive(sessionCode, 1);
        const two = await openOne(sessionCode, 2);
        let rev = g.revision;
        for (const target of [two.id, g.shuttleId, two.id]) {
          const r = await service.switchShuttle(sessionCode, g.id, { choice: { kind: 'existing', shuttleId: target }, expectedRevision: rev });
          rev = r.revision;
          expect(r.lastShuttleId).toBe(target);
        }
        expect((await usesOf(g.id)).map((u) => u.shuttleId).sort()).toEqual([g.shuttleId, two.id].sort());
      } finally {
        await cleanup();
      }
    });

    it('opening a new shuttle mid-game adds it to the game\'s uses', async () => {
      const { sessionCode, cleanup } = await fixture(4, 1);
      try {
        const g = await startActive(sessionCode, 1);
        const r = await service.switchShuttle(sessionCode, g.id, { choice: { kind: 'new' }, expectedRevision: g.revision });
        expect(await numbers(sessionCode)).toEqual([1, 2]);
        expect(await usesOf(g.id)).toHaveLength(2);
        expect(r.lastShuttleId).not.toBe(g.shuttleId);
      } finally {
        await cleanup();
      }
    });

    it('another active court cannot claim the current shuttle, and switching away releases it', async () => {
      const { sessionCode, cleanup } = await fixture(8, 2);
      try {
        const a = await startActive(sessionCode, 1);
        const b = await startActive(sessionCode, 2);
        const claim = (shuttleId: string, id = b.id, rev = b.revision) =>
          service.switchShuttle(sessionCode, id, { choice: { kind: 'existing', shuttleId }, expectedRevision: rev });
        expect(await code(claim(a.shuttleId))).toEqual({ status: 409, code: 'SHUTTLE_UNAVAILABLE' });

        await service.switchShuttle(sessionCode, a.id, { choice: { kind: 'new' }, expectedRevision: a.revision });
        const claimed = await claim(a.shuttleId);
        expect(claimed.lastShuttleId).toBe(a.shuttleId);
      } finally {
        await cleanup();
      }
    });

    it('switch-and-retire is one atomic action; a refused switch retires nothing', async () => {
      const { sessionCode, cleanup } = await fixture(8, 2);
      try {
        const a = await startActive(sessionCode, 1);
        const b = await startActive(sessionCode, 2);
        // Refused (court 2's shuttle is busy): the previous shuttle stays usable.
        expect(
          await code(
            service.switchShuttle(sessionCode, a.id, {
              choice: { kind: 'existing', shuttleId: b.shuttleId },
              expectedRevision: a.revision,
              retirePrevious: true,
            })
          )
        ).toEqual({ status: 409, code: 'SHUTTLE_UNAVAILABLE' });
        expect((await shuttleRow(a.shuttleId)).usable).toBe(true);

        // Accepted: new shuttle in hand and the old one retired together.
        const r = await service.switchShuttle(sessionCode, a.id, {
          choice: { kind: 'new' },
          expectedRevision: a.revision,
          retirePrevious: true,
        });
        expect((await shuttleRow(a.shuttleId)).usable).toBe(false);
        expect(r.lastShuttleId).not.toBe(a.shuttleId);
        expect(await usesOf(a.id)).toHaveLength(2);
      } finally {
        await cleanup();
      }
    });

    it('rejects a stale revision, a pending game, a finished game, an ended session and an ordinary session without any write', async () => {
      const { sessionCode, cleanup } = await fixture(8, 2);
      const ordinary = await fixture(4, 1, false);
      try {
        const a = await startActive(sessionCode, 1);
        const sw = (id: string, rev: number, session = sessionCode) =>
          code(service.switchShuttle(session, id, { choice: { kind: 'new' }, expectedRevision: rev }));
        expect(await sw(a.id, a.revision + 7)).toEqual({ status: 409, code: 'PAIRING_STALE' });

        const pending = await propose(sessionCode, 2);
        expect(await sw(pending.id, pending.revision)).toEqual({ status: 409, code: 'PAIRING_CONFIRMATION_REQUIRED' });

        const ordPairing = await propose(ordinary.sessionCode, 1);
        await service.confirmPairing(ordinary.sessionCode, ordPairing.id);
        expect(await sw(ordPairing.id, ordPairing.revision + 1, ordinary.sessionCode)).toEqual({
          status: 409,
          code: 'SHUTTLE_TRACKING_DISABLED',
        });

        const finished = await service.finishPairing(sessionCode, a.id, { winner: 'A' });
        expect(await sw(a.id, finished.revision)).toEqual({ status: 409, code: 'PAIRING_ENDED' });
        expect(await numbers(sessionCode)).toEqual([1]);

        await prisma.session.update({ where: { code: sessionCode }, data: { endedAt: new Date() } });
        expect(await sw(a.id, finished.revision)).toEqual({ status: 409, code: 'SESSION_ENDED' });
        expect(await numbers(ordinary.sessionCode)).toEqual([]);
      } finally {
        await cleanup();
        await ordinary.cleanup();
      }
    });

    it('a winner tap that lands first makes the late switch fail, keeping only the accepted update', async () => {
      const { sessionCode, cleanup } = await fixture(4, 1);
      try {
        const g = await startActive(sessionCode, 1);
        await service.finishPairing(sessionCode, g.id, { winner: 'A', expectedRevision: g.revision });
        expect(await code(service.switchShuttle(sessionCode, g.id, { choice: { kind: 'new' }, expectedRevision: g.revision }))).toMatchObject({ status: 409 });
        expect(await numbers(sessionCode)).toEqual([1]);
        expect((await row(g.id)).winner).toBe('A');

        // The mirror: the switch lands first, so the late winner tap is stale.
        const h = await startActive(sessionCode, 1);
        const switched = await service.switchShuttle(sessionCode, h.id, { choice: { kind: 'new' }, expectedRevision: h.revision });
        expect(await code(service.finishPairing(sessionCode, h.id, { winner: 'B', expectedRevision: h.revision }))).toEqual({
          status: 409,
          code: 'PAIRING_STALE',
        });
        expect((await row(h.id)).endedAt).toBeNull();
        expect(switched.revision).toBe(h.revision + 1);
      } finally {
        await cleanup();
      }
    });
  });

  describe('shuttle inventory', () => {
    it('a standalone retire of a current shuttle fails, an idle one retires, and restore works', async () => {
      const { sessionCode, cleanup } = await fixture(4, 1);
      try {
        const g = await startActive(sessionCode, 1);
        expect(await code(service.setShuttleUsable(sessionCode, g.shuttleId, false))).toEqual({ status: 409, code: 'SHUTTLE_IN_USE' });
        const idle = await openOne(sessionCode, 2);
        expect(await service.setShuttleUsable(sessionCode, idle.id, false)).toMatchObject({ usable: false });
        expect(await service.setShuttleUsable(sessionCode, idle.id, true)).toMatchObject({ usable: true });
        expect((await shuttleRow(g.shuttleId)).usable).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it('an unreferenced shuttle can be voided and its number is never reused; referenced, current and foreign ones cannot', async () => {
      const { sessionCode, cleanup } = await fixture(4, 1);
      const other = await fixture(4, 1);
      try {
        const g = await startActive(sessionCode, 1);
        const orphan = await openOne(sessionCode, 2);
        const foreign = await openOne(other.sessionCode, 1);
        expect(await code(service.voidShuttle(sessionCode, g.shuttleId))).toEqual({ status: 409, code: 'SHUTTLE_IN_USE' });
        expect(await code(service.voidShuttle(sessionCode, foreign.id))).toEqual({ status: 404, code: 'SHUTTLE_NOT_FOUND' });

        await service.voidShuttle(sessionCode, orphan.id);
        expect((await shuttleRow(orphan.id)).voidedAt).not.toBeNull();
        expect(await code(service.voidShuttle(sessionCode, orphan.id))).toEqual({ status: 404, code: 'SHUTTLE_NOT_FOUND' });
        // #2 stays reserved, so the next opened shuttle is #3.
        await service.switchShuttle(sessionCode, g.id, { choice: { kind: 'new' }, expectedRevision: g.revision });
        expect(await numbers(sessionCode)).toEqual([1, 2, 3]);
      } finally {
        await cleanup();
        await other.cleanup();
      }
    });

    it('a retired shuttle that has been used cannot be voided, and tracking-off sessions refuse every inventory write', async () => {
      const { sessionCode, cleanup } = await fixture(4, 1);
      const ordinary = await fixture(4, 1, false);
      try {
        const g = await startActive(sessionCode, 1);
        await service.finishPairing(sessionCode, g.id, { winner: 'A' });
        await service.setShuttleUsable(sessionCode, g.shuttleId, false);
        expect(await code(service.voidShuttle(sessionCode, g.shuttleId))).toEqual({ status: 409, code: 'SHUTTLE_IN_USE' });

        const stray = await openOne(ordinary.sessionCode, 1);
        expect(await code(service.setShuttleUsable(ordinary.sessionCode, stray.id, false))).toEqual({ status: 409, code: 'SHUTTLE_TRACKING_DISABLED' });
        expect(await code(service.voidShuttle(ordinary.sessionCode, stray.id))).toEqual({ status: 409, code: 'SHUTTLE_TRACKING_DISABLED' });
      } finally {
        await cleanup();
        await ordinary.cleanup();
      }
    });
  });

  describe('shuttle correction', () => {
    async function finishedGame(sessionCode: string, court = 1) {
      const g = await startActive(sessionCode, court);
      const done = await service.finishPairing(sessionCode, g.id, { winner: 'A', scoreA: 21, scoreB: 15 });
      return { ...g, revision: done.revision };
    }

    it('a correction may add a shuttle that is now retired, while a live court may not select it', async () => {
      const { sessionCode, cleanup } = await fixture(8, 2);
      try {
        const old = await finishedGame(sessionCode, 1);
        const retired = await openOne(sessionCode, 2, { usable: false });
        const fixed = await service.correctShuttleUse(sessionCode, old.id, { shuttleIds: [old.shuttleId, retired.id], openNew: false, expectedRevision: old.revision });
        expect((await usesOf(old.id)).map((u) => u.shuttleId).sort()).toEqual([old.shuttleId, retired.id].sort());
        expect(fixed.shuttleLogKnown).toBe(true);

        const live = await startActive(sessionCode, 2);
        expect(
          await code(service.switchShuttle(sessionCode, live.id, { choice: { kind: 'existing', shuttleId: retired.id }, expectedRevision: live.revision }))
        ).toEqual({ status: 409, code: 'SHUTTLE_UNAVAILABLE' });
      } finally {
        await cleanup();
      }
    });

    it('correcting to none is known zero and clears the court\'s next-game suggestion; the winner and score are untouched', async () => {
      const { sessionCode, cleanup } = await fixture(4, 1);
      try {
        const old = await finishedGame(sessionCode);
        await service.correctShuttleUse(sessionCode, old.id, { shuttleIds: [], openNew: false, expectedRevision: old.revision });
        const after = await row(old.id);
        expect(after.shuttleLogKnown).toBe(true);
        expect(await usesOf(old.id)).toEqual([]);
        expect(after.lastShuttleId).toBeNull();
        expect(after.winner).toBe('A');
        expect([after.scoreA, after.scoreB]).toEqual([21, 15]);
        expect(after.revision).toBe(old.revision + 1);
      } finally {
        await cleanup();
      }
    });

    it('keeps the next-game suggestion when the corrected log still includes that shuttle', async () => {
      const { sessionCode, cleanup } = await fixture(4, 1);
      try {
        const old = await finishedGame(sessionCode);
        const extra = await openOne(sessionCode, 2);
        await service.correctShuttleUse(sessionCode, old.id, { shuttleIds: [old.shuttleId, extra.id], openNew: false, expectedRevision: old.revision });
        expect((await row(old.id)).lastShuttleId).toBe(old.shuttleId);
      } finally {
        await cleanup();
      }
    });

    it('opening a missed new shuttle after the session ended works', async () => {
      const { sessionCode, cleanup } = await fixture(4, 1);
      try {
        const old = await finishedGame(sessionCode);
        await prisma.session.update({ where: { code: sessionCode }, data: { endedAt: new Date(), shuttleCount: 6 } });
        await service.correctShuttleUse(sessionCode, old.id, { shuttleIds: [old.shuttleId], openNew: true, expectedRevision: old.revision });
        expect(await numbers(sessionCode)).toEqual([1, 2]);
        expect(await usesOf(old.id)).toHaveLength(2);
        // The physical nightly count is never rewritten by a game edit.
        expect((await prisma.session.findUniqueOrThrow({ where: { code: sessionCode } })).shuttleCount).toBe(6);
      } finally {
        await cleanup();
      }
    });

    it('rejects duplicates, foreign and voided ids, a stale revision, and a pending or live game with no partial write', async () => {
      const { sessionCode, cleanup } = await fixture(8, 2);
      const other = await fixture(4, 1);
      try {
        const old = await finishedGame(sessionCode, 1);
        const foreign = await openOne(other.sessionCode, 1);
        const voided = await openOne(sessionCode, 2, { voidedAt: new Date() });
        const fix = (ids: string[], rev = old.revision, id = old.id) =>
          code(service.correctShuttleUse(sessionCode, id, { shuttleIds: ids, openNew: false, expectedRevision: rev }));
        expect(await fix([old.shuttleId, old.shuttleId])).toEqual({ status: 400, code: 'DUPLICATE_SHUTTLE_ID' });
        expect(await fix([foreign.id])).toEqual({ status: 404, code: 'SHUTTLE_NOT_FOUND' });
        expect(await fix([voided.id])).toEqual({ status: 404, code: 'SHUTTLE_NOT_FOUND' });
        expect(await fix([], old.revision + 3)).toEqual({ status: 409, code: 'PAIRING_STALE' });

        const live = await startActive(sessionCode, 2);
        expect(await fix([], live.revision, live.id)).toEqual({ status: 409, code: 'PAIRING_NOT_FINISHED' });
        expect(await usesOf(old.id)).toHaveLength(1);
        // #1 opened by the old game, #2 is the voided fixture, #3 opened by the live game:
        // none of the rejected corrections opened or removed anything.
        expect(await numbers(sessionCode)).toEqual([1, 2, 3]);
      } finally {
        await cleanup();
        await other.cleanup();
      }
    });

    it('an ordinary session refuses corrections', async () => {
      const ordinary = await fixture(4, 1, false);
      try {
        const p = await propose(ordinary.sessionCode, 1);
        await service.confirmPairing(ordinary.sessionCode, p.id);
        const done = await service.finishPairing(ordinary.sessionCode, p.id, { winner: 'A' });
        expect(
          await code(service.correctShuttleUse(ordinary.sessionCode, p.id, { shuttleIds: [], openNew: false, expectedRevision: done.revision }))
        ).toEqual({ status: 409, code: 'SHUTTLE_TRACKING_DISABLED' });
      } finally {
        await ordinary.cleanup();
      }
    });
  });
});
