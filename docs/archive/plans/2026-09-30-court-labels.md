# Session Court Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a host name this session's courts for the physical hall without changing numeric court identity, and show those names consistently to players.

**Architecture:** Store nullable per-court label overrides on `Session` as a JSON array, following the existing format/mode storage convention. The locked, authorized server owns normalization and uniqueness; the web resolves names from the same public session/summary data in every display surface. Numeric `courtNumber` remains the only key for pairing, routes, and history.

**Tech Stack:** Prisma/SQLite, NestJS/class-validator, Angular standalone components/signals, Vitest and Angular's `ng test`.

**Spec:** `docs/archive/specs/2026-09-30-court-labels-design.md`

## Global Constraints

- Labels apply to one session only; no group defaults, new dependencies, or changes to the pairing engine.
- `courtNumber` and API route identifiers remain 1-based integers. `Session.courtLabels` is a JSON `(string | null)[]`, index zero = court 1; an unset label displays `String(courtNumber)`.
- Input is a string of at most 30 characters; trim and normalize to Unicode NFC; blank resets; reject line breaks/control characters. Compare effective labels case-insensitively, including numeric defaults, across current and historical/configured courts.
- Label edits work on idle, pending, active, and ended sessions. Retain label overrides across shrink/grow; refuse growth that would create duplicate visible names.
- Keep a 44px-or-larger edit target, Thai source locale plus English translation, public read/host-only write, and the venue display's existing 30-second refresh.
- Historical matches display the current label, not a per-match snapshot. A rejected edit must leave stored labels and pairings unchanged.

## Review Focus

These less-obvious inputs deserve explicit tests in their owning tasks:

1. A syntactically valid JSON object in `courtLabels` must fall back to numeric labels, not crash a poll (Task 1).
2. Decomposed/composed Unicode or a case-only spelling difference must collide as the same visible label (Task 1).
3. Clearing an override to a number already used by another court must reject the write without losing the old name (Task 2).
4. A retired court with past matches but **no prior override** must still be renameable after session end (Tasks 2 and 4).
5. A label resembling HTML must render as literal text, not markup, on public screens and in shared text (Task 5).

## File map

- `server/prisma/schema.prisma` and generated migration: persistent nullable column; `server/src/sessions/court-labels.ts` and `.spec.ts`: parse, normalize, write, collision and editable-range helpers.
- `server/src/sessions/dto/set-court-label.dto.ts`, `sessions.controller.ts`, `sessions.service.ts`, `sessions.controller.spec.ts`: host-only write, count-growth check, public read shapes and integration tests. Existing auth boundary tests introspect all controller routes.
- `web/src/app/core/court-label.ts` and `.spec.ts`, `session.model.ts`, `session-summary.model.ts`, `live-session.service.ts` and `.spec.ts`: shared resolution and typed transport; existing typed fixtures in `court-panel.spec.ts`, `session-dashboard.spec.ts`, `session-display.spec.ts` and `session-summary.spec.ts` gain the new required fields.
- `web/src/app/pages/session-dashboard/court-label-editor/` (component, template, CSS, spec): one reusable edit control; `court-panel/` and `session-dashboard.*`: current/retired placement and shared-text changes.
- `web/src/app/pages/session-display/` (including label-wrapping CSS) and `session-summary/`: public labels; `web/src/locale/messages.en.xlf` (and regenerated source `messages.xlf` if extraction changes it): translations; `docs/overview.md` and the A checklist in `docs/archive/2026-09-27-real-host-feedback.md`: shipped behavior only after implementation.

### Task 1: Persist and resolve court label slots

**Files:**
- Modify: `server/prisma/schema.prisma` (`Session` model)
- Create (Prisma-generated): `server/prisma/migrations/<timestamp>_session_court_labels/migration.sql`
- Create: `server/src/sessions/court-labels.ts`, `server/src/sessions/court-labels.spec.ts`

