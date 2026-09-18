---
name: JubBad
description: A daylight sports-equipment world for running badminton club sessions — light-first, warm, physical, with a court-green/shuttle-orange pair doing all the signalling.
colors:
  ground: "#faf8f4"
  ground-sunk: "#f2eee7"
  surface: "#ffffff"
  line: "#e5dfd5"
  ink: "#16130f"
  ink-soft: "#6b6459"
  ink-faint: "#a49b8c"
  court: "#1f6b3d"
  court-dark: "#185530"
  court-soft: "#e8f3ec"
  court-ink: "#1c6238"
  accent: "#ff5a36"
  accent-dark: "#e14a28"
  accent-soft: "#ffe9e2"
  accent-ink: "#bd3414"
  warn: "#b0201a"
  warn-wash: "#fdecea"
  waiting: "#a49b8c"
  gold: "#b3801f"
typography:
  display:
    fontFamily: "'Bai Jamjuree', 'Anuphan', system-ui, sans-serif"
    fontSize: "clamp(2rem, 5vw, 3rem)"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "'Bai Jamjuree', 'Anuphan', system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 700
    lineHeight: 1.25
  title:
    fontFamily: "'Bai Jamjuree', 'Anuphan', system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 700
    lineHeight: 1.25
  body:
    fontFamily: "'Anuphan', system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "'Anuphan', system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: 1.6
rounded:
  md: "12px"
  lg: "22px"
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
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "0.65rem 1.1rem"
  button-primary-hover:
    backgroundColor: "{colors.court-dark}"
  button-danger:
    backgroundColor: "{colors.warn}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "0.65rem 1.1rem"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0.5rem 0.9rem"
  chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0.35rem 0.9rem"
    typography: "{typography.label}"
---

# Design System: JubBad

## Overview

**Creative North Star: "Daylight Court"**

JubBad's world is a bright indoor court on a sunny afternoon: one overhead light source, real equipment-grade rounding, and a court-green/shuttle-orange pair that does all the signalling. Ground and surface now sit in the same lightness family in both the light and dark themes — depth is carried by elevation (soft, blurred, warm-tinted shadow) and a colored ring, not by a hard jump between a dark board and light paper. This replaces the retired "Draw Sheet" world (dark chalkboard, taped paper cards, Permanent Marker) outright: there is no tape, no tilt, no rough-edge filter, and no hand-marked display face anywhere in the shipped system.

Typography pairs Bai Jamjuree (display/numerals) with Anuphan (text/UI) — a single Cadson Demak pairing designed to sit together, both with full Thai and Latin coverage. This retires the old digit-fallback-to-Thai-numerals bug class entirely: there is no longer a font in the stack that lacks Arabic numeral glyphs, so no heading or stat needs a defensive `--font-text` numeral wrapper. `.court-num` and `.board-date` still exist as class names in the DOM (spec files bind to them), but the risk they were built to guard against no longer applies.

The system ships two themes (light and dark, auto via `prefers-color-scheme` or an explicit toggle) and one deliberate exception: the venue/TV display route is pinned dark regardless of the visitor's theme choice, because it is furniture in a room, not a screen someone holds. A recurring feather-arc mark is the one signature device, reused structurally as the app mark, a loading spinner, and — thickened into 3D — the emblem behind five of the app's routes, never as one-off decoration.

**Key Characteristics:**
- One lightness family for ground and surface in both themes (`--ground`/`--surface`); depth comes from `--shadow-xs/sm/md/lg` and a colored ring, not a ground/surface color jump.
- A structural green (`--court`) carries the primary action, the "live" state, and ordinary navigation on purpose — all three are "the good, expected path." A reserved shuttle-orange (`--accent`) means "the host must act on this court right now" and nothing else.
- Real rounding throughout (`--radius` 12px controls, `--radius-lg` 22px cards/panels/dialogs, `--radius-pill` capsules) — equipment and courts, not cut paper.
- One inline feather-arc SVG symbol, reused as the app mark, the `.feather-arc.spin` loading indicator, and — extruded from the same bezier paths into a beveled 3D emblem via three.js — the hero object on five routes (never on session-dashboard/court-panel, for battery/thermal reasons on a long one-handed session). Three earlier passes tried sculpting an actual shuttlecock from primitive geometry and each one read as some other object instead (a spiky cone, a woven basket, a lampshade); giving the app's own proven 2D mark literal depth removed that risk entirely rather than solving it.
- A shared CSS motion vocabulary (`--ease-out`, `--ease-spring`, `--duration-fast/base/slow`) plus a small set of Angular motion directives (`appPress` spring bounce, `appReveal` CSS-only stagger-in, `appFlipList` FLIP reorder) — deliberately CSS/timeline-driven rather than per-frame JS state writes, after an earlier JS-tween version intermittently raced test infrastructure.

