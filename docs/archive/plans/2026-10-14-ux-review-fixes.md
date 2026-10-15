# UX Review Fixes Implementation Plan

> **Archived 2026-10-15.** Implemented and merged to `main` with `feature/group-creation-settings`. Task checkboxes below were never ticked during execution and were not retroactively checked; read this as a record of the order of work, not of per-step status.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the owner-approved fixes from the 2026-10-14 UX critique (`.impeccable/critique/2026-10-13T18-21-19Z__web-src-app-pages-group-home-group-home-html.md`, 27/40) to the group creation and settings flow: readable contrast, no sideways page scroll, a group home that knows live from ended, a safer roster review step, consistent settings screens, and a shorter weekly paste path.

**Architecture:** Five small, ordered tasks on branch `feature/group-creation-settings`, each with its own tests and review. Task 1 is global CSS. Tasks 2–4 touch the group home, the roster screen and the landing list. Task 5 regenerates the translation catalogue, updates the docs, and runs every suite.

**Tech Stack:** Angular 22 (standalone, signals, zoneless), vitest through `ng test`, `@angular/localize` with a Thai source catalogue and an English XLF.

**Spec:** `docs/archive/specs/2026-10-13-group-creation-settings-design.md`. The settings-above-session-action order is FIXED by the owner and must not change. Task 5 updates the spec where this plan changes a stated behaviour (resume card, discard placement, weekly-path shortcuts).

## Global Constraints

- Settings stay above the session action on group home, for new and existing groups.
- Colours, spacing, radii and shadows come from tokens in `web/src/styles.css`. The shuttle-orange `--accent` means "the host must act on this court right now" and nothing else: it is never used for a session's open/live state.
- Text on a filled `--court`, `--warn` or `--accent` background must reach 4.5:1 in BOTH themes.
- Every tap target is at least 44px (`--tap`).
- Thai is the i18n source. Every new string has a stable `@@id` and an English `<trans-unit>` in `web/src/locale/messages.en.xlf`. No id carries two different source texts. Vocabulary: ก๊วน is the group, รอบ is a session; never นัด.
- No application data goes into `localStorage`.
- Tests must be able to fail: no assertion that passes when the behaviour is absent.
- Controllers' deferred minors from earlier tasks stay deferred unless a task below names them.
- Do not mount `<app-scene-host>` on any screen touched here.

## Review Focus

1. **A session left open for days.** The host expects group home to say "ยังไม่ปิดรอบ" in a neutral style, never "กำลังเล่นอยู่" with the green ring. Test in Task 2.
2. **Clipboard denied, empty or unsupported.** The host expects a plain message and a focused paste box, never a dead button or a silent failure. Tests in Task 4.
3. **Undo after clearing a roster, then navigating away.** The host expects the restored roster to be exactly what they cleared, and no stale undo to resurrect a roster after a session was created. Tests in Task 3.
4. **Dark theme.** Every filled button's text is readable. Verified by an automated token-contrast test in Task 1 and by the screenshot round afterwards.
5. **A host whose group name is very long.** New back links and the resume card wrap without clipping or pushing the settings trigger off-screen. Covered by the screenshot round.

---

## File Structure

- Modify `web/src/styles.css`: `--on-fill` token, `button`/`button.danger` text colour, `.table-scroll` positioning.
- Create `web/src/styles.contrast.spec.ts`: token contrast regression test.
- Create `web/src/app/core/session-date.ts` and `session-date.spec.ts`: friendly date and session state helpers.
- Modify `web/src/app/pages/group-home/group-home.{ts,html,css,spec.ts}`: live/ended resume card, friendly dates, two-card settings, past-session rows.
- Modify `web/src/app/pages/group-entry/group-entry.{ts,html,css,spec.ts}`: discard placement and undo, edit-paste, textarea label, clipboard paste, autofocus, full-width confirm.
- Modify `web/src/app/pages/player-roster/player-roster.{ts,html,css,spec.ts}` and `web/src/app/pages/group-levels/group-levels.{ts,html,css,spec.ts}`: named 44px back links, players empty state.
- Modify `web/src/app/pages/landing/landing.{html,css,spec.ts}`: per-row start link, 44px name links.
- Modify `web/src/locale/messages.xlf` (regenerated) and `messages.en.xlf`.
- Modify `DESIGN.md`, the spec, and the docs touched by Task 5.

