import { Component, input } from '@angular/core';

/** The small, fixed vocabulary of glyphs this app actually needs — every
 *  bare-text control (copy, refresh, theme toggle, sun/moon) gets one of
 *  these instead of a symbol character, so weight and stroke stay
 *  consistent across the app rather than depending on the visitor's font. */
export type IconName =
  | 'feather'
  | 'sun'
  | 'moon'
  | 'system'
  | 'copy'
  | 'refresh'
  | 'link'
  | 'undo'
  | 'plus'
  | 'minus'
  | 'chevron';

/**
 * Inline SVG, not an icon font: a font swap can silently ship a missing
 * glyph as a box or blank; an inline `<path>` either renders or fails a
 * build. `strokeWidth` defaults to 2 so a 16px and a 48px use of the same
 * glyph (a toolbar icon vs. the login screen's hero mark) both read as one
 * family rather than the small one going illegibly thin.
 */
@Component({
  selector: 'app-icon',
  template: `
    <svg
      [attr.width]="size()"
      [attr.height]="size()"
      viewBox="0 0 24 24"
      fill="none"
      [attr.stroke]="'currentColor'"
      [attr.stroke-width]="strokeWidth()"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      @switch (name()) {
        @case ('feather') {
          <!-- The shuttle's feather crown: four tapered arcs fanning from a
               shared base. The one signature device, reused at every size
               from a 16px toolbar glyph to the login screen's 3D hero. -->
          <path d="M12 21V9" />
          <path d="M12 9C12 9 7 8 6 3C10.5 3.5 12 6.5 12 9Z" />
          <path d="M12 9C12 9 17 8 18 3C13.5 3.5 12 6.5 12 9Z" />
          <path d="M12 12C12 12 8.5 11.2 7.7 7.5C11 8 12 10.2 12 12Z" opacity="0.6" />
          <path d="M12 12C12 12 15.5 11.2 16.3 7.5C13 8 12 10.2 12 12Z" opacity="0.6" />
        }
        @case ('sun') {
          <circle cx="12" cy="12" r="4" />
          <path
            d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"
          />
        }
        @case ('moon') {
          <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" />
        }
        @case ('system') {
          <rect x="3" y="4" width="18" height="13" rx="2" />
          <path d="M8 21h8M12 17v4" />
        }
        @case ('copy') {
          <rect x="9" y="9" width="12" height="12" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        }
        @case ('refresh') {
          <path d="M21 12a9 9 0 1 1-3-6.7" />
          <path d="M21 3v6h-6" />
        }
        @case ('link') {
          <path d="M9 15 15 9" />
          <path d="M11 6l1-1a4 4 0 0 1 6 6l-1 1" />
          <path d="M13 18l-1 1a4 4 0 0 1-6-6l1-1" />
        }
        @case ('undo') {
          <path d="M3 10h9a5 5 0 0 1 0 10h-2" />
          <path d="M7 6 3 10l4 4" />
        }
        @case ('plus') {
          <path d="M12 5v14M5 12h14" />
        }
        @case ('minus') {
          <path d="M5 12h14" />
        }
        @case ('chevron') {
          <path d="M6 9l6 6 6-6" />
        }
      }
    </svg>
  `,
  host: {
    class: 'icon',
    '[class.feather-arc]': "name() === 'feather'",
    '[class.spin]': "name() === 'feather' && spin()",
  },
})
export class Icon {
  readonly name = input.required<IconName>();
  readonly size = input(20);
  readonly strokeWidth = input(2);
  /** Loading state for the feather mark — see `.feather-arc.spin` in
   *  styles.css for the keyframe. */
  readonly spin = input(false);
}
