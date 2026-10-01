import { Injectable } from '@nestjs/common';
import type { CheckoutModel } from '../../../engines/bill.ts';
import { PrismaService } from '../prisma/prisma.service.js';
import { loadBillSnapshot } from './bill-snapshot.js';
import { quoteCheckout, type CheckoutQuote } from './checkout-quote.js';

export type CheckoutPreviewResponse = Pick<
  CheckoutQuote,
  'playerId' | 'model' | 'amountSatang' | 'games' | 'breakdown' | 'snapshotHash'
>;

/**
 * Host-only early checkout (host feedback E). Owner-only by the global guards
 * (no @Public on its controller): receipts never reach display or public pages.
 */
@Injectable()
export class CheckoutService {
  constructor(private readonly prisma: PrismaService) {}

  /** Read-only: a quote changes nothing and reserves nothing. */
  async preview(code: string, playerId: string, model: CheckoutModel): Promise<CheckoutPreviewResponse> {
    const snapshot = await this.prisma.$transaction((tx) => loadBillSnapshot(tx, code));
    const q = quoteCheckout(snapshot, playerId, model);
    return { playerId: q.playerId, model: q.model, amountSatang: q.amountSatang, games: q.games, breakdown: q.breakdown, snapshotHash: q.snapshotHash };
  }
}