---

### Task 1: Readable filled buttons in dark theme, and no sideways scroll on the players page

**Files:**
- Modify: `web/src/styles.css`
- Create: `web/src/styles.contrast.spec.ts`
- Modify: `web/src/app/pages/group-home/group-home.css` (the `.start` link only)
- Modify: `DESIGN.md` (the button component entries and the Colors section: one added token, one note)

**Decisions (binding):**
- Add `--on-fill` to `:root` as `#ffffff`. In BOTH dark blocks (`@media (prefers-color-scheme: dark) :root:not([data-theme='light'])` and `:root[data-theme='dark']`) set it to the dark ground `#0e1310`. Measured: `#0e1310` on `#3fd07a` is 9.4:1, on `#ff6b60` (dark `--warn`) 6.7:1, on `#ff7a5c` (dark `--accent`) about 6.7:1.
- Replace the hard-coded `color: #ffffff` in the global `button` rule and in `button.danger` with `var(--on-fill)`. Leave `::selection` (white on `--accent` selection highlight) alone.
- Find every other component rule that sets white text on a `var(--court)`, `var(--warn)` or `var(--accent)` background (`grep -rn "#fff\b\|#ffffff" web/src --include=*.css`, then check each background). Switch those to `var(--on-fill)`. Report each one you changed and each one you deliberately left.
- `.start` in `group-home.css` must use `var(--on-fill)`, not `#ffffff`. Do not change anything else in that file in this task.
- `.table-scroll` in `styles.css` gets `position: relative`. Reason (put it in the comment): its absolutely positioned `.sr-only` sort hint inside a `<th>` otherwise escapes the clip and widens the document, so on a phone the whole page pans sideways.
- Do NOT touch the disabled button colours or placeholder colours in this task.

- [ ] **Step 1: Write the failing contrast test**

