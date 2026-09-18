import { Directive, ElementRef, HostListener, inject } from '@angular/core';
import { animate } from 'motion';
import { PRESS_SPRING, prefersReducedMotion } from './motion';

/**
 * A real spring bounce-back for the small, frequently-tapped controls where
 * the CSS `button:active { transform: scale(0.97) }` in styles.css reads as
 * flat — chips, court-panel name-taps, waiting-queue picks. Presses in with
 * a slight overshoot past 1 before settling, rather than a linear return.
 *
 * Deliberately not applied to every `<button>`: the plain CSS press already
 * covers ordinary buttons, and doubling both up everywhere would make every
 * tap in the app bounce, drowning out the moments this is meant to punctuate.
 */
@Directive({
  selector: '[appPress]',
})
export class PressDirective {
  private readonly el = inject(ElementRef<HTMLElement>).nativeElement;

  @HostListener('pointerdown')
  onPress(): void {
    if (prefersReducedMotion()) return;
    animate(this.el, { scale: 0.94 }, PRESS_SPRING);
  }

  @HostListener('pointerup')
  @HostListener('pointercancel')
  @HostListener('pointerleave')
  onRelease(): void {
    if (prefersReducedMotion()) return;
    animate(this.el, { scale: [0.94, 1.03, 1] }, PRESS_SPRING);
  }
}