## Colors

Two hues do the app's signalling — green for "expected/good," orange for "needs you now" — laid over one shared light/dark neutral scale.

### Primary
- **Court Green** (`#1f6b3d`, `--court`; hover `#185530`, `--court-dark`; wash `#e8f3ec`, `--court-soft`): the default filled-button color, the "live" court-panel ring, and — via `--court-ink` (`#1c6238`) — ordinary link/navigation color. One hue doing three related jobs deliberately, since all three read as "the good, expected path"; this differs from the retired system, which spent a second green solely on navigation to keep it out of the accent's way.

### Secondary
- **Shuttle Orange** (`#ff5a36`, `--accent`; hover/darker `#e14a28`, `--accent-dark`; wash `#ffe9e2`, `--accent-soft`): reserved for "the host must act on this court right now" — the pending court-panel ring and pulse, `.status-dot.pending`, a real password-reset match. Never the primary action, never a link. A darkened text variant (`#bd3414`, `--accent-ink`) exists specifically because the base `--accent` clears only 4.49:1 on white — just under the 4.5:1 floor — so any body-text use (a matched-review tag, an admin badge, a "reset link sent" line) gets `--accent-ink` instead, dark enough to also clear 4.5:1 against `--accent-soft`'s own background.

### Tertiary
- **Gold** (`#b3801f` light / `#e3b155` dark, `--gold`): a winner's stat or top-of-leaderboard mark only — never a status color, never interactive.

### Neutral
- **Ground** (`#faf8f4`, `--ground`; sunk `#f2eee7`, `--ground-sunk`): the page background in light theme (`#0e1310`/`#0a0e0b` in dark).
- **Surface** (`#ffffff`, `--surface`; raised `#1e2922` in dark): court panels, chips, inputs, dialogs — raised off ground by shadow, not by a lightness-family jump.
- **Ink** (`#16130f`, `--ink`; soft `#6b6459`, `--ink-soft`; faint `#a49b8c`, `--ink-faint`): the single ink scale used everywhere, light or dark theme, ground or surface.
- **Line** (`#e5dfd5`, `--line`): borders, dividers, the segmented-toggle track.
- **Warn** (`#b0201a`, `--warn`; wash `#fdecea`): irreversible actions (`button.danger`) and error text — a distinct hue from accent so "irreversible" and "needs attention" never collide.
- **Waiting** (`#a49b8c`, `--waiting`): the idle status dot.

### Named Rules
**The One Ground Rule.** Ground and surface sit in the same lightness family in both themes; a card reads as "the same light, slightly raised," never a second material. Depth is elevation's job (`--shadow-*`) and a colored ring, not a color-family jump — the retired system's two-ground/two-ink split (dark board vs. light paper) is gone because this world no longer has two materials to ink for. `--ink-on-paper`/`--ink-on-paper-soft`/`--ink-on-court`/`--ink-on-court-soft` still exist as CSS custom properties (plain aliases of `--ink`/`--ink-soft`) purely so pre-existing component CSS that rescopes them keeps working; they carry no independent value and should not be treated as a live two-ground system in new work.

**The One Orange Rule.** `--accent` means "the host must act on this court right now" and only that — never the primary/confirm action (`--court`) and never ordinary navigation (`--court-ink`). Diluting it into a general highlight removes the one signal the host actually needs at a glance.

## Typography

**Display Font:** Bai Jamjuree (with Anuphan, system-ui, sans-serif fallback)
**Body Font:** Anuphan (with system-ui, sans-serif fallback)

**Character:** A confident, slightly condensed display face for headings and big numerals, paired with a plain, highly legible UI face for everything read up close — both from one type foundry (Cadson Demak), both with full Thai and Latin coverage, so nothing in the pairing needs a third fallback family.

### Hierarchy
- **Display** (700, `--text-4xl`/`--text-5xl`, clamp 2–3rem / 2.5–4rem, 1.25 line-height): the content-is-the-point numbers — a court number, a live score — new in this redesign since court numbers are now the subject of their screen, not a label beside data.
- **Headline** (700, `--text-2xl`/`--text-3xl`, 1.25): h1/h2, Bai Jamjuree.
- **Title** (700, `--text-xl`, 1.25): h3/h4 — court-panel headings, section titles.
- **Body** (400, `1rem`, 1.6 line-height): Anuphan; 1.6 rather than 1.5 because Thai stacks tone marks above and below the baseline.
- **Label** (600, `--text-sm`, 1.6): `.label`, form labels — never uppercase/tracked-out, since Thai has no case and tracked capitals only style the Latin half of a bilingual UI.

### Named Rules
**The Real Digit Rule.** Both display and body fonts carry native Arabic numeral glyphs, so no numeral in this system silently falls back to another script's digit forms. `.court-num` and `.board-date` remain in the DOM only because 19 spec files bind to them via `querySelector`; they carry no defensive numeral-wrapping behavior and none is required of new work.

