import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

/**
 * Gate for the host's screens.
 *
 * This is a convenience, not a security boundary — it decides which page to
 * render, and a determined visitor can bypass it by editing the bundle. The
 * actual boundary is the server's AdminGuard, which every one of these screens
 * hits for its data and which will refuse. Anything protected here must also be
 * protected there; see server/src/auth/auth.boundary.spec.ts.
 *
 * Deliberately not applied to the venue display or a player's stat card, whose
 * data endpoints are @Public().
 */
export const adminGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  // Asked fresh each time rather than reading the cached signal: the cookie can
  // expire or be revoked mid-visit, and a stale flag would leave the host on a
  // screen whose every request 401s.
  if (await auth.check()) return true;

  return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
};
