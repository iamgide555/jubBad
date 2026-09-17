import type { CanDeactivateFn } from '@angular/router';

export interface CanComponentDeactivate {
  canDeactivate(): boolean;
}

/**
 * Generic across any component with unsaved-edit state, not player-roster-
 * specific — a component opts in by implementing canDeactivate() and listing
 * this guard on its route.
 */
export const canDeactivateGuard: CanDeactivateFn<CanComponentDeactivate> = (component) =>
  component.canDeactivate();
