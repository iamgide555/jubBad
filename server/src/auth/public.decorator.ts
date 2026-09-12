import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';

/**
 * Opts a route out of AuthGuard.
 *
 * The guard is registered globally, so a route is closed unless it says
 * otherwise. That direction is deliberate: with an opt-in guard, every route
 * added later is open until someone remembers to protect it, and the failure is
 * silent. Here forgetting means a 401 in front of you, not a hole behind you.
 *
 * A handful of routes carry this — the venue display and the player stat
 * card, both read-only. See auth.boundary.spec.ts, which pins the exact list.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);