Create `web/src/styles.contrast.spec.ts`. It reads `web/src/styles.css` as text, extracts the light values (`:root` block) and the dark values (the `:root[data-theme='dark']` block) of `--on-fill`, `--court`, `--warn` and `--accent`, and asserts the WCAG contrast ratio of `--on-fill` against each fill is at least 4.5 in both themes. It also asserts `.table-scroll` has `position: relative`. Implement the ratio with the standard WCAG relative-luminance formula. If the web test runner cannot read the CSS file (no `node:fs` types, no `?raw` import support), try the other; if neither works, stop and report BLOCKED with the exact error. Do not invent a different test location.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd web && npx ng test --watch=false --include=src/styles.contrast.spec.ts`
Expected: FAIL (`--on-fill` missing, `.table-scroll` not positioned).

- [ ] **Step 3: Implement the CSS changes above and update DESIGN.md**

In DESIGN.md, change the `button-primary` and `button-danger` `textColor` lines to `{colors.on-fill}`, add an `on-fill` colour (`"#ffffff"`) to the frontmatter colours, and add one short Named Rule under Colors: text on a filled brand colour uses `--on-fill`, white in light and the dark ground in dark, because white on the dark theme's bright green is 2.0:1. Keep the edit minimal and do not touch the other sections.

- [ ] **Step 4: Run the test and the full web suite**

Run: `cd web && npx ng test --watch=false --include=src/styles.contrast.spec.ts` then `cd web && npx ng test --watch=false`
Expected: PASS everywhere.

- [ ] **Step 5: Commit**

```bash
git add web/src/styles.css web/src/styles.contrast.spec.ts web/src/app/pages/group-home/group-home.css DESIGN.md
git commit -m "fix(ui): readable filled buttons in dark theme; players page no longer pans sideways"
```

---

### Task 2: Group home knows live from ended; friendly dates; settings as two cards

**Files:**
- Create: `web/src/app/core/session-date.ts`
- Create: `web/src/app/core/session-date.spec.ts`
- Modify: `web/src/app/pages/group-home/group-home.ts`, `group-home.html`, `group-home.css`, `group-home.spec.ts`
- Modify: `web/src/locale/messages.en.xlf`

**Interfaces:**
- Produces in `session-date.ts`:
  - `type SessionState = 'live' | 'open' | 'ended'`
  - `sessionState(s: { endedAt: string | null; date: string | null; createdAt: string }, now?: Date): SessionState`
    - `ended` when `endedAt` is set.
    - Otherwise `live` when `date` equals the local calendar date of `now`, or when `date` is null and `createdAt` is within the 18 hours before `now`.
    - Otherwise `open`.
  - `formatSessionDate(isoDate: string | null, locale: string): string`: for `'2026-10-13'` and locale `th` gives the short weekday, day and short month (for example `อ. 13 ต.ค.`), and for locale `en` gives `Tue, Oct 13`. Parse the `YYYY-MM-DD` as a LOCAL date (never `new Date('2026-10-13')`, which shifts by timezone). Omit the year. Null or unparsable input returns the empty string. Use `Intl.DateTimeFormat`.

**Decisions (binding):**
- `GroupHome.latest()` returns `{ code, session, state, dateLabel }` where `session` is the `GroupSession` whose `code === group.lastSessionCode`, found in the already-loaded `sessions()`. If that session is not in the list, `state` is `'ended'`-styled but with the plain label `กลับไปรอบล่าสุด` and no date (a graceful fallback; never show a live or open claim without data).
- **Live** (`state === 'live'`): in the header slot, under the name/settings row and ABOVE the settings list, render `<a data-resume data-state="live" class="resume-card" [routerLink]="['/s', code]">`. It is a card: `--surface`, `--radius-lg`, padding `--space-2 --space-3`, min-height `4.25rem`, and a green ring layered over the resting shadow: `box-shadow: 0 0 0 2px var(--court), var(--shadow-sm)`. Content: a small label line **● กำลังเล่นอยู่** (court-ink, the dot is the existing court-green 8px dot), a title **กลับไปรอบที่เล่นอยู่** (weight 700), a muted sub-line `{dateLabel} · {venue} · {matchCount} แมตช์` (omit empty parts and their separators), and a chevron icon on the right. The whole card is the link.
- **Open (stale)** (`state === 'open'`): the same card without the ring, label **ยังไม่ปิดรอบ** (muted, no green dot), title **ดูรอบล่าสุด**.
- **Ended:** the existing text link, with no dot: **ดูรอบล่าสุด** followed by the muted `· {dateLabel}`. Keep `data-resume`; set `data-state="ended"`.
- The start action: when `state === 'live'` it is a ghost-style link (`class="start ghost-start"`: transparent background, 1.5px `--line` border, `--ink` text, same size and tap target); in every other case it stays the filled primary. The element stays an `<a data-start [routerLink]>`; the label stays **เริ่มรอบใหม่**.
- The hint (`data-hint`) is unchanged.
- **Past sessions rows:** each `<li>` becomes a flex row with `min-height: var(--tap)`; the date link fills the row's left side with `display: inline-flex; align-items: center; min-height: var(--tap)`; the venue and match count follow with a CSS `gap`, with no reliance on template whitespace (the old rows rendered `2026-10-11· KIP·`). The link text is `formatSessionDate(date) || code`. Replace the orange `.live-tag` pill: state `live` shows **● กำลังเล่น** in `--court-ink` on `--court-soft`; state `open` shows **ยังไม่ปิดรอบ** in `--ink-soft` on `--ground-sunk`; `ended` shows nothing. The app locale comes from `inject(LOCALE_ID)`.
- **Two cards:** the settings list becomes a wrapper `<div id="group-settings" [hidden]="!settingsOpen()">` (this keeps `aria-controls`) holding two lists: first a `<ul class="settings">` with the four routine rows (`aria-label` = the existing `@@group.settingsList`, ตัวเลือกของก๊วน), then a second `<ul class="settings settings-manage" aria-label="จัดการก๊วน">` with only the manage row, separated by `margin-top: var(--space-2)`. Remove the old `li.manage` band styles (the `--ground` border and the 8px margin trick). Each list is its own `--surface` card with `--radius-lg` and `--shadow-sm`. Give the second list a new i18n id `@@group.manageList`.
- Existing group-home tests that use `list()` as `#group-settings` and check `.hidden` keep working; adapt only what the structure change breaks.

