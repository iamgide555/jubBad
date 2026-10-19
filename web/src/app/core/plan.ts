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
