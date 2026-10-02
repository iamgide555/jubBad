import { ConflictException, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import type { CheckoutModel } from '../../../engines/bill.ts';
import { PrismaService } from '../prisma/prisma.service.js';
import { loadBillSnapshot } from './bill-snapshot.js';
import {
  parseCheckoutBreakdown,
  serializeCheckoutBreakdown,
  serializeCheckoutSnapshot,
  type CheckoutBreakdown,
} from './checkout-pricing.js';
import { quoteCheckout, type CheckoutQuote } from './checkout-quote.js';
import type { ConfirmCheckoutDto } from './dto/confirm-checkout.dto.js';
import { SessionLock } from './session-lock.js';
import { SessionsService } from './sessions.service.js';

export type CheckoutPreviewResponse = Pick<
  CheckoutQuote,
  'playerId' | 'model' | 'amountSatang' | 'games' | 'breakdown' | 'snapshotHash' | 'shuttleCharge' | 'chargeSatang'
>;

export interface CheckoutReceipt {
  id: string;
  playerId: string;
  model: CheckoutModel;
  amountSatang: number;
  breakdown: CheckoutBreakdown;
  settledAt: Date;
}

const receiptOf = (row: {
  id: string; playerId: string; model: string; amountSatang: number; breakdown: string; settledAt: Date;
}): CheckoutReceipt => ({
  id: row.id,
  playerId: row.playerId,
  model: row.model as CheckoutModel,
  amountSatang: row.amountSatang,
  breakdown: parseCheckoutBreakdown(row.breakdown),
  settledAt: row.settledAt,
});

/**
 * Host-only early checkout (host feedback E). Owner-only by the global guards
 * (no @Public on its controller): receipts never reach display or public pages.
 *
 * Settle and undo run under the session lock -- the one every roster, court and
 * bill-config write also takes -- and then re-read and re-price inside a DB
 * transaction, so even a write that slipped past the lock cannot settle an
 * outdated amount.
 */
@Injectable()
export class CheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lock: SessionLock,
    private readonly sessions: SessionsService
  ) {}

  /** Read-only: a quote changes nothing and reserves nothing. */
  async preview(code: string, playerId: string, model: CheckoutModel): Promise<CheckoutPreviewResponse> {
    const snapshot = await this.prisma.$transaction((tx) => loadBillSnapshot(tx, code));
    const q = quoteCheckout(snapshot, playerId, model);
    return { playerId: q.playerId, model: q.model, amountSatang: q.amountSatang, games: q.games, breakdown: q.breakdown, snapshotHash: q.snapshotHash, shuttleCharge: q.shuttleCharge, chargeSatang: q.chargeSatang };
  }

  confirm(code: string, playerId: string, dto: ConfirmCheckoutDto): Promise<CheckoutReceipt> {
    return this.lock.run(code, () => this.confirmExclusively(code, playerId, dto));
  }

  private confirmExclusively(code: string, playerId: string, dto: ConfirmCheckoutDto): Promise<CheckoutReceipt> {
    return this.prisma.$transaction(async (tx) => {
      // A retry of an attempt that already landed returns its outcome; it never prices or writes again.
      const prior = await tx.sessionCheckout.findUnique({
        where: { sessionId_idempotencyKey: { sessionId: code, idempotencyKey: dto.idempotencyKey } },
      });
      if (prior) {
        if (prior.playerId !== playerId || prior.model !== dto.model) throw new ConflictException({ code: 'CHECKOUT_KEY_REUSED' });
        if (prior.undoneAt !== null) throw new ConflictException({ code: 'CHECKOUT_UNDONE' });
        return receiptOf(prior);
      }
      const snapshot = await loadBillSnapshot(tx, code);
      // Eligibility is judged first so a loser of a race sees PLAYER_CHECKED_OUT, not a stale-hash message.
      const quote = quoteCheckout(snapshot, playerId, dto.model);
      if (quote.snapshotHash !== dto.snapshotHash) throw new ConflictException({ code: 'CHECKOUT_STALE' });
      const row = await tx.sessionCheckout.create({
        data: {
          sessionId: code,
          playerId,
          model: dto.model,
          amountSatang: quote.amountSatang,
          breakdown: serializeCheckoutBreakdown(quote.breakdown),
          snapshot: serializeCheckoutSnapshot({
            version: 1,
            hash: quote.snapshotHash,
            games: quote.games,
            shuttleIds: quote.shuttleIds,
            shuttlePriceSatang: quote.shuttlePriceSatang,
            walkIn: quote.walkIn,
          }),
          idempotencyKey: dto.idempotencyKey,
        },
      });
      const roster = await tx.sessionRoster.updateMany({ where: { sessionId: code, playerId }, data: { active: false } });
      if (roster.count !== 1) throw new ConflictException({ code: 'ROSTER_STALE' });
      return receiptOf(row);
    });
  }

  /** Current receipts only; the audit trail of undone ones lives in the owner export. */
  async list(code: string): Promise<CheckoutReceipt[]> {
    const session = await this.prisma.session.findUnique({ where: { code } });
    if (!session) throw new NotFoundException({ code: 'SESSION_NOT_FOUND' });
    if (!session.shuttleToolsEnabled) throw new BadRequestException({ code: 'CHECKOUT_DISABLED' });
    const rows = await this.prisma.sessionCheckout.findMany({
      where: { sessionId: code, undoneAt: null },
      orderBy: { settledAt: 'asc' },
    });
    return rows.map(receiptOf);
  }

  undo(code: string, checkoutId: string): Promise<{ ok: true; playerId: string }> {
    return this.lock.run(code, () => this.undoExclusively(code, checkoutId));
  }

  private async undoExclusively(code: string, checkoutId: string): Promise<{ ok: true; playerId: string }> {
    const session = await this.prisma.session.findUnique({ where: { code } });
    if (!session) throw new NotFoundException({ code: 'SESSION_NOT_FOUND' });
    const row = await this.prisma.sessionCheckout.findUnique({ where: { id: checkoutId } });
    // Another session's receipt is not found rather than forbidden: it must not confirm it exists.
    if (!row || row.sessionId !== code) throw new NotFoundException({ code: 'CHECKOUT_NOT_FOUND' });
    if (row.undoneAt !== null) throw new ConflictException({ code: 'CHECKOUT_UNDONE' });
    if (session.endedAt !== null) throw new ConflictException({ code: 'SESSION_ENDED' });
    // Same arithmetic as the rest toggle, so coming back from a checkout queues like any other return.
    const gamesOffset = await this.sessions.rotationCreditForReturn(code, row.playerId);
    await this.prisma.$transaction(async (tx) => {
      const undone = await tx.sessionCheckout.updateMany({ where: { id: row.id, undoneAt: null }, data: { undoneAt: new Date() } });
      if (undone.count !== 1) throw new ConflictException({ code: 'CHECKOUT_UNDONE' });
      const roster = await tx.sessionRoster.updateMany({
        where: { sessionId: code, playerId: row.playerId },
        data: { active: true, gamesOffset, activatedAt: new Date() },
      });
      if (roster.count !== 1) throw new ConflictException({ code: 'ROSTER_STALE' });
    });
    return { ok: true, playerId: row.playerId };
  }
}