- [ ] **Step 1: Write the failing tests**

`session-date.spec.ts`:
- `sessionState` returns `ended` when `endedAt` is set, `live` for a not-ended session whose `date` is today (pass a fixed `now`), `live` for a null-date session created 2 hours ago, `open` for a not-ended session dated five days ago, and `open` for a null-date session created 30 hours ago.
- `formatSessionDate('2026-10-13', 'en')` is `Tue, Oct 13`. Its `th` result contains `13` and a Thai month abbreviation and no year digits. The empty string for `null`, and for `'not-a-date'`.
- A date near a month boundary (`'2026-12-31'`) is not shifted by timezone: run the assertion with `process.env.TZ` unchanged and with a negative-offset `now`; the day number must be 31.

`group-home.spec.ts` (add; adapt the existing resume tests):
- Live session (SESSION fixture with `endedAt: null` and `date` equal to today): `[data-resume][data-state="live"]` exists, its title says กลับไปรอบที่เล่นอยู่, it contains the label กำลังเล่นอยู่, and the start link has class `ghost-start`.
- Open session dated 5 days ago, `endedAt: null`: `data-state="open"`, label ยังไม่ปิดรอบ, no `ring` class and no กำลังเล่นอยู่ text, start link NOT ghost.
- Ended session: `data-state="ended"`, text ดูรอบล่าสุด, no green dot element, start link NOT ghost.
- The latest session missing from the sessions list: shows กลับไปรอบล่าสุด with no state claim.
- A past-session row for a live session shows กำลังเล่น and has no element with class `live-tag`; each date link's rendered height is not asserted (jsdom), but assert the row has the class that carries `min-height`.
- The settings wrapper contains exactly two `ul` elements: four `a[data-section]` rows then one row with `data-section="manage"`.
- Escape, focus restore and `?settings=` tests still pass.

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd web && npx ng test --watch=false --include=src/app/core/session-date.spec.ts --include=src/app/pages/group-home/group-home.spec.ts`
Expected: FAIL (module missing; new assertions failing).

- [ ] **Step 3: Implement**

Implement exactly the decisions above. Use `RouterLink` on the card, the `chevron` icon (rotated like the rows), tokens only, and `@media (prefers-reduced-motion: reduce)` guards on any transition. English targets for every new string: ● กำลังเล่นอยู่ → "Playing now"; กลับไปรอบที่เล่นอยู่ → "Back to the live session"; ดูรอบล่าสุด → "View latest session"; ยังไม่ปิดรอบ → "Not ended yet"; กำลังเล่น → "Playing"; จัดการก๊วน list label → "Manage group"; `{n} แมตช์` sub-line reuses the existing `entry.matches` id. The existing `group.resumeLast` stays for the fallback.

- [ ] **Step 4: Run the tests and the full web suite**

Run: `cd web && npx ng test --watch=false --include=src/app/core/session-date.spec.ts --include=src/app/pages/group-home/group-home.spec.ts` then the full web suite.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/core/session-date.ts web/src/app/core/session-date.spec.ts web/src/app/pages/group-home web/src/locale/messages.en.xlf
git commit -m "feat(web): group home separates live from ended sessions; friendly dates; two settings cards"
```

---

### Task 3: Safer roster review, and consistent players/levels screens

**Files:**
- Modify: `web/src/app/pages/group-entry/group-entry.{ts,html,css,spec.ts}`
- Modify: `web/src/app/pages/player-roster/player-roster.{ts,html,css,spec.ts}`
- Modify: `web/src/app/pages/group-levels/group-levels.{ts,html,css,spec.ts}`
- Modify: `web/src/app/pages/group-home/group-home.html` (the players row description only)
- Modify: `web/src/locale/messages.en.xlf`

**Decisions (binding):**

