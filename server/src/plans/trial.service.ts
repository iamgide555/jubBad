import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { effectivePlan } from './plan.js';
import { TRIAL_PLAN, trialRenewsAt } from './trial.js';

/**
 * The Host trial an account earns the first time it gets a LINE link. The rule
 * (one per LINE id, one per account, free accounts only) is in the sign-up design:
 * docs/superpowers/specs/2026-11-16-host-self-signup-design.md.
 */
@Injectable()
export class TrialService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Call inside the transaction that sets `User.lineUserId`. Gives the trial when
   * this LINE id and this account have not had one and the account is effectively
   * free; returns when it ends, or null when nothing was given.
   */
  async applyOnLink(
    tx: Prisma.TransactionClient,
    input: { userId: string; lineUserId: string },
    now: Date
  ): Promise<Date | null> {
    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: { role: true, plan: true, planRenewsAt: true },
    });
    if (!user || effectivePlan(user, now) !== 'free') return null;
    const used = await tx.trialRecord.findFirst({
      where: { OR: [{ lineUserId: input.lineUserId }, { userId: input.userId }] },
      select: { id: true },
    });
    if (used) return null;

    const until = trialRenewsAt(now);
    await tx.trialRecord.create({ data: { lineUserId: input.lineUserId, userId: input.userId } });
    await tx.user.update({ where: { id: input.userId }, data: { plan: TRIAL_PLAN, planRenewsAt: until } });
    return until;
  }

  /** The account has no LINE link, has never had a trial, and is effectively on free. */
  async availableForUser(userId: string, now: Date = new Date()): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, plan: true, planRenewsAt: true, lineUserId: true, trialRecord: { select: { id: true } } },
    });
    if (!user || user.lineUserId !== null || user.trialRecord !== null) return false;
    return effectivePlan(user, now) === 'free';
  }

  /** No trial has ever been given to this LINE account. */
  async availableForLine(lineUserId: string): Promise<boolean> {
    return (await this.prisma.trialRecord.findUnique({ where: { lineUserId }, select: { id: true } })) === null;
  }
}
