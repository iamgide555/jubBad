import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsModule } from './sessions.module.js';
import { SessionsService } from './sessions.service.js';
import { closeForgottenInTransaction } from './forgotten-session.js';
import { BillService } from './bill.service.js';
import { GroupsService } from '../groups/groups.service.js';

describe('forgotten session recovery', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: SessionsService;
  let groups: GroupsService;
  let groupCode: string;
  let code: string;
  let players: string[];
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [PrismaModule, SessionsModule] }).compile();
    app = module.createNestApplication(); await app.init();
    prisma = app.get(PrismaService); service = app.get(SessionsService); groups = app.get(GroupsService);
  });
  beforeEach(async () => {
    groupCode = randomUUID(); code = randomUUID();
    await prisma.group.create({ data: { code: groupCode } });
    players = [];
    for (let i = 0; i < 4; i++) players.push((await prisma.player.create({ data: { groupId: groupCode, name: `P${i}`, aliases: '[]' } })).id);
    await prisma.session.create({ data: { code, groupId: groupCode, rawImportText: '', courtCount: 3 } });
    await prisma.sessionRoster.createMany({ data: players.map(playerId => ({ sessionId: code, playerId })) });
  });
  afterEach(async () => {
    await prisma.pairingShuttleUse.deleteMany({ where: { pairing: { session: { groupId: groupCode } } } });
    await prisma.pairing.deleteMany({ where: { session: { groupId: groupCode } } });
    await prisma.queuedMatch.deleteMany({ where: { session: { groupId: groupCode } } });
    await prisma.sessionCheckout.deleteMany({ where: { session: { groupId: groupCode } } });
    await prisma.sessionShuttle.deleteMany({ where: { session: { groupId: groupCode } } });
    await prisma.sessionRoster.deleteMany({ where: { session: { groupId: groupCode } } });
    await prisma.session.deleteMany({ where: { groupId: groupCode } });
    await prisma.player.deleteMany({ where: { groupId: groupCode } });
    await prisma.group.delete({ where: { code: groupCode } });
  });
  afterAll(async () => { await app.close(); });
  const caller = { id: 'recovery-admin', role: 'admin' };
  const dto = () => ({ groupCode, date: null, venue: null, courtCount: 1, rawImportText: '', idempotencyKey: randomUUID(), rosterReviews: [], waitlistReviews: [] });
  const match = (courtNumber: number, confirmedAt: Date | null, endedAt: Date | null) => prisma.pairing.create({ data: {
    sessionId: code, courtNumber, matchNumber: 1, teamA: JSON.stringify(players.slice(0, 2)), teamB: JSON.stringify(players.slice(2)), confirmedAt, endedAt,
  } });

  it('previews without writes, recovers active games, and discards only unplayed lineups', async () => {
    const finished = await match(1, new Date(0), new Date(900_000));
    const active = await match(2, new Date(Date.now() - 86_400_000), null);
    const pending = await match(3, null, null);
    await prisma.queuedMatch.create({ data: { sessionId: code, position: 0, teamA: active.teamA, teamB: active.teamB } });
    const preview = await service.previewForgottenSession(code);
    expect(preview).toMatchObject({ pendingCount: 1, activeCount: 1, queuedCount: 1, averageDurationSeconds: 900 });
    expect((await prisma.session.findUniqueOrThrow({ where: { code } })).endedAt).toBeNull();
    await expect(service.endSession(code)).rejects.toMatchObject({ response: { code: 'SESSION_HAS_UNFINISHED_PAIRINGS' } });
    await service.closeForgottenSession(code, { snapshotHash: preview.snapshotHash });
    const recovered = await prisma.pairing.findUniqueOrThrow({ where: { id: active.id } });
    expect(recovered).toMatchObject({ winner: null, scoreA: null, scoreB: null, revision: 1, estimatedDurationSeconds: 900, confirmedAt: active.confirmedAt });
    expect(recovered.closedWithoutResultAt).toEqual(recovered.endedAt);
    expect(await prisma.pairing.findUnique({ where: { id: pending.id } })).toBeNull();
    expect(await prisma.queuedMatch.count({ where: { sessionId: code } })).toBe(0);
    expect(await prisma.pairing.findUnique({ where: { id: finished.id } })).toEqual(finished);
    const session = await prisma.session.findUniqueOrThrow({ where: { code } });
    expect(session.closedAsForgottenAt).toEqual(session.endedAt);
    await service.closeForgottenSession(code, { snapshotHash: preview.snapshotHash });
    expect(await prisma.pairing.findUnique({ where: { id: active.id } })).toEqual(recovered);
    const summary = await service.getSummary(code);
    expect(summary.players[0]).toMatchObject({ played: 2, won: 0, lost: 0, totalSeconds: 1800, measuredTotalSeconds: 900, measuredMatchCount: 1, estimatedMatchCount: 1, unknownDurationMatchCount: 0 });
    expect(summary.players[0].matches.find(m => m.pairingId === active.id)).toMatchObject({ durationSeconds: 900, durationSource: 'estimated' });
    const exported = await groups.exportGroup(groupCode);
    expect(exported.sessions[0]).toMatchObject({ closedAsForgottenAt: session.endedAt });
    expect(exported.sessions[0].matches.find(m => m.courtNumber === 2)).toMatchObject({ estimatedDurationSeconds: 900, closedWithoutResultAt: recovered.endedAt });
  });
  it('reports a stored recovery estimate separately from measured time', async () => {
    await match(1, new Date(0), new Date(600_000));
    const estimated = await match(2, new Date(0), new Date(86_400_000));
    await prisma.pairing.update({ where: { id: estimated.id }, data: { closedWithoutResultAt: estimated.endedAt, estimatedDurationSeconds: 900 } });
    const summary = await service.getSummary(code);
    expect(summary.players[0]).toMatchObject({ totalSeconds: 1500, measuredTotalSeconds: 600, measuredMatchCount: 1, estimatedMatchCount: 1 });
    expect(summary.players[0].matches[1]).toMatchObject({ durationSeconds: 900, durationSource: 'estimated' });
  });
  it('leaves unknown durations unknown and closes an empty session', async () => {
    const active = await match(1, new Date(0), null);
    const preview = await service.previewForgottenSession(code);
    expect(preview.averageDurationSeconds).toBeNull();
    await service.closeForgottenSession(code, { snapshotHash: preview.snapshotHash });
    const summary = await service.getSummary(code);
    expect(summary.players[0]).toMatchObject({ played: 1, totalSeconds: 0, measuredMatchCount: 0, unknownDurationMatchCount: 1 });
    expect(summary.players[0].matches[0]).toMatchObject({ durationSeconds: null, durationSource: 'unknown', pairingId: active.id });
    const created = await service.createSession(dto(), caller);
    const empty = await service.previewForgottenSession(created.code);
    await service.closeForgottenSession(created.code, { snapshotHash: empty.snapshotHash });
    expect((await prisma.session.findUniqueOrThrow({ where: { code: created.code } })).endedAt).not.toBeNull();
  });
  it.each(['revision', 'finish', 'auto-confirm', 'queue', 'new-sample'])('refuses a stale preview after %s changes without any partial closure', async change => {
    const pending = await match(1, null, null);
    const preview = await service.previewForgottenSession(code);
    if (change === 'revision') await prisma.pairing.update({ where: { id: pending.id }, data: { revision: { increment: 1 } } });
    if (change === 'finish') await prisma.pairing.update({ where: { id: pending.id }, data: { confirmedAt: new Date(0), endedAt: new Date(900_000) } });
    if (change === 'auto-confirm') await prisma.pairing.update({ where: { id: pending.id }, data: { confirmedAt: new Date() } });
    if (change === 'queue') await prisma.queuedMatch.create({ data: { sessionId: code, position: 0, teamA: pending.teamA, teamB: pending.teamB } });
    if (change === 'new-sample') await match(2, new Date(0), new Date(900_000));
    const before = await prisma.pairing.findMany({ where: { sessionId: code } });
    await expect(service.closeForgottenSession(code, { snapshotHash: preview.snapshotHash })).rejects.toMatchObject({ response: { code: 'SESSION_CLOSE_STALE' } });
    expect(await prisma.pairing.findMany({ where: { sessionId: code } })).toEqual(before);
    expect((await prisma.session.findUniqueOrThrow({ where: { code } })).endedAt).toBeNull();
  });
  it('blocks creation for every legacy open session and keeps retries idempotent', async () => {
    const older = randomUUID();
    await prisma.session.create({ data: { code: older, groupId: groupCode, rawImportText: '', createdAt: new Date(0) } });
    await expect(service.createSession(dto(), caller)).rejects.toMatchObject({ response: { code: 'GROUP_HAS_OPEN_SESSIONS', sessionCodes: [code, older] } });
    expect(await prisma.sessionCreation.count({ where: { groupId: groupCode } })).toBe(0);
    for (const c of [code, older]) { const p = await service.previewForgottenSession(c); await service.closeForgottenSession(c, { snapshotHash: p.snapshotHash }); }
    const request = dto(); const created = await service.createSession(request, caller);
    expect(await service.createSession(request, caller)).toEqual(created);
    await expect(service.createSession(request, { id: 'another-owner', role: 'host' })).rejects.toMatchObject({ status: 404 });
    const p = await service.previewForgottenSession(created.code); await service.closeForgottenSession(created.code, { snapshotHash: p.snapshotHash });
    const raced = await Promise.allSettled([service.createSession(dto(), caller), service.createSession(dto(), caller)]);
    expect(raced.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.session.count({ where: { groupId: groupCode, endedAt: null } })).toBe(1);
  });
  it('rolls back the entire closure if the transaction cannot commit', async () => {
    const pending = await match(1, null, null);
    const active = await match(2, new Date(0), null);
    const preview = await service.previewForgottenSession(code);
    await expect(prisma.$transaction(async tx => {
      await closeForgottenInTransaction(tx, code, preview.snapshotHash, new Date());
      throw new Error('commit failed');
    })).rejects.toThrow('commit failed');
    expect(await prisma.pairing.findUnique({ where: { id: pending.id } })).toEqual(pending);
    expect(await prisma.pairing.findUnique({ where: { id: active.id } })).toEqual(active);
    expect((await prisma.session.findUniqueOrThrow({ where: { code } })).endedAt).toBeNull();
  });
  it('preserves estimated provenance after a host later remembers the winner', async () => {
    await match(1, new Date(0), new Date(600_000));
    const active = await match(2, new Date(0), null);
    const preview = await service.previewForgottenSession(code);
    await service.closeForgottenSession(code, { snapshotHash: preview.snapshotHash });
    await service.correctResult(code, active.id, { winner: 'A', expectedRevision: 1 });
    const summary = await service.getSummary(code);
    expect(summary.players[0].matches.find(m => m.pairingId === active.id))
      .toMatchObject({ durationSeconds: 600, durationSource: 'estimated', resultCorrected: true });
    expect(summary.players[0].measuredMatchCount).toBe(1);
  });
  it('serializes simultaneous close retries without changing recovery time', async () => {
    const active = await match(1, new Date(0), null);
    const preview = await service.previewForgottenSession(code);
    const results = await Promise.all([service.closeForgottenSession(code, { snapshotHash: preview.snapshotHash }), service.closeForgottenSession(code, { snapshotHash: preview.snapshotHash })]);
    expect(results[0]).toEqual(results[1]);
    expect((await prisma.pairing.findUniqueOrThrow({ where: { id: active.id } })).revision).toBe(1);
  });
  it('preserves advanced shuttle records and settled receipts', async () => {
    await prisma.session.update({ where: { code }, data: { shuttleToolsEnabled: true } });
    const active = await match(1, new Date(0), null);
    const shuttle = await prisma.sessionShuttle.create({ data: { sessionId: code, number: 1 } });
    await prisma.pairing.update({ where: { id: active.id }, data: { shuttleLogKnown: true, lastShuttleId: shuttle.id } });
    const use = await prisma.pairingShuttleUse.create({ data: { pairingId: active.id, shuttleId: shuttle.id } });
    const receipt = await prisma.sessionCheckout.create({ data: { sessionId: code, playerId: players[0], model: 'perGame', amountSatang: 100, idempotencyKey: randomUUID(), breakdown: JSON.stringify({ baseSatang: 100, shuttleSatang: 0, hostFeeSatang: 0, walkInFeeSatang: 0, discountSatang: 0 }), snapshot: JSON.stringify({ version: 1, hash: 'settled', games: 0, shuttleIds: [], shuttlePriceSatang: null, walkIn: false }) } });
    const preview = await service.previewForgottenSession(code); await service.closeForgottenSession(code, { snapshotHash: preview.snapshotHash });
    expect(await prisma.pairingShuttleUse.findUnique({ where: { pairingId_shuttleId: { pairingId: active.id, shuttleId: shuttle.id } } })).toEqual(use);
    expect(await prisma.sessionShuttle.findUnique({ where: { id: shuttle.id } })).toEqual(shuttle);
    expect(await prisma.sessionCheckout.findUnique({ where: { id: receipt.id } })).toEqual(receipt);
    expect((await prisma.pairing.findUniqueOrThrow({ where: { id: active.id } })).shuttleLogKnown).toBe(true);
    const bill = await app.get(BillService).getBill(code);
    expect(bill.accounting.finishedMatches).toBe(1);
    expect(bill.players.every(p => p.games === 1)).toBe(true);
    expect(bill.settled).toHaveLength(1);
    expect(await service.autoConfirmDue()).toEqual([]);
  });
});
