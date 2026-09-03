import { Routes } from '@angular/router';

export const routes: Routes = [
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