**Interfaces:**
- Produces `parseCourtLabels(raw: string | null): (string | null)[]`, `normalizeCourtLabel(label: string): string | null`, `withLabelAt(raw: string | null, courtNumber: number, label: string | null): string`, `editableCourtCount(courtCount: number | null, pairings: readonly { courtNumber: number }[], labels: readonly (string | null)[]): number`, and `hasDuplicateCourtLabels(labels: readonly (string | null)[], count: number): boolean`. `withLabelAt` receives the normalized label; validation of target and length belongs to Task 2.

- [x] **Step 1: Write failing tests** in `court-labels.spec.ts`: null, malformed JSON, and valid non-array JSON (`'{"1":"A"}'`) parse to `[]`; invalid array entries read as null; NFC/trim/blank normalization; writing court 3 preserves court 1 and pads gaps with null; editable range includes a pairing on retired court 3 or a non-null override there, not just array padding; `hasDuplicateCourtLabels(['A','a'], 2)` and composed/decomposed Unicode collide, and `['2', null]` collides with court 2's default.
- [x] **Step 2: Run red test:** `cd server && npx vitest run src/sessions/court-labels.spec.ts`. Expected: FAIL (module/functions missing).
- [x] **Step 3: Add nullable `courtLabels String?` to `Session`; generate/apply migration with `cd server && npx prisma migrate dev --name session_court_labels`; implement the five helper signatures** in `court-labels.ts`. Ignore malformed stored settings on read like `court-formats.ts`, but do not silently accept malformed input to the write endpoint. Preserve overrides when writing another slot or when a court count changes; effective name for an unset slot is its decimal number.
- [x] **Step 4: Run green test:** `cd server && npx vitest run src/sessions/court-labels.spec.ts`. Expected: PASS.
- [x] **Step 5: Commit** schema, the exact generated migration, helper and tests; stage only these paths/hunks, then `git commit -m "feat(server): persist per-session court labels"`.

### Task 2: Expose labels and enforce server-side edits

**Files:**
- Create: `server/src/sessions/dto/set-court-label.dto.ts`
- Modify: `server/src/sessions/sessions.controller.ts`, `server/src/sessions/sessions.service.ts`, `server/src/sessions/sessions.controller.spec.ts`

**Interfaces:**
- Consumes Task 1 helper signatures and `Session.courtLabels`.
- Produces `SessionsService.setCourtLabel(code: string, courtNumber: number, dto: SetCourtLabelDto)` behind `POST :code/courts/:n/label` with `{ label: string }`; public `getSession` adds `courtLabels: (string | null)[]` and `editableCourtCount: number`; public `getSummary().session` adds `courtLabels: (string | null)[]`. The error code for duplicate effective names is `COURT_LABEL_CONFLICT` (409); invalid court number uses `INVALID_COURT_NUMBER`.

- [x] **Step 1: Add failing API tests** named `court label ...` in `sessions.controller.spec.ts`: old session reads `courtLabels: []`; a host writes `"  โซนหน้า  "` to court 1 and subsequent session/summary reads show `โซนหน้า` while `Pairing.courtNumber` stays 1; duplicate `"2"` on court 1 of a two-court session gets 409; case/Unicode duplicates, multiline/over-30/non-string payloads, and out-of-range target are rejected; two independent writes retain both slots; ended-session rename works; after a finished match on court 3 and shrink to 2, `editableCourtCount` is 3 and court 3 can be renamed even if never previously labeled. Explicitly test clearing court 1 to its default while court 2 is labeled `"1"` returns 409 and leaves court 1's former override intact. A court 1 label `"3"` on a two-court session must make growing to three return 409 without changing `courtCount`; shrinking and re-growing a court with its own saved non-colliding label restores it.
- [x] **Step 2: Run red tests:** `cd server && npx vitest run src/sessions/sessions.controller.spec.ts -t "court label"`. Expected: FAIL on absent endpoint/response fields.
- [x] **Step 3: Implement DTO, controller route and locked `setCourtLabel`**. Use existing ownership guard and DTO validation; for writes, compute the editable range from current count, all pairing court numbers, and non-null overrides, then reject collisions before updating only `courtLabels`. In `setCourtCountExclusively`, check the proposed expanded range under the existing lock and refuse conflicts without updating `courtCount`. Extend `getSession`/`getSummary` without changing `courts` length or match keys. Test authorization through the existing generic `server/src/auth/auth.boundary.spec.ts` route sweep, not an admin-only test fixture.
- [x] **Step 4: Run green tests:** `cd server && npx vitest run src/sessions/court-labels.spec.ts src/sessions/sessions.controller.spec.ts -t "court label|court count"`, then `cd server && npx vitest run src/auth/auth.boundary.spec.ts` so the complete anonymous/ownership route sweep sees the new endpoint. Expected: PASS; also run `cd server && npm run build` to catch Prisma/generated types.
- [x] **Step 5: Commit:** stage only the DTO, controller, service and test hunks owned by this feature, then `git commit -m "feat(server): validate and publish court labels"`.

