import { HttpErrorResponse } from '@angular/common/http';

/** A group owner's plan. Set by an admin; the server resolves what it allows. */
export type Plan = 'free' | 'host' | 'club';

export const PLANS: readonly Plan[] = ['free', 'host', 'club'];

/** The display name of a plan — never a price; the app shows none. */
export function planLabel(plan: Plan): string {
  switch (plan) {
    case 'free':
      return $localize`:@@plan.free:ฟรี`;
    case 'host':
      return $localize`:@@plan.host:โฮสต์`;
    case 'club':
      return $localize`:@@plan.club:ก๊วนใหญ่`;
  }
}

/** What `GET /groups/:code/plan` returns: the group OWNER's effective plan. */
export interface GroupPlan {
  plan: Plan;
  /** The raw stored date. Not "the plan is active" — the server already
   *  resolved a lapse into `plan`. */
  renewsAt: string | null;
}

/**
 * Whether paid controls should look available. `null` (not loaded, or the load
 * failed) counts as paid: a hiccup must never lock a host out courtside, and
 * the server still refuses what the plan does not allow.
 */
export function isPaid(plan: Plan | null): boolean {
  return plan !== 'free';
}

/** The copy for a 403 PLAN_REQUIRED refusal. */
export function planRequiredMessage(): string {
  return $localize`:@@plan.required:ฟีเจอร์นี้ใช้ได้ในแพ็กเกจโฮสต์ ติดต่อผู้ดูแลเพื่ออัปเกรด`;
}

/** Maps the server's plan refusals (403 PLAN_REQUIRED / GROUP_LIMIT) to host-facing copy. */
export function planErrorMessage(err: unknown): string | null {
  if (!(err instanceof HttpErrorResponse) || err.status !== 403) return null;
  const body = err.error as { code?: unknown; limit?: unknown } | null;
  if (body?.code === 'PLAN_REQUIRED') return planRequiredMessage();
  if (body?.code === 'GROUP_LIMIT' && typeof body.limit === 'number') {
    const limit = body.limit;
    return $localize`:@@plan.groupLimit:แพ็กเกจของคุณสร้างก๊วนได้สูงสุด ${limit}:limit: ก๊วน`;
  }
  return null;
}
