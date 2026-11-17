import { Component, input } from '@angular/core';
import { Icon } from '../icon/icon';

/**
 * One calm block for every "waiting or it did not work" moment of a page that opens inside LINE: the shuttle mark
 * spins only while something is happening, the message and any retry button are projected in. A single place for
 * these states keeps them from reading as separate, unfinished screens.
 */
@Component({
  selector: 'app-status-block',
  imports: [Icon],
  template: `
    <div class="status" data-status role="status">
      @if (busy()) {
        <app-icon name="feather" [size]="22" [spin]="true" />
      }
      <div class="status-body"><ng-content /></div>
    </div>
  `,
  styles: `
    .status {
      display: flex;
      align-items: flex-start;
      gap: var(--space-2);
      padding: var(--space-3);
      background: var(--ground-sunk);
      border-radius: var(--radius-lg);
      color: var(--ink);
    }
    .status app-icon {
      color: var(--court-ink);
      margin-top: 0.15rem;
    }
    .status-body {
      display: grid;
      gap: var(--space-2);
      flex: 1;
      min-width: 0;
    }
    .status-body ::ng-deep p {
      margin: 0;
    }
  `,
})
export class StatusBlock {
  /** Something is in progress: show the spinning mark. */
  readonly busy = input(false);
}
