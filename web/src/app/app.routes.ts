import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./pages/landing/landing').then((m) => m.Landing),
  },
  {
    // Before 'g/:groupCode' so the deeper path wins the match.
    path: 'g/:groupCode/p/:playerId',
    loadComponent: () =>
      import('./pages/player-profile/player-profile').then((m) => m.PlayerProfile),
  },
  {
    path: 'g/:groupCode',
    loadComponent: () =>
      import('./pages/group-entry/group-entry').then((m) => m.GroupEntry),
  },
  {
    path: 's/:sessionCode/display',
    loadComponent: () =>
      import('./pages/session-display/session-display').then(
        (m) => m.SessionDisplay
      ),
  },
  {
    path: 's/:sessionCode',
    loadComponent: () =>
      import('./pages/session-dashboard/session-dashboard').then(
        (m) => m.SessionDashboard
      ),
  },
];
