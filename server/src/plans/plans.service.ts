import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { effectivePlan, GROUP_LIMIT, planAtLeast, type PaidPlan, type Plan, type PlanOwner } from './plan.js';

const OWNER_SELECT = { role: true, plan: true, planRenewsAt: true } as const;

/**
 * Resolves a group's plan from its owner at read time. A missing group or
 * session resolves to club so the caller's own 404 still decides, and an
 * ownerless group is club (see effectivePlan).
 */
@Injectable()
export class PlansService {
  constructor(private readonly prisma: PrismaService) {}

  async planForGroup(groupCode: string, now: Date = new Date()): Promise<Plan> {
    return effectivePlan(await this.ownerOfGroup(groupCode), now);
  }

  async planForSession(sessionCode: string, now: Date = new Date()): Promise<Plan> {
    const session = await this.prisma.session.findUnique({
      where: { code: sessionCode },
      select: { group: { select: { owner: { select: OWNER_SELECT } } } },
    });
    return effectivePlan(session?.group.owner ?? null, now);
  }

  /** The owner's plan and renewal date, for the plan endpoint. Null when the group does not exist. */
  async describeGroup(
    groupCode: string,
    now: Date = new Date()
  ): Promise<{ plan: Plan; renewsAt: string | null } | null> {
    const group = await this.prisma.group.findUnique({
      where: { code: groupCode },
      select: { owner: { select: OWNER_SELECT } },
    });
    if (!group) return null;
    return {
      plan: effectivePlan(group.owner, now),
      renewsAt: group.owner?.planRenewsAt?.toISOString() ?? null,
    };
  }

  async requireGroupPlan(groupCode: string, required: PaidPlan): Promise<void> {
    this.assertAtLeast(await this.planForGroup(groupCode), required);
  }

  async requireSessionPlan(sessionCode: string, required: PaidPlan): Promise<void> {
    this.assertAtLeast(await this.planForSession(sessionCode), required);
  }

  /**
   * Refuses a caller who already owns as many groups as their plan allows.
   * Reads the caller's own plan (not a group owner's); an admin has no limit.
   *
   * Two concurrent creates can both pass the count and exceed the limit by one.
   * That is accepted: billing is manual and this is not a security boundary.
   */
  async assertCanCreateGroup(caller: { id: string; role: string }, now: Date = new Date()): Promise<void> {
    if (caller.role === 'admin') return;
    const user = await this.prisma.user.findUnique({ where: { id: caller.id }, select: OWNER_SELECT });
    const limit = GROUP_LIMIT[effectivePlan(user, now)];
    const owned = await this.prisma.group.count({ where: { ownerId: caller.id } });
    if (owned >= limit) throw new ForbiddenException({ code: 'GROUP_LIMIT', limit });
  }

  private assertAtLeast(plan: Plan, required: PaidPlan): void {
    if (!planAtLeast(plan, required)) {
      throw new ForbiddenException({ code: 'PLAN_REQUIRED', requiredPlan: required });
    }
  }

  private async ownerOfGroup(groupCode: string): Promise<PlanOwner | null> {
    const group = await this.prisma.group.findUnique({
      where: { code: groupCode },
      select: { owner: { select: OWNER_SELECT } },
    });
    return group?.owner ?? null;
  }
}
