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
 *
 * The host carries `data-press` so styles.css can switch its own `:active`
 * scale off — two scales stacked on one tap fight each other.
 *
 * Only a press that actually started can release. A bare `pointerleave` (the
 * mouse just passing over) or the `pointerleave` that follows `pointerup` on
 * touch must not replay the bounce, or the control blinks without being
 * touched.
 */
@Directive({
  selector: '[appPress]',
  host: { 'data-press': '' },
})
export class PressDirective {
  private readonly el = inject(ElementRef<HTMLElement>).nativeElement;
  private pressed = false;

  @HostListener('pointerdown')
  onPress(): void {
    if (prefersReducedMotion()) return;
    this.pressed = true;
    this.play(0.94);
  }

  @HostListener('pointerup')
  onRelease(): void {
    if (!this.pressed) return;
    this.pressed = false;
    this.play([0.94, 1.03, 1]);
  }

  /** Pointer slid off or the gesture was taken over (scroll): settle back
   *  quietly, no overshoot, since the tap never completed. */
  @HostListener('pointercancel')
  @HostListener('pointerleave')
  onAbort(): void {
    if (!this.pressed) return;
    this.pressed = false;
    this.play(1);
  }

  /** The one place that touches the animation library, so a spec can watch it. */
  private play(scale: number | number[]): void {
    animate(this.el, { scale }, PRESS_SPRING);
  }
}