## Layout

A single-column phone-first shell (`.page`, max-width 32rem) that widens on tablet: `.page-wide` steps to 56rem at ≥48rem and 68rem at ≥64rem (iPad landscape, 1024px, is the anchor device). `.page-dark` (the venue/TV display) drops the max-width entirely, is pinned to a near-black ground (`#0a0e0b`) regardless of the visitor's own theme, and scales type in `vmin`/`clamp()` for legibility across a room rather than a phone-first `rem` scale. Spacing runs the unchanged 4px-rhythm scale (`--space-0` 4px through `--space-5` 48px). Court panels grid at 1-up (phone), 2-up (≥48rem), 3-up (≥64rem); the venue display grids 1/2/3-up at 40rem/64rem breakpoints of its own, stacking a court's number over its names rather than side-by-side so every panel keeps the same shape regardless of name length.

## Elevation & Depth

Layered, not flat: one implied overhead light source produces soft, blurred, warm-tinted shadows (never a hard-edged or zero-blur shadow) at four strengths, plus a colored ring layered on top of the base shadow to carry state (pending = orange ring + pulse, active = green ring + lift). This is a full replacement of the retired system's "soft-lift-only, board is flat" split: in Daylight Court, buttons, chips, inputs, and panels all sit on the same elevation scale.

### Shadow Vocabulary
- **`--shadow-xs`** (`0 1px 2px rgba(35,28,15,0.06)`): resting buttons, chips, inputs.
- **`--shadow-sm`** (`0 3px 10px -4px rgba(35,28,15,0.14), 0 1px 2px rgba(35,28,15,0.06)`): hovered buttons, a resting court panel.
- **`--shadow-md`** (`0 12px 28px -10px rgba(35,28,15,0.18), 0 2px 6px -2px rgba(35,28,15,0.08)`): a pending or active court-panel ring's paired shadow.
- **`--shadow-lg`** (`0 24px 56px -18px rgba(35,28,15,0.24), 0 6px 16px -6px rgba(35,28,15,0.1)`): the toast.
- Dark theme swaps the same four roles to a neutral near-black alpha rather than the warm rgba above (see `styles.css`).

### Named Rules
**The Ring-Over-Shadow Rule.** State on a court panel is a colored ring (`0 0 0 2px var(--accent|--court)`) layered in front of the panel's own elevation shadow, animated as a transition rather than a hard cut between three static shadow recipes — pending pulses once (`ring-pulse`), active settles to a lifted `translateY(-2px)`.

## Shapes

Real rounding, the deliberate opposite of the retired 2px-corner system: this is equipment and courts, not cut paper. `--radius` (12px) covers controls — buttons, inputs, chips get `--radius-pill` (999px) instead, full capsules. `--radius-lg` (22px) is for anything that reads as a card or panel — court panels, notice blocks, dialogs. No hand-drawn or rough-edge borders exist anywhere in the build; every border is a plain 1–1.5px `--line` stroke.

## Components

### Buttons
- **Shape:** 12px corners (`--radius`), 44px minimum tap height (`--tap`) on every variant.
- **Primary (default `<button>`):** court-green fill (`--court`), white text, darkens to `--court-dark` on hover (hover-capable pointers only), spring-eased `scale(0.97)` on active.
- **Ghost (`button.ghost`):** transparent fill, a real 1.5px `--line` border (no filter, no pseudo-element trickery), ink text, brightens border to `--ink-faint` with a `--court-hover` background wash on hover.
- **Danger (`button.danger`):** filled `--warn`, white text, darkens on hover — a distinct red hue from `--accent` so "irreversible" never shares a hue with "needs attention."

### Chips
- **Style:** small capsule tags (`--radius-pill`, never square) cut from `--surface`/`--ink`, 1.5px `--line` border, `--shadow-xs` lift, bold small label text.
- **State:** `appPress` gives chips and name-taps a spring bounce beyond the base CSS `:active` scale, for the small frequently-tapped controls (chips, court-panel name-taps, waiting-queue picks) where a linear scale reads as flat.

### Cards / Containers (Court Panel / Notice Block / Dialogs)
- **Corner Style:** 22px radius (`--radius-lg`).
- **Background:** `--surface`, flat white/raised-dark — no tilt, no tape, no torn-paper detail.
- **Shadow Strategy:** base elevation shadow at rest; a colored ring (see Elevation) added for pending/active state.
- **Border:** none — elevation and the state ring carry the "raised object" read.
- **Internal Padding:** `--space-2` `--space-3` `--space-3` (court panel).

