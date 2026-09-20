import { Injectable, OnDestroy, signal } from '@angular/core';

/**
 * A single shared 1Hz clock for anything that needs to tick every second —
 * currently just the live court timer. One `setInterval` for the whole app
 * rather than one per court panel, so N active courts do not mean N drifting
 * intervals.
 *
 * Kept separate from the dashboard's own 30s `now` signal
 * (session-dashboard.ts) — that signal drives waiting-list minutes and
 * refetch polling, neither of which needs second resolution, and raising it
 * to 1Hz would recompute the whole waiting list every second for a display
 * that only changes once a minute.
 */
@Injectable({ providedIn: 'root' })
export class ClockService implements OnDestroy {
  readonly now = signal(Date.now());

  private readonly interval = setInterval(() => this.now.set(Date.now()), 1_000);

  ngOnDestroy(): void {
    clearInterval(this.interval);
  }
}
