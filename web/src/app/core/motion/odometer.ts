import { Component, input } from '@angular/core';

/**
 * A tabular-numeral wrapper for anything that is data changing in place —
 * games played, wait minutes, a live score, a stat-row value. Renders as
 * plain text (see `.tabular` in styles.css); every use of it drops in
 * exactly where `{{ value }}` used to sit, with no layout change.
 *
 * Deliberately does no animation of its own. An earlier version tweened
 * through every intermediate integer on a `requestAnimationFrame` loop
 * (later trimmed to a single `setTimeout`-driven pulse); both wrote this
 * component's signal from outside Angular's normal render cycle, and both
 * occasionally landed inside the exact async window
 * `session-dashboard.spec.ts` hand-choreographs around `httpResource`
 * refetches, intermittently tripping `HttpTestingController.verify()` on an
 * unrelated test. A value that changes in place is exactly what CSS
 * `transition`/`@starting-style` is for; this component stays a plain,
 * inert render target so that motion — if a later pass wants it back — can
 * be added at the call site's own risk instead of unconditionally, for
 * every numeral in the app, from here.
 */
@Component({
  selector: 'app-odometer',
  template: `{{ value() }}`,
  host: { class: 'tabular' },
})
export class Odometer {
  readonly value = input.required<number>();
}
