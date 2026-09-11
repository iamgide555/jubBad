---
name: JubBad
description: A courtside chalkboard draw sheet for running badminton club sessions — dark board, taped paper cards, one marker-red accent.
colors:
  court: "#52703f"
  court-dark: "#3b5230"
  court-line: "#3a3628"
  court-hover: "#2c2a20"
  line-surface: "#242219"
  surface: "#f3ead6"
  rule: "#cbbd98"
  court-wash: "rgba(226, 87, 44, 0.16)"
  ink: "#efe6d0"
  ink-soft: "#a89f89"
  ink-on-paper: "#2a2418"
  ink-on-paper-soft: "#6b6250"
  ink-on-court: "#efe6d0"
  ink-on-court-soft: "#cdbfa0"
  accent: "#e2572c"
  accent-dark: "#b23c1e"
  waiting: "#8f8571"
  warn: "#8a2f22"
  warn-wash: "#f5e3de"
  accent-ink: "#ec6a3f"
  court-ink: "#7a9a6a"
  tape: "#d8cdb0"
typography:
  display:
    fontFamily: "'Permanent Marker', 'Noto Sans Thai', cursive, sans-serif"
    fontSize: "clamp(1.75rem, 7vw, 2.25rem)"
    fontWeight: 400
    lineHeight: 1.25
    letterSpacing: "0"
  headline:
    fontFamily: "'Permanent Marker', 'Noto Sans Thai', cursive, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 400
    lineHeight: 1.25
  title:
    fontFamily: "'Permanent Marker', 'Noto Sans Thai', cursive, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 400
    lineHeight: 1.25
  body:
    fontFamily: "'Work Sans', 'Noto Sans Thai', system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "'Work Sans', 'Noto Sans Thai', system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: 1.6
rounded:
  sm: "2px"
  pill: "999px"
spacing:
  "0": "0.25rem"
  "1": "0.5rem"
  "2": "0.75rem"
  "3": "1.5rem"
  "4": "2rem"
  "5": "3rem"
components:
  button-primary:
    backgroundColor: "{colors.court}"
    textColor: "{colors.ink-on-court}"
    rounded: "{rounded.sm}"
    padding: "0.65rem 1.1rem"
  button-primary-hover:
    backgroundColor: "{colors.court-dark}"
  button-danger:
    backgroundColor: "{colors.warn}"
    textColor: "#fbeee7"
    rounded: "{rounded.sm}"
    padding: "0.65rem 1.1rem"
  chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-on-paper}"
    rounded: "{rounded.sm}"
    padding: "0.35rem 0.8rem"
    typography: "{typography.label}"
---

# Design System: JubBad

## Overview

**Creative North Star: "The Draw Sheet"**

JubBad's host-facing world is a courtside chalkboard: a dark chalkboard ground carries the page itself, and warm cream paper is reserved for anything that reads as a card, a chip, an input, or a control someone would actually mark up — court panels, roster tags, form fields. Panels are torn-paper cards taped at a slight tilt rather than clean SaaS-dashboard tiles; headings are set in a genuine marker-stroke hand; a single reserved marker-red carries every "needs the host's attention" signal, and nothing else borrows it. The system explicitly refuses the clean-card software-console default in favor of something that looks handled between rounds, not assembled.

The public/read surfaces (session display, session summary, player profile) inherit the same board-and-paper world but shift register: the wall-mounted session display goes one shade darker still and scales in `vmin` for legibility across a room, dropping the tape/shadow paper-card detail since it is invisible at that distance and using plain bordered boxes instead.

**Key Characteristics:**
- Dark chalkboard ground (`--line-surface`, radial `#2c2a20`→`#242219`→`#1a1811`) on every host and display surface; cream paper (`--surface`) only for card/chip/input surfaces.
- One reserved marker-red accent (`--accent`) for "needs the host's attention now"; ordinary navigation uses a separate green (`--court-ink`), never accent.
- Two ink pairs (board ink vs. paper ink) plus a brighter "-ink" variant set for small text directly on the board, rescoped back to paper-safe values inside any paper container.
- Hand-drawn borders (shared SVG `#rough-edge` filter) on every ghost button and segmented toggle, added in the fix round after review flagged the toolbar as razor-straight — now load-bearing across all 7 surfaces.
- Torn-paper cards (tilt, tape strip, soft blurred lift shadow) for court panels and notice/banner blocks; square 2px corners throughout, no pills except the reserved `--radius-pill` for toggle-adjacent tags.