### Task 3: Type and transport label data in Angular

**Files:**
- Create: `web/src/app/core/court-label.ts`, `web/src/app/core/court-label.spec.ts`
- Modify: `web/src/app/core/session.model.ts`, `web/src/app/core/session-summary.model.ts`, `web/src/app/core/live-session.service.ts`, `web/src/app/core/live-session.service.spec.ts`
- Modify typed fixture builders in `web/src/app/pages/session-dashboard/court-panel/court-panel.spec.ts`, `web/src/app/pages/session-dashboard/session-dashboard.spec.ts`, `web/src/app/pages/session-display/session-display.spec.ts`, `web/src/app/pages/session-summary/session-summary.spec.ts` to include `courtLabels: []` and (for `Session` only) `editableCourtCount`.

**Interfaces:**
- Consumes Task 2 response fields.
- Produces `labelForCourt(labels: readonly (string | null)[], courtNumber: number): string` and `LiveSessionService.setCourtLabel(courtNumber: number, label: string): Promise<ActionResult>`. The `Session` type gains `courtLabels` and `editableCourtCount`; `SessionSummary.session` gains `courtLabels`.

- [x] **Step 1: Write failing tests:** `labelForCourt(['A'], 1) === 'A'`, `labelForCourt([], 3) === '3'`, and a `setCourtLabel(2, 'สนาม A')` service test asserts POST body/path, refresh on success, and a localized `COURT_LABEL_CONFLICT` message on 409.
- [x] **Step 2: Run red tests:** `cd web && npx ng test --watch=false --include=src/app/core/court-label.spec.ts --include=src/app/core/live-session.service.spec.ts`. Expected: FAIL on missing helper/action.
- [x] **Step 3: Add the helper, typed fields, fixtures and action** using the service's existing `post` and `messageForCode` path; do not replace numeric route identifiers or include labels on player records. Add Thai `err.code.courtLabelConflict` and action fallback `err.courtLabel` with matching English XLF translations in Task 4.
- [x] **Step 4: Run green tests:** same `ng test --include` command. Expected: PASS.
- [x] **Step 5: Commit:** stage the exact core files and fixture-only hunks listed above, then `git commit -m "feat(web): type court labels and post edits"`.

### Task 4: Edit current and retired courts

**Files:**
- Create: `web/src/app/pages/session-dashboard/court-label-editor/court-label-editor.{ts,html,css,spec.ts}`
- Modify: `web/src/app/pages/session-dashboard/court-panel/court-panel.{ts,html,css,spec.ts}`, `web/src/app/pages/session-dashboard/session-dashboard.{ts,html,spec.ts}`, `web/src/locale/messages.en.xlf` and source catalog if extraction updates it

**Interfaces:**
- Consumes Task 3 `labelForCourt`, `setCourtLabel`, typed `courtLabels` and `editableCourtCount`.
- Produces `CourtLabelEditor` with required `courtNumber: number` and `labels: readonly (string | null)[]` inputs; it owns edit/draft/busy/error state and calls the shared service. The dashboard computes retired slots `(courtCount + 1)..editableCourtCount` only for the ended-session label list.

