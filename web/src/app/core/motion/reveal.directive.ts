import { Directive, ElementRef, inject, input } from '@angular/core';
import { prefersReducedMotion } from './motion';

/**
 * Stagger-on-enter for a route's first viewport: children rise 10px and
 * fade in, offset by `appRevealIndex * 45ms` so a list (roster chips, court
 * panels, the group list) reads as one wave rather than every row popping at
 * once.
 *
 * Pure CSS (`.reveal-in` + the `rise-in` keyframe in styles.css) rather than
 * a JS-driven tween: an earlier version used `afterNextRender()` plus
 * motion.dev's `animate()`, and that combination intermittently — not
 * always, which is what made it slow to pin down — raced the session
 * dashboard's own `httpResource` refetch cycle in tests, occasionally
 * tripping `HttpTestingController.verify()` on a test this directive has no
 * business affecting. `afterNextRender` hooks and Angular's zoneless CD
 * scheduler share a queue that a JS animation library doesn't participate
 * in cleanly; a plain CSS animation set once, synchronously, in the
 * constructor has no such hook to race.
 */
@Directive({
  selector: '[appReveal]',
})
export class RevealDirective {
  private readonly el = inject(ElementRef<HTMLElement>).nativeElement;

  /** Position in the list this element belongs to — drives the stagger. */
  readonly appReveal = input<number>(0);

  constructor() {
    if (prefersReducedMotion()) return;
    const delay = Math.min(this.appReveal(), 12) * 45;
    this.el.classList.add('reveal-in');
    this.el.style.animationDelay = `${delay}ms`;
  }
}