## Colors

Restrained: one reserved marker-red accent, one confirm-green for the primary/go action, and a two-ground ink system (chalk-on-board vs. ink-on-paper) that does almost all the remaining work.

### Primary
- **Marker Red** (`#e2572c`, `--accent`): reserved for "the host needs to act on this right now" — a pending court's glow, `.review-tag.new`/`.fuzzy`, `.danger-zone`'s dashed border. A darker variant (`#b23c1e`, `--accent-dark`) fills small badges (`.live-tag`) where the base hue falls short of 4.5:1 at that size. A brighter text-only variant (`#ec6a3f`, `--accent-ink`) is used only where accent-hued text sits directly on the dark board and must clear 4.5:1; it is rescoped back down to `--warn` inside any paper-surfaced container.

### Secondary
- **Confirm Green** (`#52703f`, `--court`, with `--court-dark` `#3b5230` on hover): the default filled-button color and the "live/active" court-panel glow — the primary/go action everywhere. A brighter text-only variant (`#7a9a6a`, `--court-ink`) is the app's actual link/navigation color (the `a` rule), deliberately distinct from accent so wayfinding and "act now" never share a hue.

### Neutral
- **Board** (`#242219`→`#1a1811`, `--line-surface`): the dark chalkboard ground of every host page and the base of `.page-dark` (`#14130d`, session display, one shade darker).
- **Paper** (`#f3ead6`, `--surface`): cream ground for court panels, chips, inputs, notice blocks, the ended-session banner.
- **Chalk Ink** (`#efe6d0`, `--ink`; soft `#a89f89`, `--ink-soft`): text sitting directly on the dark board.
- **Paper Ink** (`#2a2418`, `--ink-on-paper`; soft `#6b6250`, `--ink-on-paper-soft`): text sitting on a paper card — rescoped in via custom-property overrides inside `.court-panel`, `.notice-block`, `.ended-banner`, `.remove-confirm`.
- **Court Ink** (`#efe6d0`, `--ink-on-court`; soft `#cdbfa0`, `--ink-on-court-soft`): light text for filled buttons and `.page-dark` surfaces.
- **Rule** (`#cbbd98`, `--rule`): input borders and paper-side dividers; `--court-line` (`#3a3628`) is the board-side dashed-divider equivalent.
- **Warn** (`#8a2f22`, `--warn`, wash `#f5e3de`): irreversible actions (`button.danger`) and error text on paper — a deliberately different hue from accent so "act now" and "this destroys something" never collide.
- **Tape** (`#d8cdb0`, `--tape`): the decorative masking-tape strip on every torn-paper card; never carries meaning.

### Named Rules
**The Two-Ground Ink Rule.** Every screen has two grounds — the dark board and cream paper — and each has its own ink pair (`--ink`/`--ink-soft` for board, `--ink-on-paper`/`--ink-on-paper-soft` for paper). Swapping them is the single easiest way to make text vanish in this system; any new paper-surfaced container must rescope `--ink`, `--ink-soft`, and `--error-ink` via custom-property overrides, following `.court-panel`/`.notice-block`/`.ended-banner`/`.remove-confirm`.

**The One Red Rule.** `--accent` means "the host must act on this now" and only that — never ordinary navigation (that's `--court-ink`) and never the primary/confirm action (that's `--court`). Diluting it into a general-purpose highlight removes the one signal the host actually needs at a glance.

## Typography

**Display Font:** Permanent Marker (with Noto Sans Thai, cursive, sans-serif fallback)
**Body Font:** Work Sans (with Noto Sans Thai, system-ui, sans-serif fallback)

**Character:** A hand-marked heading face paired with a plain, legible workhorse for everything read up close — the marker hand carries headings and court/heading labels only; a whole paragraph in it would read as costume, not handwriting.