- [x] **Step 1: Write failing UI tests** for opening/editing/saving a custom name on an active court; blank save sends `label: ''` and displays the number on refresh; cancel makes no request; a 409 keeps the draft and shows localized error; buttons and input have accessible names and edit target at least 44px. Test an ended dashboard with `courtCount: 1`, `editableCourtCount: 3` and no previous label for court 3: its retired editor is visible and posts to `/courts/3/label`.
- [x] **Step 2: Run red tests:** `cd web && npx ng test --watch=false --include=src/app/pages/session-dashboard/court-label-editor/court-label-editor.spec.ts --include=src/app/pages/session-dashboard/court-panel/court-panel.spec.ts --include=src/app/pages/session-dashboard/session-dashboard.spec.ts`. Expected: FAIL (missing editor/behavior).
- [x] **Step 3: Build the reusable editor and place it in current headings and the ended-session retired list**. Preserve numeric IDs for score inputs, court state, and all actions; use the supplied effective label for heading text. Keep edit available in all lifecycle states, 44px targets and one-line text input; do not clear a rejected draft. Let a 30-character unbroken heading wrap within its panel rather than pushing the other controls offscreen. Add stable Thai `$localize` IDs and English XLF targets for editor controls and Task 3 error messages. Extract source XLF with `npx ng extract-i18n --format=xlf --output-path=src/locale` only if needed; review the diff to avoid unrelated catalog churn.
- [x] **Step 4: Run green tests:** same three `ng test --include` selectors. Expected: PASS.
- [x] **Step 5: Commit** only the editor, court-panel, dashboard UI, and localization hunks: `git commit -m "feat(web): rename live and retired courts"` after staging those changes.

### Task 5: Propagate names to every reader and finish documentation

**Files:**
- Modify: `web/src/app/pages/session-dashboard/session-dashboard.{ts,spec.ts}`, `web/src/app/pages/session-display/session-display.{ts,html,css,spec.ts}`, `web/src/app/pages/session-summary/session-summary.{ts,html,spec.ts}`, `docs/overview.md`, `docs/archive/2026-09-27-real-host-feedback.md`

**Interfaces:**
- Consumes Task 3 `labelForCourt` and the response fields; produces no new domain state. Match lists keep `courtNumber` for identity/order.

- [x] **Step 1: Write failing reader tests:** renamed active and idle courts use the same label in copy-to-LINE text and display, default name stays numeric, and an old match on a removed court renders the latest label in the summary. With label `"<b>A</b>"`, the display and summary show that literal text, have no injected `<b>` element, and copied text retains the literal string.
- [x] **Step 2: Run red tests:** `cd web && npx ng test --watch=false --include=src/app/pages/session-dashboard/session-dashboard.spec.ts --include=src/app/pages/session-display/session-display.spec.ts --include=src/app/pages/session-summary/session-summary.spec.ts`. Expected: FAIL on numeric output.
- [x] **Step 3: Resolve display, share and summary names through `labelForCourt`** without touching route numbers or match keys. Preserve the venue display's 30-second poll and existing Thai/English court-prefix translations. Let a long unbroken `.court-number` wrap without expanding the grid or obscuring player names.
- [x] **Step 4: Run green tests and builds:** same three selectors; `cd web && npm run build`; `cd server && npm run build`. Expected: PASS. Visually check a 30-character unbroken label at 320px and 1280x720: no horizontal overflow or clipped court/player text. If a targeted test reveals a related failure, fix it in the owning task's code before moving on.
- [x] **Step 5: Document shipped behavior** in `docs/overview.md`; change only host-feedback A's checkbox to `- [x]` and add a done note in `docs/archive/2026-09-27-real-host-feedback.md`. Do not archive that living backlog while C–F remain open.
- [x] **Step 6: Commit** only reader/test/doc hunks owned by this feature: `git commit -m "feat: show court names everywhere"` after selective staging. If the host-feedback file is still untracked (as at planning time), ask its owner before staging its entire existing content; do not silently commit unrelated work.

At execution time, read the spec and respect the existing dirty worktree: integrate unrelated edits without reverting them; stage only feature-owned hunks. Do not mark this plan's boxes complete until the respective tests and commits are real.
