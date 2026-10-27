// Pure plan rules: which plan a group owner is effectively on right now.
// Tiers and what each unlocks: docs/2026-10-06-pricing-tiers.md.

export const PLANS = ['free', 'host', 'club'] as const;
export type Plan = (typeof PLANS)[number];
export type PaidPlan = Exclude<Plan, 'free'>;

export interface PlanOwner {
  role: string;
  plan: string;
  planRenewsAt: Date | null;
}

/** Groups one owner may have. Callers with role admin have no limit. */
export const GROUP_LIMIT: Record<Plan, number> = { free: 1, host: 3, club: 10 };

/** Free plan sees only sessions from the last this-many days in the archive. */
export const FREE_ARCHIVE_DAYS = 30;

export function effectivePlan(owner: PlanOwner | null, now: Date): Plan {
  // An ownerless group is club: production never has one (AuthBootstrapService
  // fills ownerId), and ownerless fixtures in existing specs must stay ungated.
  if (!owner) return 'club';
  // An admin owner is club whatever the column says.
  if (owner.role === 'admin') return 'club';
  const plan = PLANS.find((p) => p === owner.plan);
  // An unknown plan string is read as free rather than trusted.
  if (!plan || plan === 'free') return 'free';
  // A paid plan lapses once now is past the renewal date; null never lapses.
  if (owner.planRenewsAt && now.getTime() > owner.planRenewsAt.getTime()) {
    return 'free';
  }
  return plan;
}

export function planAtLeast(plan: Plan, required: PaidPlan): boolean {
  return PLANS.indexOf(plan) >= PLANS.indexOf(required);
}

/**
 * Codes of an owner's groups, most-usable first: a group with a night in
 * progress (`live`), then newest session, then newest group, then code (so the
 * order is total). The first GROUP_LIMIT[plan] stay usable; the rest are
 * paused. Re-read every time, never stored, so deleting a group unpauses the
 * next one at once.
 */
export function rankForCap(
  groups: { code: string; createdAt: Date; lastSessionAt: Date | null; live?: boolean }[]
): string[] {
  return [...groups]
    .sort((a, b) => {
      if (Boolean(a.live) !== Boolean(b.live)) return a.live ? -1 : 1;
      const sessions = (b.lastSessionAt?.getTime() ?? -Infinity) - (a.lastSessionAt?.getTime() ?? -Infinity);
      if (sessions !== 0 && !Number.isNaN(sessions)) return sessions;
      const created = b.createdAt.getTime() - a.createdAt.getTime();
      return created !== 0 ? created : a.code.localeCompare(b.code);
    })
    .map((g) => g.code);
}

/** The renewal date of a paid plan that has run out; null for anything else. */
export function lapsedAt(owner: PlanOwner | null, now: Date): Date | null {
  if (!owner || owner.role === 'admin') return null;
  if (owner.plan !== 'host' && owner.plan !== 'club') return null;
  if (!owner.planRenewsAt || now.getTime() <= owner.planRenewsAt.getTime()) return null;
  return owner.planRenewsAt;
}

/** The upgrade contact link, only when it is a well-formed https URL. */
export function upgradeContactUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}
