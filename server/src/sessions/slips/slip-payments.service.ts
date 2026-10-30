import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PaymentCardService } from '../payment-card.service.js';
import { SessionLock } from '../session-lock.js';

/** One person's paid mark on the bill screen. */
export interface PaidRow {
  playerId: string;
  source: 'slip' | 'host';
  /** ISO time the mark was written. */
  at: string;
  /** A slip credited an amount that no longer matches the player's current bill row. The mark stays; the host decides. */
  amountChangedSince: boolean;
}

/**
 * Per-person paid state for one session: a `SessionPayment` row exists exactly while the person counts as paid.
 * Written by a matched slip or by the host's tick. Every write runs under the session lock, like the card's.
 */
@Injectable()
export class SlipPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cards: PaymentCardService,
    private readonly lock: SessionLock
  ) {}

  async getPaid(code: string): Promise<PaidRow[]> {
    const panel = await this.cards.panel(code);
    const current = new Map(panel.rows.map((r) => [r.playerId, r.amountSatang]));
    const stored = await this.prisma.sessionPayment.findMany({ where: { sessionId: code }, orderBy: { createdAt: 'asc' } });
    return stored.map((p) => ({
      playerId: p.playerId,
      source: p.source === 'slip' ? 'slip' : 'host',
      at: p.createdAt.toISOString(),
      amountChangedSince: p.amountSatang !== null && p.amountSatang !== current.get(p.playerId),
    }));
  }

  /** The host marks a person paid. Already paid (by a slip or an earlier tick) stays as it is. */
  tick(code: string, playerId: string): Promise<void> {
    return this.lock.run(code, async () => {
      const panel = await this.cards.panel(code);
      if (!panel.rows.some((r) => r.playerId === playerId)) throw new ConflictException({ code: 'PLAYER_NOT_ON_BILL' });
      await this.prisma.sessionPayment.upsert({
        where: { sessionId_playerId: { sessionId: code, playerId } },
        create: { sessionId: code, playerId, source: 'host' },
        update: {},
      });
    });
  }

  /** Removes the paid mark if there is one. The slip's reference is deliberately left alone by this task. */
  untick(code: string, playerId: string): Promise<void> {
    return this.lock.run(code, async () => {
      await this.cards.panel(code);
      await this.prisma.sessionPayment.deleteMany({ where: { sessionId: code, playerId } });
    });
  }
}
