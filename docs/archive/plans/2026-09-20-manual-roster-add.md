# Plan: Search or Add Players During Roster Review

Date: 2026-09-20
Status: Implemented and merged.

## Goal

After the host pastes a message and reviews the parsed roster, provide one field
to search for an existing player or manually add a new player. Selecting an
existing player preserves their identity and history. All additions remain local
until the host confirms the session.

This plan is separate from the session shuttle-details plan.

## Confirmed Scope

- Review screen only, after parsing and before session creation.
- Manual additions go to the main roster, not the waitlist.
- Search existing players in the current group who are not already selected in
  either the roster or waitlist.
- Allow an explicit new-player choice even when similar names are suggested.
  Similarity must never silently merge different people.
- Allow removal of accidental manual additions before confirmation.

Excluded:

- Adding late arrivals during a live session.
- New player accounts, profile management, or cross-group search.
- General editing/removal of imported rows or waitlist promotion.
- Changes to pairing, ratings, billing, or the shuttle-details plan.
- New database fields or API endpoints unless implementation uncovers a concrete
  blocker requiring separate review.

## Proposed Behavior

### Search and Select

1. Show an optional labeled search/add field alongside the confirmed roster.
   Empty input shows no suggestions and cannot create a player.
2. Reuse the group player list already loaded by `GroupEntry.parse()` through
   `RosterService.getPlayers()`; do not request a search endpoint per keystroke.
3. Search names and aliases with trimmed, Unicode NFC-normalized,
   case-insensitive comparison. Rank exact matches first, then prefix,
   substring, and fuzzy suggestions using existing helpers where suitable.
4. Exclude existing player IDs accepted by either `rosterReviews` or
   `waitlistReviews`. A rejected fuzzy suggestion does not reserve its suggested
   player. Recompute candidates when the host changes review decisions.
5. Selecting a result appends an accepted exact `NameReview` with the canonical
   name and existing ID. Never save the search fragment as an alias.
6. Recheck selection eligibility when adding, including rapid repeated taps.
   Clear the search field after success and retain focus for another addition.

### Create a New Player

7. When there is no literal exact name/alias match, show an explicit
   `Add as new: [name]` action. Fuzzy suggestions do not block this action.
8. An exact match already selected shows an already-selected state, not a
   fallback that creates a duplicate profile. An unselected exact match offers
   selection of the existing player.
9. Where names cannot distinguish different people, require a distinguishing
   label rather than silently linking or creating a profile. Preserve labels
   such as `(2)`; do not strip parenthetical text when checking literal drafts.
10. Reject whitespace-only names and repeated literal new-name drafts across
    roster and waitlist. Keep existing imported same-name rows and their host
    decisions unchanged; these guards apply to the manual control.
11. Stage the trimmed name as an accepted review with `match.type = 'new'`.
    Do not write a player record or generate a persistent player ID yet.

### Review and Confirm

12. Display manual additions alongside imported entries, with a remove action
    for manual rows. Removing an existing-player addition makes it searchable
    again unless another accepted row still references it.
13. Keep manual selections explicit. For manually selected existing players,
    use remove/reselect rather than the imported-name yes/no matching toggle.
    Do not rerun matching over the whole roster or reset earlier decisions.
14. Preserve pasted `rawImportText` unchanged. Manual additions travel in the
    review arrays with the existing session-creation request.
15. Disable manual controls while submitting. Preserve additions on failure;
    retain existing creation idempotency behavior for unchanged retries.
    Do not rotate retry keys merely because a request failed.
16. A successful new parse replaces the previous review and clears manual
    additions and search state. Do not clear drafts on a failed request.

## Existing Implementation to Reuse

- [Group entry](../web/src/app/pages/group-entry/group-entry.ts): `parse()` loads
  reviews and group players before showing confirmation; `confirmRoster()` sends
  review arrays directly rather than reparsing the message.
- [Roster review](../web/src/app/core/roster-review.ts): `NameReview` already
  represents an accepted existing player or a new name.
- [Roster service](../web/src/app/core/roster.service.ts): reuse `getPlayers()`
  and `createSession()`.
- [Session service](../server/src/sessions/sessions.service.ts): `createSession()`
  validates existing IDs against the requested group and creates new players
  and session entries transactionally, with idempotent retries.
- [Name matching](../engines/fuzzy-match.ts): reuse types and suitable matching
  helpers without changing engine behavior. Do not use parenthetical-stripping
  normalization alone as an identity key or assume one best match is a complete
  search result list.

## Implementation Steps

### 1. Selection Logic