### Hierarchy
- **Display/Headline** (400, `--text-3xl`/`--text-2xl`, 1.25 line-height): h1/h2, Permanent Marker. The one marker-hand moment per screen (e.g. the dashboard's `.board-head h1`, tilted −0.6deg).
- **Title** (400, `--text-xl`/`--text-lg`, 1.25): h3/h4, Permanent Marker — court-panel headings, section titles.
- **Body** (400, `1rem`, 1.6 line-height): Work Sans/Noto Sans Thai; 1.6 rather than 1.5 because Thai stacks tone marks above and below the baseline.
- **Label** (600, `--text-sm`, 1.6): `.label`, form labels — never uppercase/tracked-out, since Thai has no case and tracked capitals only style the Latin half of a bilingual UI.

### Named Rules
**The Digit Fallback Rule.** Permanent Marker has no digit glyphs, so any numeral set in it silently falls back through the stack to Noto Sans Thai, which under `lang="th"` renders Thai numeral forms (๑๒๓) instead of Arabic digits. Every heading or stat that mixes a Thai/marker label with a raw number wraps the number in its own span forced to `--font-text` — see `.court-num`, `.board-date`, `.review-index`, `.court-number` (session display) as the canonical instances. Any new heading containing a number must follow this pattern, not just the four places already fixed.

## Layout

A single-column phone-first shell (`.page`, max-width 32rem) that widens on tablet: `.page-wide` steps to 56rem at ≥48rem and 68rem at ≥64rem (iPad landscape, 1024px, is the anchor device). `.page-dark` (session display) drops the max-width entirely and uses full-bleed `vmin`-scaled type since it is read from across a room, not held in a hand. Spacing runs a 4px-rhythm scale (`--space-0` 4px through `--space-5` 48px, i.e. `.25rem`–`3rem`) unchanged by the redesign. Court panels grid at 1-up (phone), 2-up (≥48rem), 3-up (≥64rem), with an even-2 fallback when exactly 4 panels would otherwise leave one alone in a row of 3.

## Elevation & Depth

Hybrid: the dark board and its buttons are flat, but every torn-paper element (court panels, notice blocks, the ended-session banner, chips) lifts off the board with a soft, blurred, offset shadow — never a hard or zero-blur shadow, which would read as a ruled line rather than something physically resting on the board.

### Shadow Vocabulary
- **Panel lift** (`box-shadow: 0 10px 22px -10px rgba(0,0,0,0.55), 0 2px 0 rgba(0,0,0,0.12)`): court panels and the ended-session banner at rest.
- **Panel state glow** (`box-shadow: 0 0 0 2px var(--accent|--court), 0 10px 22px -10px rgba(0,0,0,0.55)`): ring added around the same lift shadow — accent for pending, court-green for active/live.
- **Chip lift** (`box-shadow: 0 2px 5px -1px rgba(0,0,0,0.45)`): the small paper-tag chip.
- **Notice lift** (`box-shadow: 0 6px 14px -8px rgba(0,0,0,0.5)`): notice blocks (group entry).

### Named Rules
**The Soft-Lift-Only Rule.** Any shadow in this system is a soft, blurred, offset lift signaling a paper object resting on the board — never a hard-edged or zero-blur shadow, which does not belong to this world's paper-and-chalk material logic.

## Shapes

Square corners throughout (`--radius`, 2px) — paper does not round its own corners any more than a chalk court line does. `--radius-pill` (999px) exists only for controls that must read as a capsule rather than a cut card (the `.live-tag` badge, `.review-tag.fuzzy`); it is the exception, not a parallel default. Hand-drawn borders (never the element's own straight `border`, which stays `none`) are drawn via a `::before` pseudo-element run through the shared SVG `#rough-edge` filter (`feTurbulence` + `feDisplacementMap`, defined once in `index.html`) on `button.ghost` and every `.scope-toggle button` — a subtly wobbled hand-marked line rather than a machine-ruled one, while the label text itself stays untouched and crisp.

## Components

### Buttons
- **Shape:** 2px corners (`--radius`), 44px minimum tap height (`--tap`) on every variant.
- **Primary (default `<button>`):** confirm-green fill (`--court`, `#52703f`), `--ink-on-court` text, darkens to `--court-dark` on hover (hover-capable pointers only), `scale(0.98)` on active.
- **Ghost (`button.ghost`):** transparent fill, chalk ink text, no real border — border is drawn by the `::before` rough-edge filter in `--ink-soft`, brightening to `--ink` on hover with a subtle `--court-hover` background wash.
- **Danger (`button.danger`):** filled `--warn` (`#8a2f22`), `#fbeee7` text, darkens to `#6e2419` on hover — a deliberately different, deeper red from `--accent` so "irreversible" never shares a hue with "needs attention."

### Chips
- **Style:** small rectangular paper tags cut from `--surface`/`--ink-on-paper`, 2px radius (never pill-shaped), soft lift shadow, bold small label text.
- **State:** a resting/deprioritized player chip goes transparent with a dashed border and strikethrough text rather than disappearing; a "picked" chip (manual swap, waiting-queue pick) takes a solid `--court` outline and a warm `--court-wash` highlighter-marker fill.

### Cards / Containers (Court Panel / Notice Block / Ended Banner)
- **Corner Style:** 2px radius.
- **Background:** `--surface` cream paper, always with `--ink`/`--ink-soft`/`--error-ink` rescoped to their paper-safe values.
- **Shadow Strategy:** soft panel-lift shadow (see Elevation), plus a state-colored ring for court panels.
- **Border:** none — the tilt, tape strip, and shadow carry the "paper card" read instead of an outline.
- **Internal Padding:** `--space-2` `--space-3` `--space-3` (court panel); `--space-2` (notice block/banner).
- **Signature detail:** a `::before` masking-tape strip (`--tape`) at the top-left corner and a `rotate(±0.4–0.6deg)` tilt, alternating per nth-child for a natural scatter — decorative only, never carrying state.

### Inputs / Fields
- **Style:** cream paper fill (`--surface`), `--ink-on-paper` text, 1px `--rule` border, 2px radius, 44px min-height, 16px+ font size (never smaller, to avoid iOS Safari's auto-zoom-on-focus).
- **Focus:** border shifts to `--accent`; `:focus-visible` adds a 2px `--accent` outline with 2px offset across inputs, buttons, and links alike.
- **Error:** `.error` text in `--error-ink` (context-dependent: brighter accent-ink on the board, `--warn` inside paper cards).

### Navigation
- **Style:** links (`a`) are bold `--court-ink` green, never accent — accent is reserved for "needs attention," and reusing it for ordinary wayfinding would dilute that signal. No distinct hover state beyond underline/color inherited from browser defaults plus the shared `:focus-visible` outline.

### Segmented Toggle (`.scope-toggle`) — signature component
A two-way switch (mode toggle, stats scope) styled as a hand-marked segmented control: cream paper segments with the same rough-edge `::before` border as ghost buttons, an inactive segment in `--ink-on-paper-soft`, and the active segment inverted to a solid `--ink-on-paper` fill with cream text — deliberately not accent-colored, since accent is reserved for "needs attention" and this is a quiet setting, not an alert. Capped to content width (`max-width: 28rem` or `flex: 0 0 auto` per instance) rather than stretching edge-to-edge, so a two-way switch never reads as a banner.

## Do's and Don'ts

### Do:
- **Do** keep `--accent` (marker red) reserved for "the host must act on this now" only — pending states, new/fuzzy roster flags, the danger-zone border — never for ordinary navigation or the primary action.
- **Do** rescope `--ink`/`--ink-soft`/`--error-ink` via CSS custom-property overrides on any new paper-surfaced container (following `.court-panel`, `.notice-block`, `.ended-banner`, `.remove-confirm`), so nothing inside silently inherits board-ink values against a paper background.
- **Do** wrap any digit sequence that appears inside a Permanent-Marker-styled heading or label in its own `--font-text` span, so Thai numeral fallback never silently replaces Arabic digits.
- **Do** draw outline-button and segmented-toggle borders via the shared `#rough-edge` filter `::before`, keeping the element's own `border: none` so the filter never displaces the label text itself.
- **Do** use soft, blurred, offset shadows for anything meant to read as a paper object lifted off the board; never a hard or zero-blur shadow.

### Don't:
- **Don't** round a court panel, chip, or button beyond the system's 2px `--radius` — this is cut paper, not a rounded UI kit; reserve `--radius-pill` for the rare capsule-shaped badge/tag.
- **Don't** set a whole paragraph, or any numeral, in Permanent Marker — it has no digit glyphs and is legible only at heading sizes, not body-copy length.
- **Don't** use `--accent`/`--accent-ink` for the primary/confirm action or for routine links — that collapses the app's one deliberate "look here" signal into generic decoration.
- **Don't** let a segmented toggle (`.scope-toggle`) stretch full-width on a wide viewport — it is a setting, not a banner, and must stay thumb-width.