*Roster review step (`GroupEntry`, `state() === 'confirm'`):*
- **Move the discard button.** Remove `data-discard` from under the title. Put it after the confirm button and its messages, as a quiet text-style button (`class="ghost"`), label **ล้างรายชื่อ** (the old, longer label `entry.discardDraft` is retired: give the new text a NEW id `@@entry.clearRoster`; leave the old id unused for the Task 5 catalogue cleanup).
- **Undo.** `discardDraft()` first captures a full snapshot with the same builder `persistDraft()` uses (extract it into one private method `snapshotDraft(): RosterDraft`, used by both). It then clears as today and sets `undoSnapshot` (a signal holding the snapshot) and starts an 8-second timer that clears it. While `undoSnapshot()` is set, render an inline notice directly above the paste box: `role="status"`, text **ล้างรายชื่อแล้ว** and a **เลิกทำ** button (`data-undo`, 44px). `undoDiscard()` re-applies the snapshot through `applyDraft`, then clears `undoSnapshot`. If the app already has a shared toast component or service, reuse it instead of the inline notice; otherwise the inline notice is fine. Clear the timer when the component is destroyed. The undo must also be cleared when the host pastes new text, starts manual entry, parses, or creates a session. It must never restore a roster after `sessionCreated`.
- **Edit the pasted text.** When the review step came from a pasted message (`rawText().trim()` is non-empty), show a **← แก้ข้อความที่วาง** button (`data-edit-paste`, 44px, `ghost`) directly under the title. `editPaste()` sets `state` to `'paste'` and keeps `rawText` (reviews stay in memory but are replaced on the next parse, as today). It does not clear the draft; `persistDraft` on destroy saves state `paste` with the text. For a manual-start roster (no `rawText`) the button is not rendered.
- **Confirm button full width** on phones: add a class so the **ยืนยันรายชื่อ** button spans the container (`width: 100%`), consistent with the group home start action.
- **Textarea label.** The `<label>` that names the paste box (`@@entry.rosterMessage`) gets `for="roster-text"` and the textarea gets `id="roster-text"`.

*Players page (`PlayerRoster`) and levels page (`GroupLevels`):*
- Both back links use the same pattern as the settings detail screen: an `<a class="back">` with a left arrow and the GROUP NAME, at least 44px tall, no underline (`text-decoration: none`, `min-height: var(--tap)`, `display: inline-flex; align-items: center`), targeting the unchanged `back.commands` / `back.queryParams`. Each page loads the group's name with `RosterService.getGroup(groupCode)`. While the name is loading, or if the request fails, show **← กลับ**. The existing disabled-while-editing `<span>` variant on the players page uses the same layout so it does not jump.
- **Players empty state.** When `loaded()` and `players().length === 0`: show the existing explanation, change the link text to **เริ่มรอบแรก →** (new id `@@playerRoster.emptyStartFirst`, retiring `@@playerRoster.emptyStart`), make that link at least 44px tall, and do NOT render the pair-rules disclosure, the "ตั้งชื่อระดับของก๊วน" link, or the bulk-level controls (they have nothing to act on). The populated page is unchanged.
- **Players row description** on group home: change `@@group.row.playersDesc` to **รายชื่อ ระดับ ข้อมูลติดต่อ และกฎการจับคู่** (English: "Names, levels, contact details and pairing rules"). This is the only edit in `group-home.html` for this task.

- [ ] **Step 1: Write the failing tests**

`group-entry.spec.ts`:
- The discard button is rendered AFTER the confirm button in DOM order (`compareDocumentPosition`), is no longer the first button in the review step, and has the label ล้างรายชื่อ.
- Clearing then **undo** restores `rosterReviews`, manual rows (`isManualReview` still true on the restored objects), the date, the court count and the idempotency key; the notice with `role="status"` and `data-undo` is shown after clearing and gone after undo.
- The undo notice disappears after 8 seconds (use fake timers), and `undoDiscard()` afterwards does nothing.
- Undo is unavailable after the host parses again, after `sessionCreated`, and after the component is destroyed (no timer left running).
- `editPaste()`: from a pasted-roster review, goes back to the paste state with `rawText` unchanged, and the draft persisted on destroy has state `paste`; for a manual-start roster the `data-edit-paste` button is absent.
- The confirm button has the full-width class. The label `for` matches the textarea `id`.

