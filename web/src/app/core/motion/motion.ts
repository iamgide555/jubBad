/**
 * The one physical vocabulary every motion directive in this app draws from
 * — durations and easings mirror the CSS custom properties in styles.css
 * (`--duration-*`, `--ease-*`) so a JS-driven animation (motion.dev) and a
 * CSS-driven one (a plain `transition`) never feel like two different apps.
 *
 * Nothing here imports a component. Directives import from this file;
 * components never import 'motion' directly, so the whole app has exactly
 * one place that knows the animation library's API.
 */
import type { AnimationOptions } from 'motion';

export const DURATION = {
  fast: 0.14,
  base: 0.22,
  slow: 0.42,
} as const;

/** Matches --ease-out in styles.css: a quick decelerate, no overshoot. */
export const EASE_OUT: AnimationOptions['ease'] = [0.16, 1, 0.3, 1];

/** A snappier settle for small, frequently-tapped controls (chips, buttons). */
export const PRESS_SPRING: AnimationOptions = { type: 'spring', stiffness: 520, damping: 26, mass: 0.5 };

/** True once per check — callers should re-check rather than cache this,
 *  since a visitor can change the OS setting while the app is open. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  );
}