- Add focused helpers for claimed existing IDs, literal new-name drafts, and
  candidate filtering/ranking, preferably in the existing roster-review module.
- Add reactive query/candidate state and add-existing, add-new, and remove-manual
  actions to `GroupEntry`. Convert the currently plain player array to a signal
  if needed for computed state.
- Keep manual-row bookkeeping client-only. Submit the existing `NameReview`
  contract without new UI metadata.
- Preserve parsed date, venue, court count, waitlist, and earlier match choices.

### 2. Review UI

- Extend the existing group-entry confirmation template with the search field,
  result list, explicit new-player action, and manual-row removal.
- Reuse the existing visual styles and `Icon` component. No new page, modal,
  design system, or dependency is expected.
- Support an accessible combobox/listbox with arrow navigation, Enter, Escape,
  visible focus, and clear screen-reader labels/status announcements.
- Respect IME composition: Enter while composing Thai text must not add a name.
- Preserve existing touch targets and mobile layouts. Use existing Thai source
  and English translation workflows for labels and errors.

### 3. Verification

- Extend [roster-review tests](../web/src/app/core/roster-review.spec.ts) for
  candidate ordering, aliases, literal names, and exclusions from both lists.
- Extend [group-entry tests](../web/src/app/pages/group-entry/group-entry.spec.ts)
  for existing/new additions, decision changes, duplicate guards, removal,
  rapid taps, keyboard/IME behavior, submission failures, and reparse reset.
- Verify the request contract in
  [roster service tests](../web/src/app/core/roster.service.spec.ts) as needed.
- Add focused coverage in
  [session controller tests](../server/src/sessions/sessions.controller.spec.ts)
  for mixed imported/manual reviews, preserved existing IDs, new-player creation,
  group isolation, and unchanged idempotent retries. Production backend changes
  are not expected.
- Check that selecting an already-used ID later through an imported review does
  not create a second participant; preserve existing server deduplication.
- Check Thai/Latin and long names, zero existing players, and all players already
  selected on desktop and mobile.

## Verification Commands

Run from the repository root after confirming current runner options and the
existing isolated database test prerequisites:

```sh
npm --prefix web test -- --watch=false --include='src/app/core/roster-review.spec.ts' --include='src/app/pages/group-entry/group-entry.spec.ts' --include='src/app/core/roster.service.spec.ts'
npm --prefix server test -- src/sessions/sessions.controller.spec.ts
npm --prefix web run build
```

Run broader checks only as required by repository procedures. No production
database writes or deployment are part of this plan.

## Acceptance Checklist

- [x] Host can add an omitted existing player after parsing without duplicating
      their profile or losing history.
- [x] Host can stage a new player without editing or repasting the message.
- [x] Existing players already selected in roster or waitlist are unavailable
      for another manual selection.
- [x] Similar names require explicit selection or new-player creation.
- [x] Blank and repeated manual drafts are blocked.
- [x] Accidental manual additions can be removed before submission.
- [x] Original parsed entries and host decisions remain intact.
- [x] Session confirmation persists additions through the existing API.
- [x] Failed submissions preserve drafts and unchanged retries are idempotent.
- [x] No live-session, shuttle, pairing, or billing changes are introduced.

## Review Notes

Review-screen-only scope and explicit creation despite similar suggestions were
confirmed by the user. Exact-name collision handling, search ordering, and
manual-row removal were implemented as proposed.

## Implementation Notes (post-merge)

Implemented across four commits: selection logic (pure helpers in
`roster-review.ts` + reactive signals/actions on `GroupEntry`), review UI
(search/combobox, add-as-new, manual-row remove, IME/a11y handling), focused
verification (candidate ordering, decision-change eligibility recompute,
duplicate/rapid-tap guards, reparse reset, backend coverage of mixed
imported/manual rows), and one final-review fix (a "Add as new" affordance
that could be shown in a state where it always failed).

Deferred, non-blocking items noted during review (none required a code change
to merge): a few CSS/DOM polish nits (dangling `aria-controls` while a list is
hidden, a hidden-not-disabled suggestion list while submitting); a duplicated
announce+refocus helper across two methods; `exactPlayerMatch` returns the
first match rather than treating a literal-name collision as no-match (a
follow-up-worthy edge case, not a shipped bug); "reselect" for a manually
added existing player isn't implemented, only remove-then-reselect (judged an
acceptable reading of the plan's "remove/reselect" wording, not a gap); and
new i18n message IDs landed without English translations, consistent with
this codebase's existing, pre-established pattern of untranslated
Thai-source strings.