`player-roster.spec.ts` / `group-levels.spec.ts`:
- The back link is an `a.back` whose text contains the group name once `getGroup` has answered, shows ← กลับ before it has and when it fails, and keeps its `?settings=` href. (Add the extra `GET /groups/:code` expectation to every existing test setup in those two files, and keep every existing test meaningful.)
- Players empty state: text เริ่มรอบแรก →, the link points at `/g/<code>/start`, and none of the pair-rules disclosure, the levels link, or the bulk-level controls is in the DOM. With players present they all are.

`group-home.spec.ts`: the players row description is the new text.

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd web && npx ng test --watch=false --include=src/app/pages/group-entry/group-entry.spec.ts --include=src/app/pages/player-roster/player-roster.spec.ts --include=src/app/pages/group-levels/group-levels.spec.ts --include=src/app/pages/group-home/group-home.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Implement exactly the decisions above. English targets: ล้างรายชื่อ → "Clear list"; ล้างรายชื่อแล้ว → "List cleared"; เลิกทำ → "Undo"; ← แก้ข้อความที่วาง → "← Edit pasted text"; เริ่มรอบแรก → → "Start first session →"; the players row description as above. The confirm step's logic (fuzzy review, manual add, level picker, idempotency, ladder-stale handling) must not change.

- [ ] **Step 4: Run the tests and the full web suite**

Run the Step 2 command, then the full web suite.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/pages/group-entry web/src/app/pages/player-roster web/src/app/pages/group-levels web/src/app/pages/group-home/group-home.html web/src/app/pages/group-home/group-home.spec.ts web/src/locale/messages.en.xlf
git commit -m "feat(web): roster review clears with undo and an edit-paste escape; players and levels pages name the group"
```

---

### Task 4: A shorter weekly paste path

**Files:**
- Modify: `web/src/app/pages/landing/landing.{html,css,spec.ts}`
- Modify: `web/src/app/pages/group-entry/group-entry.{ts,html,css,spec.ts}`
- Modify: `web/src/locale/messages.en.xlf`

**Decisions (binding):**

*Landing list (`/`):*
- In each of the host's OWN group rows (the rows rendered with `removable`), add a **เริ่มรอบ** link (`data-start-link`) to `['/g', group.code, 'start']` in the existing `.group-actions`, before "ไปรอบล่าสุด". It is at least 44px tall. Other hosts' rows (admin view) do not get it.
- The group-name link in every row gets `display: inline-flex; align-items: center; min-height: var(--tap)`. Nothing else about the landing page changes.

*Roster entry (`/g/:code/start`, paste state):*
- **Autofocus.** When the group has loaded (`groupStatus() === 'ready'`), the state is `paste` and the paste box is empty, focus the textarea once. Do not use `afterNextRender` (the repo documents test races with it; see `core/motion/reveal.directive.ts`). Mirror what `GroupHome.restoreFromQuery` does: set the status, `ChangeDetectorRef.detectChanges()`, then focus synchronously. Never autofocus when a draft was restored, when the state is `confirm`, or when the box already has text.
- **Clipboard button.** Above the textarea, inside the paste card, add a full-width ghost button **วางจากคลิปบอร์ด** (`data-paste-clipboard`, 44px). `pasteFromClipboard()`:
  1. If `navigator.clipboard?.readText` is unavailable, or the permission is denied or the call throws: set a visible `role="status"` message **วางเองในช่องด้านล่างได้เลย** (muted, not an error), focus the textarea, and stop.
  2. If the clipboard text is empty after trimming: message **คลิปบอร์ดว่างอยู่ คัดลอกข้อความรายชื่อจาก LINE ก่อน** and stop.
  3. Otherwise set `rawText` to the text and call `parse()`. Whatever `parse()` reports (no roster found, parse failed) shows exactly as it does for a typed paste.
  Guard double taps with the existing `isParsing()`. The button is disabled while `isParsing()` or when `groupStatus() !== 'ready'`.
- The existing **อ่านรายชื่อ** and **เพิ่มรายชื่อเอง** buttons are unchanged.
- This feature is unverified inside LINE's in-app browser and on iOS Safari (they show a "Paste" callout). Put a short comment saying so next to `pasteFromClipboard`, and rely on the typed-paste fallback.

- [ ] **Step 1: Write the failing tests**

`landing.spec.ts`: each own-group row has `[data-start-link]` with href `/g/<code>/start`; an admin's other-host row has none; the name link has the min-height class (assert the computed class, not pixels).

`group-entry.spec.ts`:
- After the group loads in the paste state with an empty box, `document.activeElement` is the textarea; with a restored draft it is not; with text already in the box it is not.
- Clipboard happy path: stub `navigator.clipboard.readText` to resolve a roster message, call `pasteFromClipboard()`, flush the parse and players requests, and expect `rawText` set, `state` `confirm`, and exactly one parse request.
- Clipboard empty: message shown, no parse request. Clipboard rejected, and `navigator.clipboard` undefined: the fallback status message is shown, the textarea is focused, no parse request.
- A double tap sends one parse request. The button is disabled while parsing and while the group is not ready.

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd web && npx ng test --watch=false --include=src/app/pages/landing/landing.spec.ts --include=src/app/pages/group-entry/group-entry.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Implement exactly the decisions above. English: เริ่มรอบ → "Start session"; วางจากคลิปบอร์ด → "Paste from clipboard"; วางเองในช่องด้านล่างได้เลย → "You can paste into the box below"; คลิปบอร์ดว่างอยู่ คัดลอกข้อความรายชื่อจาก LINE ก่อน → "Clipboard is empty — copy the roster message from LINE first".

- [ ] **Step 4: Run the tests and the full web suite**

Run the Step 2 command, then the full web suite.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/pages/landing web/src/app/pages/group-entry web/src/locale/messages.en.xlf
git commit -m "feat(web): start a session from the group list; paste from the clipboard in one tap; autofocus the paste box"
```

