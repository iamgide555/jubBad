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
