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
  /** The renewal date of a paid plan that has run out; null otherwise. */
  lapsedAt: string | null;
  /** This group is past the cap of the owner's current plan: it cannot start a new session. */
  paused: boolean;
  /** Sessions the free 30-day window hides from the host's lists (0 on a paid plan). */
  archiveHidden: number;
}

/** What `GET /plans/me` returns: the signed-in user's own plan, group count and cap. */
export interface MyPlan {
  plan: Plan;
  renewsAt: string | null;
  lapsedAt: string | null;
  groupCount: number;
  /** Null for an admin, who has no cap. */
  groupLimit: number | null;
  /** An https contact link from server config, or null (the sheet then shows text only). */
  upgradeUrl: string | null;
}

const EXPIRY_WARNING_MS = 5 * 24 * 60 * 60 * 1000;

/** A paid plan whose renewal date is still ahead but within 5 days. */
export function expiresSoon(p: GroupPlan, now: Date): boolean {
  if (p.plan === 'free' || !p.renewsAt) return false;
  const left = new Date(p.renewsAt).getTime() - now.getTime();
  return left > 0 && left <= EXPIRY_WARNING_MS;
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
  return $localize`:@@plan.required:ฟีเจอร์นี้ใช้ได้ในแพ็ก⁠เกจโฮสต์`;
}

/** Maps the server's plan refusals (403 PLAN_REQUIRED / GROUP_LIMIT) to host-facing copy. */
export function planErrorMessage(err: unknown): string | null {
  if (!(err instanceof HttpErrorResponse) || err.status !== 403) return null;
  const body = err.error as { code?: unknown; limit?: unknown } | null;
  if (body?.code === 'PLAN_REQUIRED') return planRequiredMessage();
  if (body?.code === 'GROUP_LIMIT' && typeof body.limit === 'number') {
    const limit = body.limit;
    return $localize`:@@plan.groupLimit:แพ็ก⁠เกจของคุณสร้างได้ ${limit}:limit: ก๊วน`;
  }
  if (body?.code === 'GROUP_PAUSED' && typeof body.limit === 'number') return groupPausedMessage(body.limit);
  return null;
}

/** Groups one owner may run at once, per plan. Mirrors GROUP_LIMIT on the server. */
export function groupLimitFor(plan: Plan): number {
  return { free: 1, host: 3, club: 10 }[plan];
}

/** Why a group past the owner's cap cannot start a round. */
export function groupPausedMessage(limit: number): string {
  return $localize`:@@plan.groupPaused:ก๊วนนี้พักไว้ — แพ็ก⁠เกจของคุณเปิดรอบได้ ${limit}:limit: ก๊วน (ก๊วนที่เล่นล่าสุด)`;
}

/** Shown on group home and roster entry after a paid plan ran out. */
export function planLapsedNotice(date: string): string {
  return $localize`:@@plan.notice.lapsed:แพ็ก⁠เกจโฮสต์หมดเมื่อ ${date}:date: — รอบใหม่ใช้แบบฟรี`;
}

/** Shown within 5 days of a paid plan's renewal date. */
export function planExpiringNotice(date: string): string {
  return $localize`:@@plan.notice.expiring:แพ็ก⁠เกจโฮสต์หมด ${date}:date:`;
}

export function renewLabel(): string {
  return $localize`:@@plan.notice.renew:ต่ออายุ`;
}

export function seePlanLabel(): string {
  return $localize`:@@plan.lock.more:ดูแพ็ก⁠เกจ`;
}

/** The first line of the plan-lock under a session's mode toggle. */
export function modesLockHint(): string {
  return $localize`:@@plan.lock.modes:โหมดสูสีและตามระดับใช้ได้ในแพ็ก⁠เกจโฮสต์`;
}

/** The first line of the plan-lock under a court's own mode toggle, where only เลือกเอง is free. */
export function courtModesLockHint(): string {
  return $localize`:@@plan.lock.courtModes:การตั้งโหมดแยกคอร์ทใช้ได้ในแพ็ก⁠เกจโฮสต์`;
}

/** The first line of the plan-lock under a ระดับ court's มือล่าง/มือบน control. */
export function targetLockHint(): string {
  return $localize`:@@plan.lock.target:การเล็งมือล่าง/มือบนใช้ได้ในแพ็ก⁠เกจโฮสต์`;
}

/**
 * The first line of the plan-lock beside a group switch that is ON on a free plan: the stored
 * setting stays (so it can be turned off), but sessions snapshot it off at creation.
 */
export function onButInactiveLockHint(): string {
  return $localize`:@@plan.lock.onInactive:เปิดอยู่ แต่รอบใหม่จะไม่ใช้ในแพ็ก⁠เกจนี้`;
}

/**
 * A renewal instant is the end of a Bangkok day (UTC+7, no DST), so its Bangkok calendar date
 * is the one the admin typed, as `YYYY-MM-DD` (a date input's value). '' when there is none.
 */
export function bangkokDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(new Date(iso).getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** The same Bangkok calendar date for reading, as `dd/mm/yyyy`. '' when there is none. */
export function bangkokDisplayDate(iso: string | null): string {
  const ymd = bangkokDate(iso);
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y}`;
}

/** "until dd/mm/yyyy" beside a plan with a renewal date (group home, admin list). */
export function planUntil(iso: string): string {
  const date = bangkokDisplayDate(iso);
  return $localize`:@@plan.until:ถึง ${date}:date:`;
}
