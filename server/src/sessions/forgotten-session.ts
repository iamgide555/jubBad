import { createHash } from 'node:crypto';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { averageRecordedSeconds, estimateAtClosure } from './match-duration.js';

export interface ClosePreview {
  code: string;
  endedAt: string | null;
  snapshotHash: string;
  pendingCount: number;
  activeCount: number;
  queuedCount: number;
  averageDurationSeconds: number | null;
}

/** All inputs to a reviewed closure, from one database snapshot. */
export async function readClosureSnapshot(tx: Prisma.TransactionClient, code: string) {
  const session = await tx.session.findUnique({ where: { code } });
  if (!session) throw new NotFoundException({ code: 'SESSION_NOT_FOUND' });
  const pairings = await tx.pairing.findMany({ where: { sessionId: code }, orderBy: { id: 'asc' } });
  const queues = await tx.queuedMatch.findMany({ where: { sessionId: code }, orderBy: { id: 'asc' } });
  const snapshotHash = createHash('sha256').update(JSON.stringify({
    code: session.code, endedAt: session.endedAt?.toISOString() ?? null,
    pairings: pairings.map(p => ({ id: p.id, revision: p.revision,
      confirmedAt: p.confirmedAt?.toISOString() ?? null,
      endedAt: p.endedAt?.toISOString() ?? null,
      closedWithoutResultAt: p.closedWithoutResultAt?.toISOString() ?? null,
      estimatedDurationSeconds: p.estimatedDurationSeconds })),
    queues: queues.map(q => ({ id: q.id, position: q.position, teamA: q.teamA, teamB: q.teamB })),
  })).digest('hex');
  const preview: ClosePreview = {
    code, endedAt: session.endedAt?.toISOString() ?? null, snapshotHash,
    pendingCount: pairings.filter(p => p.confirmedAt === null && p.endedAt === null).length,
    activeCount: pairings.filter(p => p.confirmedAt !== null && p.endedAt === null).length,
    queuedCount: queues.length, averageDurationSeconds: averageRecordedSeconds(pairings),
  };
  return { session, pairings, preview };
}

/** Caller holds the group's lock, then the session's lock, and owns this transaction. */
export async function closeForgottenInTransaction(
  tx: Prisma.TransactionClient, code: string, snapshotHash: string, now: Date,
): Promise<{ code: string; endedAt: Date }> {
  const { session, pairings, preview } = await readClosureSnapshot(tx, code);
  // A response may have been lost after commit. Retrying must never re-estimate.
  if (session.endedAt !== null) return { code, endedAt: session.endedAt };
  if (preview.snapshotHash !== snapshotHash) throw new ConflictException({ code: 'SESSION_CLOSE_STALE' });
  const pendingIds = pairings.filter(p => p.confirmedAt === null && p.endedAt === null).map(p => p.id);
  await tx.pairingShuttleUse.deleteMany({ where: { pairingId: { in: pendingIds } } });
  await tx.pairing.deleteMany({ where: { id: { in: pendingIds } } });
  for (const p of pairings.filter(p => p.confirmedAt !== null && p.endedAt === null)) {
    await tx.pairing.update({ where: { id: p.id }, data: {
      endedAt: now, closedWithoutResultAt: now,
      estimatedDurationSeconds: estimateAtClosure(p, preview.averageDurationSeconds, now),
      winner: null, scoreA: null, scoreB: null, revision: { increment: 1 },
    } });
  }
  await tx.queuedMatch.deleteMany({ where: { sessionId: code } });
  await tx.session.update({ where: { code }, data: { endedAt: now, closedAsForgottenAt: now } });
  return { code, endedAt: now };
}
