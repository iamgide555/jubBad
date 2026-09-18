import { DestroyRef, Directive, ElementRef, inject } from '@angular/core';
import { animate } from 'motion';
import { DURATION, EASE_OUT, prefersReducedMotion } from './motion';

/**
 * FLIP reordering for a list whose items change order without leaving the
 * DOM entirely — the waiting queue re-sorting by wait time, the roster chips
 * re-sorting active-before-resting. Each child needs a stable
 * `[attr.data-flip-key]` (the player id, not the array index) so a
 * re-sorted item is recognised as "the same chip, new position" rather than
 * read as a brand-new one.
 *
 * First/Last/Invert/Play, run from a MutationObserver rather than an Angular
 * lifecycle hook: this container's children are reordered by the parent's
 * `@for` block on a signal change, which Angular applies as a DOM move
 * outside any hook this directive could otherwise reliably hang the "before"
 * measurement on.
 */
@Directive({
  selector: '[appFlipList]',
})
export class FlipListDirective {
  private readonly el = inject(ElementRef<HTMLElement>).nativeElement;
  private readonly rects = new Map<string, DOMRect>();
  private observer?: MutationObserver;

  constructor() {
    this.captureRects();

    this.observer = new MutationObserver(() => this.reconcile());
    this.observer.observe(this.el, { childList: true });

    inject(DestroyRef).onDestroy(() => this.observer?.disconnect());
  }

  private reconcile(): void {
    if (prefersReducedMotion()) {
      this.captureRects();
      return;
    }

    for (const child of Array.from(this.el.children) as HTMLElement[]) {
      const key = child.dataset['flipKey'];
      if (!key) continue;
      const before = this.rects.get(key);
      if (!before) continue; // New item — its own enter animation (appReveal) handles it.

      const after = child.getBoundingClientRect();
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;

      animate(
        child,
        { transform: [`translate(${dx}px, ${dy}px)`, 'translate(0, 0)'] },
        { duration: DURATION.slow, ease: EASE_OUT }
      );
    }

    this.captureRects();
  }

  private captureRects(): void {
    this.rects.clear();
    for (const child of Array.from(this.el.children) as HTMLElement[]) {
      const key = child.dataset['flipKey'];
      if (key) this.rects.set(key, child.getBoundingClientRect());
    }
  }
}