### Inputs / Fields
- **Style:** `--surface` fill, `--ink` text, 1.5px `--line` border, `--radius` corners, 44px min-height, 16px+ font size (never smaller, to avoid iOS Safari's auto-zoom-on-focus).
- **Focus:** border shifts to `--accent`; `:focus-visible` adds a 2px `--accent` outline with 2px offset across inputs, buttons, and links alike.
- **Error:** `.error` text in `--error-ink` (an alias of `--warn`).

### Navigation
- **Style:** links (`a`) are bold `--court-ink` green — the same structural green as the primary action and the live state, deliberately, since ordinary wayfinding is "the good, expected path" in this world. No distinct hover state beyond the shared `:focus-visible` outline.

### Segmented Toggle (`.scope-toggle`)
A two-way switch (mode toggle, per-court format, stats scope) styled as two rounded pills sharing one pill-shaped track (`--radius-pill`), the active segment filled `--surface` with a `--shadow-xs` lift. Capped to content width (`max-width: 28rem` or `flex: 0 0 auto` per instance) rather than stretching edge-to-edge, so a two-way switch never reads as a banner. The court panel's own instance shrinks further to sit between the court number and the status dot.

### Feather-Arc Mark — signature component
One inline SVG symbol (four tapered arcs fanning from a shared base, plus a stem) reused at every scale: the app-shell mark (16–20px), `.feather-arc.spin` as the loading indicator (`@keyframes feather-spin`, 1.1s linear), and — as a 3D emblem — the hero object mounted via `<app-scene-host variant="hero"|"ambient">`. The 3D version (`core/three/feather-scene.ts`) is not a separate sculpted object: it extrudes the icon's own cubic-bezier paths (the exact coordinates from `shared/icon/icon.ts`'s `feather` case) into beveled solid geometry via three.js's `ExtrudeGeometry`, so the hero is guaranteed to read as the same mark shown everywhere else in the app rather than as its own, independently-judged 3D model. The hero variant appears on login, landing, session-summary, and player-profile; the ambient variant appears only on session-display (pinned dark, non-transparent, drifting far back so it never competes with the court data in front of it). It is deliberately never mounted on session-dashboard or court-panel, to keep WebGL off the screen used for hours, one-handed, courtside. Falls back to a flat feather-mark poster — never a fabricated "photo" of the scene — under reduced-motion, ≤4 cores, data-saver, WebGL failure, or off-screen.

**Named Rule — Extrude, Don't Sculpt.** A 3D hero object drawn from scratch (a shuttlecock built from primitive cones, blades, or a lathed skirt) carries real risk of reading as the wrong thing entirely — three independent attempts here produced a spiky cone, a woven basket, and a lampshade before this one shipped. Extruding a shape that already works in 2D removes that risk rather than iterating through it: there is no "does this read as intended" question left once the 3D object is provably the same silhouette as the 2D mark it's based on. Any future 3D hero on this app should extrude an existing, approved 2D asset before it tries to sculpt something new.

## Do's and Don'ts

### Do:
- **Do** keep `--accent` (shuttle orange) reserved for "the host must act on this court now" only — the pending ring/pulse, a real password-reset match — never for the primary action or ordinary navigation.
- **Do** use `--accent-ink` (`#bd3414`), not the base `--accent`, for any accent-hued body text, since the base hue falls just under 4.5:1 contrast on white.
- **Do** treat elevation (`--shadow-xs/sm/md/lg`) plus a colored ring as the only way to signal a raised object or its state — never a hard-edged or zero-blur shadow.
- **Do** gate any new 3D/WebGL mount through `<app-scene-host>` rather than a bespoke canvas, so the reduced-motion/low-core/data-saver/off-screen fallback to the flat feather-mark poster is never reimplemented per call site.
- **Do** keep motion that drives visible state (reveals, odometers, live numerals) CSS/timeline-driven rather than a per-frame JS write into a signal — `appReveal` and `Odometer` both document a real test race this caused previously.

### Don't:
- **Don't** reintroduce a hand-drawn, rough-edge, or wobbled border anywhere — every border in this system is a plain straight `--line` stroke; the retired system's `#rough-edge` SVG filter is gone entirely, not an option to bring back for a "textured" moment.
- **Don't** set a court panel, dialog, or notice block to less than `--radius-lg` (22px), or a control below `--radius` (12px)/`--radius-pill` — this is rounded equipment, not the retired system's cut-paper 2px corners.
- **Don't** mount `<app-scene-host>` on session-dashboard or court-panel — the always-visible, hours-long, one-handed surface stays WebGL-free for battery and thermal reasons.
- **Don't** let a segmented toggle (`.scope-toggle`) stretch full-width on a wide viewport — it is a setting, not a banner, and must stay thumb-width.
- **Don't** rename or remove `.court-num`, `.board-date`, or any other class 19 spec files bind to via `querySelector` — new classes/attributes are additive only in this codebase.
