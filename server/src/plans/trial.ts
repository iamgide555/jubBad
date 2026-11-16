// The Host-plan trial a host earns by linking their LINE account for the first
// time. Rule and reasoning: docs/superpowers/specs/2026-11-16-host-self-signup-design.md.

export const TRIAL_PLAN = 'host' as const;
export const TRIAL_DAYS = 30;

const BANGKOK_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

/**
 * When a trial started at `now` runs out: the last millisecond of the Bangkok
 * calendar day `TRIAL_DAYS` days later, the same end-of-day form the admin plan
 * form stores, so a trial that ends on the 16th works all of the 16th.
 */
export function trialRenewsAt(now: Date): Date {
  const bangkokDay = new Date(now.getTime() + BANGKOK_OFFSET_MS).toISOString().slice(0, 10);
  const startOfDay = new Date(`${bangkokDay}T00:00:00.000+07:00`).getTime();
  return new Date(startOfDay + (TRIAL_DAYS + 1) * DAY_MS - 1);
}
