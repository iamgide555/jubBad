import { Routes } from '@angular/router';
import { adminGuard } from './core/admin.guard';

/**
 * Two audiences share this app. The host's screens are guarded; the two
 * read-only screens a player might open are not, and their data endpoints are
 * @Public() on the server to match. If a route is added here, decide which of
 * those it is — the server decides the same question in
 * server/src/auth/auth.boundary.spec.ts, and the two must agree.
 */
export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./pages/login/login').then((m) => m.Login),
  },
  {
    path: '',
    canActivate: [adminGuard],
    loadComponent: () => import('./pages/landing/landing').then((m) => m.Landing),
  },
  {
    // Before 'g/:groupCode' so the deeper path wins the match.
    // Unguarded: a player's own stat card, read-only.
    path: 'g/:groupCode/p/:playerId',
    loadComponent: () =>
      import('./pages/player-profile/player-profile').then((m) => m.PlayerProfile),
  },
  {
    path: 'g/:groupCode',
    canActivate: [adminGuard],
    loadComponent: () => import('./pages/group-entry/group-entry').then((m) => m.GroupEntry),
  },
  {
    // Unguarded: the venue wall display, read-only.
    path: 's/:sessionCode/display',
    loadComponent: () =>
      import('./pages/session-display/session-display').then((m) => m.SessionDisplay),
  },
  {
    path: 's/:sessionCode',
    canActivate: [adminGuard],
    loadComponent: () =>
      import('./pages/session-dashboard/session-dashboard').then((m) => m.SessionDashboard),
  },
];
