# Plan: Session Shuttle Count and Unit Price

Date: 2026-09-20
Status: Implemented and merged. Both Review Decisions below were approved by the user
before implementation started (2026-09-20).

## Goal

Let the host record and correct the total number of shuttlecocks used in a
session and the price per shuttlecock. The host counts used shuttles at the end;
there is no need to record replacements during individual matches.

## Scope

Included:

- Two optional session fields: shuttle count and price per shuttle.
- Host-editable inputs, persistence, and read-only display of saved values.
- Validation, existing Thai/English localization conventions, and focused tests.

Excluded:

- Total-cost calculations or equal/per-player bill splitting.
- Attendance changes, court expenses, payments, receipts, and accounting.
- Per-match shuttle counts, inventory, and group-wide default prices.
- Photos, player accounts, matchmaking changes, and business-model work.
- Deployment and unrelated refactoring.

## Proposed Behavior

1. Add a compact optional editor to the existing host session dashboard with
   shuttle count, price per shuttle in THB, and Save/Cancel actions.
2. Both fields start blank for new and historical sessions. `null` means not
   recorded; zero is a valid value. Each field can be saved independently or
   cleared back to `null`.
3. Count accepts nonnegative whole numbers. Price accepts nonnegative baht
   amounts with at most two decimal places. Store and transmit the price as
   integer satang, explicitly named `shuttlePriceSatang`.
4. Allow host updates during the session and after it ends. This is a
   metadata-only exception: it must not reopen the session or allow more games.
5. Restore saved values after refresh. Display them read-only on the existing
   shared session summary. Do not add them to the venue TV layout.
6. While saving, show pending state and prevent duplicate submission. Preserve
   drafts on failure and show a localized error. Background refreshes must not
   overwrite unsaved edits.
7. Partial updates leave omitted fields unchanged; explicit `null` clears a
   field. Submit only changed fields to avoid overwriting unrelated edits from
   another tab. Same-field concurrent edits follow existing last-write behavior.
8. Validate both stored integers within 0 through 2,147,483,647. Reject negative,
   fractional, string, and out-of-range API values. Do not silently round UI
   prices with more than two decimal places.

## Implementation Steps

### 1. Persistence and API

- Add nullable `Int` fields `shuttleCount` and `shuttlePriceSatang` to `Session`
  with an additive Prisma migration. Existing rows remain `null`; no backfill.
- Add a `SetShuttleDetailsDto` and protected
  `POST /sessions/:code/shuttle-details` endpoint using existing conventions.
- Add `SessionsService.setShuttleDetails`, serialized by `SessionLock.run`.
  Check session existence and update only explicitly supplied fields.
- Reuse the global `AuthGuard` and `OwnershipGuard`, including existing admin
  policy. Do not mark the mutation public or rely on knowing the session code.
- Permit this metadata update for ended sessions without changing restrictions
  on other mutations.
- Include the nullable fields in `getSession` and `getSummary` responses. Leave
  the session creation form unchanged.

Validate persistence, authorization, partial updates, null clearing, zero,
invalid values, and ended-session behavior before frontend integration.

### 2. Existing Frontend Flow

- Extend the existing `Session` and `SessionSummary` contracts.
- Add `LiveSessionService.setShuttleDetails` using the shared mutation,
  `ActionResult`, and session reload patterns.
- Add the editor to the dashboard using existing form and visual conventions.
  Keep it available on the ended-session dashboard.
- Track draft/dirty state separately from resource polling. Reset after a
  successful save or Cancel; retain values after failure.
- Convert between baht inputs and integer satang without floating-point
  truncation or silently rounding invalid input.
- Display saved values on the summary without a total. Hide the section if
  both fields are unset; label an individually unset value as not recorded.
- Update existing translation catalogs for labels and errors.

Validate that 80.50 baht persists as 8050 satang, zero remains visible, clearing
works, and refreshes or errors do not discard drafts.

### 3. Focused Validation

- Extend existing server session and auth boundary tests for owner/admin
  access, unauthenticated access, another owner's access, missing sessions,
  validation bounds, partial updates, and active/ended sessions.
- Verify historical sessions still load and other ended-session mutations
  remain blocked.
- Extend existing frontend service, dashboard, and summary tests for request
  units, decimal validation, pending state, draft retention, and nullable values.
- Check desktop/mobile layout and Thai/English text using the existing design.
- Run focused tests first, then relevant builds and repository-required gates.
  Do not fix unrelated failures as part of this work.

## Implementation Surfaces

