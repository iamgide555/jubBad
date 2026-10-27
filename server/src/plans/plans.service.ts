import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  effectivePlan,
  FREE_ARCHIVE_DAYS,
  GROUP_LIMIT,
  lapsedAt,
  planAtLeast,
  rankForCap,
  upgradeContactUrl,
  type PaidPlan,
  type Plan,
  type PlanOwner,
} from './plan.js';

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

  /** A user's own plan, e.g. a host acting through LINE rather than through a group. A missing user resolves to club, like a missing group. */
  async planForUser(userId: string, now: Date = new Date()): Promise<Plan> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: OWNER_SELECT });
    return effectivePlan(user, now);
  }

  async planForSession(sessionCode: string, now: Date = new Date()): Promise<Plan> {
    const session = await this.prisma.session.findUnique({
      where: { code: sessionCode },
      select: { group: { select: { owner: { select: OWNER_SELECT } } } },
    });
    return effectivePlan(session?.group.owner ?? null, now);
  }

  /**
   * The owner's plan facts for the plan endpoint. Null when the group does not exist.
   * `paused`: this group is past the cap of a plan the owner is on now.
   * `archiveHidden`: sessions the free 30-day window hides from the host's lists.
   */
  async describeGroup(
    groupCode: string,
    now: Date = new Date()
  ): Promise<{
    plan: Plan;
    renewsAt: string | null;
    lapsedAt: string | null;
    paused: boolean;
    archiveHidden: number;
  } | null> {
    const group = await this.prisma.group.findUnique({
      where: { code: groupCode },
      select: { ownerId: true, owner: { select: OWNER_SELECT } },
    });
    if (!group) return null;
    const plan = effectivePlan(group.owner, now);
    const archiveHidden =
      plan === 'free'
        ? await this.prisma.session.count({
            where: {
              groupId: groupCode,
              createdAt: { lt: new Date(now.getTime() - FREE_ARCHIVE_DAYS * 24 * 60 * 60 * 1000) },
            },
          })
        : 0;
    return {
      plan,
      renewsAt: group.owner?.planRenewsAt?.toISOString() ?? null,
      lapsedAt: lapsedAt(group.owner, now)?.toISOString() ?? null,
      paused: group.ownerId ? (await this.pausedGroupCodes(group.ownerId, now)).has(groupCode) : false,
      archiveHidden,
    };
  }

  /** The signed-in user's own plan, group count and cap, for the landing page and the upgrade sheet. */
  async describeCaller(caller: { id: string; role: string }, now: Date = new Date()) {
    const user = await this.prisma.user.findUnique({ where: { id: caller.id }, select: OWNER_SELECT });
    const plan = effectivePlan(user, now);
    return {
      plan,
      renewsAt: user?.planRenewsAt?.toISOString() ?? null,
      lapsedAt: lapsedAt(user, now)?.toISOString() ?? null,
      groupCount: await this.prisma.group.count({ where: { ownerId: caller.id } }),
      groupLimit: caller.role === 'admin' ? null : GROUP_LIMIT[plan],
      upgradeUrl: upgradeContactUrl(process.env.UPGRADE_CONTACT_URL),
    };
  }

  /**
   * Groups past the cap of the owner's current plan, ranked by night in progress,
   * then newest session, then newest group (see rankForCap). Read fresh each time: nothing is stored,
   * so a delete or a renewal changes the answer immediately. An admin owner or
   * an unknown owner pauses nothing.
   */
  async pausedGroupCodes(ownerId: string, now: Date = new Date()): Promise<Set<string>> {
    const owner = await this.prisma.user.findUnique({ where: { id: ownerId }, select: OWNER_SELECT });
    if (!owner || owner.role === 'admin') return new Set();
    const groups = await this.prisma.group.findMany({
      where: { ownerId },
      select: {
        code: true,
        createdAt: true,
        sessions: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
        _count: { select: { sessions: { where: { endedAt: null } } } },
      },
    });
    const ranked = rankForCap(
      groups.map((g) => ({
        code: g.code,
        createdAt: g.createdAt,
        lastSessionAt: g.sessions[0]?.createdAt ?? null,
        live: g._count.sessions > 0,
      }))
    );
    return new Set(ranked.slice(GROUP_LIMIT[effectivePlan(owner, now)]));
  }

  async isGroupPaused(groupCode: string, now: Date = new Date()): Promise<boolean> {
    const group = await this.prisma.group.findUnique({ where: { code: groupCode }, select: { ownerId: true } });
    if (!group?.ownerId) return false;
    return (await this.pausedGroupCodes(group.ownerId, now)).has(groupCode);
  }

  /**
   * The owner's plan at the moment the session was created, the same instant the
   * shuttle-tools and bill snapshots use, so a plan that lapses mid-night changes
   * nothing for a session already running. A missing session reads as club.
   */
  async planAtSessionCreation(sessionCode: string): Promise<Plan> {
    const session = await this.prisma.session.findUnique({
      where: { code: sessionCode },
      select: { createdAt: true, group: { select: { owner: { select: OWNER_SELECT } } } },
    });
    return session ? effectivePlan(session.group.owner, session.createdAt) : 'club';
  }

  async requireGroupPlan(groupCode: string, required: PaidPlan): Promise<void> {
    this.assertAtLeast(await this.planForGroup(groupCode), required);
  }

  async requireUserPlan(userId: string, required: PaidPlan): Promise<void> {
    this.assertAtLeast(await this.planForUser(userId), required);
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