---

### Task 5: Catalogue, docs, spec, and every suite

**Files:**
- Modify: `web/src/locale/messages.xlf` (regenerated) and `messages.en.xlf`
- Modify: `docs/archive/specs/2026-10-13-group-creation-settings-design.md`
- Modify: `docs/overview.md` only if it describes the changed behaviour (the resume link, the discard button, the weekly path)

- [ ] **Step 1: Regenerate and reconcile the catalogue**

Run `cd web && npx ng extract-i18n --format=xlf --output-path=src/locale`. Remove from `messages.en.xlf` every unit whose id is no longer in the regenerated `messages.xlf` (the retired `entry.discardDraft`, `playerRoster.emptyStart`, and any other). Sync every changed `<source>`. Then verify both directions are empty:

```bash
cd web && diff <(grep -o 'trans-unit id="[^"]*"' src/locale/messages.xlf | sort -u) <(grep -o 'trans-unit id="[^"]*"' src/locale/messages.en.xlf | sort -u)
```

Expected: no output. Also check `grep -rn 'นัด' web/src/app --include='*.html' --include='*.ts' | grep -v spec` prints nothing.

- [ ] **Step 2: Update the spec to match what shipped**

In the spec: (a) the **Header resume link** paragraph now describes three states (live card with the green ring, open card without it, ended text link) and that the start action turns ghost only while a session is live; (b) the roster review paragraph gets the discard placement, undo and edit-paste behaviour; (c) a **Weekly path** paragraph describes the landing-row start link, the clipboard button with its fallbacks, and the autofocus, noting the in-app-browser caveat; (d) the settings contents section says the manage row is its own card; (e) add acceptance items for each, unchecked.

- [ ] **Step 3: Run every suite and the builds**

Run `npm test` at the repo root, `cd server && npm run lint`, and `cd web && npm run build`.
Expected: all PASS; the build may show the pre-existing session-dashboard.css budget warning only.

- [ ] **Step 4: Commit**

```bash
git add web/src/locale docs
git commit -m "docs: record UX review fixes in the spec; regenerate the translation catalogue"
```