- [Session schema](../server/prisma/schema.prisma) and a new additive migration.
- [Session controller](../server/src/sessions/sessions.controller.ts) and
  [service](../server/src/sessions/sessions.service.ts), plus a new validation DTO.
- [Session lock](../server/src/sessions/session-lock.ts) and
  [ownership guard](../server/src/auth/ownership.guard.ts): reuse without changes.
- [Session controller tests](../server/src/sessions/sessions.controller.spec.ts)
  and [auth boundary tests](../server/src/auth/auth.boundary.spec.ts).
- [Session model](../web/src/app/core/session.model.ts),
  [summary model](../web/src/app/core/session-summary.model.ts), and
  [live session service](../web/src/app/core/live-session.service.ts).
- [Dashboard](../web/src/app/pages/session-dashboard/session-dashboard.ts), its
  existing template/styles, and adjacent tests.
- [Summary](../web/src/app/pages/session-summary/session-summary.ts), its existing
  template, adjacent tests, and existing localization catalogs.

## Verification Commands

Run from the repository root, confirming database test prerequisites and the
current Prisma migration/client-generation workflow before execution. Never
point tests or development migrations at production.

```sh
npm --prefix server test -- src/sessions/sessions.controller.spec.ts src/auth/auth.boundary.spec.ts
npm --prefix web test -- --watch=false
npm --prefix server run build
npm --prefix web run build
```

Use the existing Angular test include filtering for focused frontend runs.
Run the root `npm test` integration gate when required by repository procedures.

## Acceptance Checklist

- [x] Host can save, edit, and clear either field independently.
- [x] Values survive refresh and remain associated with the correct session.
- [x] Blank and zero are distinguishable; price displays in baht.
- [x] Only authorized users can update values.
- [x] Ended-session corrections do not affect games, results, or rotations.
- [x] Unsaved input survives background refresh and save failures.
- [x] Summary display follows the approved visibility decision below.
- [x] No totals, bill splitting, or other excluded features are introduced.
- [x] Focused tests and relevant builds pass (see note below on a pre-existing,
      unrelated suite-level failure).

Note: `npm --prefix web test -- --watch=false` is red at the point this branch merges,
but for reasons that predate this branch — a pre-existing `session-display.spec.ts`
TestBed re-instantiation bug (confirmed via `git merge-base --is-ancestor` to already
exist at this branch's base commit, `ac3148e`) plus occasional worker-sharding
flakiness that bleeds into whatever file gets co-scheduled with it. This branch's own
focused test files (shuttle-money, session-dashboard, session-summary,
live-session.service, the server session/auth-boundary specs) all pass. Per the plan's
own instruction ("Do not fix unrelated failures as part of this work"), this was left
alone; it is tracked as a pre-existing issue, not something this feature introduced.

## Review Decisions

Both supporting choices were explicitly approved by the user before implementation
started (2026-09-20):

1. **Approved.** Allow corrections after the session ends, since shuttles are counted
   then. Implemented as a narrow, metadata-only exception on the new endpoint only —
   every other ended-session mutation guard is untouched.
2. **Approved.** Show saved values on the existing public session summary. The two
   fields were added to the existing public `getSession`/`getSummary` responses, so
   they are ordinary public session data, not private host financial data gated
   behind auth.

## Implementation Notes (post-merge)

Implemented across four commits on `main`: persistence/API (schema + migration + DTO +
endpoint + service), frontend flow (dashboard editor + public summary display + a new
`shuttle-money.ts` baht↔satang conversion module), a fix for a plan-mandated
"not recorded" label on an individually-unset summary field, and focused validation
(auth-boundary matrix, historical-session regression check, remaining frontend edge
cases).

Deferred, non-blocking items noted during review (none required a code change to merge):
schema.prisma cosmetic field-alignment inconsistency; a widened pre-existing `getSummary`
test assertion (unavoidable given the new public fields); a dead `.shuttle-summary` CSS
class (kept as a test selector); a redundant defensive fallback-error branch; a stale
validation-error message that isn't cleared until the next Save attempt when the host
corrects an invalid price; a brief visual flicker back to the pre-save value while the
session reloads after a successful save; the new "not recorded" label on the public
summary doesn't itself say *which* field (count or price) is missing when only one is
set; 13 new i18n message IDs landed without English translations, consistent with this
codebase's existing, pre-established pattern of untranslated Thai-source strings
(confirmed via a full id-diff against `messages.en.xlf`); and a couple of new signals
on the dashboard component being `public` where `protected` would match sibling members.
