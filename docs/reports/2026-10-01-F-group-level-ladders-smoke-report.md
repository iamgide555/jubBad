# Host feedback F — group-owned level ladders: build + smoke report

Branch `feat/level-ladders-f`, **based on `main`** (F is independent of D and E).
Not merged, not deployed. Plan: `docs/superpowers/plans/2026-09-30-group-level-ladders.md`,
spec: `docs/superpowers/specs/2026-09-30-group-level-ladders-design.md`. Written 2026-10-01.

## Bottom line

Each group can keep the built-in BG..B ladder or define 1–16 of its own levels with
its own starting Elo. At 60 players and 8 courts, **no ladder operation moved a
single rating**: switching to custom, renaming and swapping two names in one save,
reordering, editing a seed, and resetting all left both rating tracks identical.
Level-mode pairing followed the group's order (8/8 courts inside the ±1 band).

**I did not run a browser pass** (no login available in this unattended run). The
editor and the four pickers are covered by component tests only — see "Not covered".

Suites at the end: engines 287, server 587 (includes the new scale smoke), web 548,
all passing; server `lint` + `build`, web `ng build` clean.

**Merge note:** the F migration is hand-written plain `ADD COLUMN`s (not a Prisma
table rebuild) specifically so it merges safely after D's migrations. Deploying needs a
DB backup first, as always with a migration; it also backfills `Player.levelSeed`.

## What was built (7 plan tasks)

| # | Piece | Result |
|---|---|---|
| 1 | Pure ordered-level helpers: ladder-aware index/seed/band/carry, validation, centered 100-point seeds | done |
| 2 | `Group.levelLadder/levelLadderRevision`, `Player.levelSeed`; migration + backfill; rating replay reads the frozen seed; strict parser; owner export | done |
| 3 | Owner-only `GET/PUT /groups/:code/levels` (customize / edit / reset), revision-checked, blocked by any open session, group-scoped lock | done |
| 4 | Every level write validated against the group's ladder + revision (player edit, one-field edit, roster review, walk-in, panel) | done |
| 5 | Pairing engine and server read the group's ladder for band, carry, scoring and host reads | done |
| 6 | Owner-only ladder editor page, linked from the group and roster pages | done |
| 7 | All pickers use the group's levels; sorting by its order; revision sent; docs | done |

## Smoke test — what I ran and what I found

`server/src/sessions/smoke-f.spec.ts` (kept in the repo). Real API + SQLite, 60 players
tagged across the built-in ladder, 60 finished matches (doubles and singles, mixed
winners) so both rating tracks are non-trivial.

| Check | Result |
|---|---|
| Switch to a six-level custom ladder | 19 ms; all 60 labels cleared; **ratings identical** on both tracks |
| Tag all 60 from the custom ladder, each carrying its revision | 47 ms for 60 writes; counts add to 60 |
| Rename + swap two names in one save, edit a seed | Every player's label followed its level id (swap lost nobody); ratings identical |
| Reorder (reverse the rungs, re-space seeds) | ratings identical |
| Open session, then try to reset | 409 `LEVEL_LADDER_ACTIVE_SESSION` |
| Level-mode fill of 8 courts on the custom ladder | 400 ms; **8/8 courts inside the ±1 band** by the group's order |
| 30 assignments racing a rename | rename won every time here, so 30 were refused as stale; 0 orphan labels |
| Reset to standard | labels cleared; ratings identical |
| Owner export | effective ladder, mode, and every player's saved seed |
| Public group / player list / stats | no level, seed or ladder anywhere |

### Found and fixed during the build (none reached a user)

| # | Found by | What | Fix |
|---|---|---|---|
| F1 | design review | A generated migration rebuilds `Group` and would drop D's new columns if merged after D | hand-written `ADD COLUMN` migration |
| F2 | my own test | A moved level keeps its own seed, so a naive reorder leaves seeds out of order | UI flags it; seeds are re-spaced by the host or the "space 100 apart" button |
| F3 | existing specs | New level reads/writes broke specs that assert no stray HTTP | drained in those specs; new tests for the new behavior |
| F4 | review of the spec | A contact-only player edit used to clear the tag (absent `level` read as null) | an absent `level` now leaves the tag alone |
| F5 | process | `task-done` was wrapped in a grep that hid one red run | re-verified with 10 clean full runs; later tasks use the real exit code |

Mutation checks (deliberately breaking a guard to see tests fail): dropping the
open-session guard failed 2 tests, the editor's revision guard 1, the assignment
revision gate and the unknown-name gate 5 and 4.

## Behaviours worth your eye

1. **Seeds do not move with a level.** Moving a level up or down keeps its id, name
   and seed, so the host must re-space seeds for the order to be valid. The editor
   says so and offers one tap to space them 100 apart.
2. **The first switch clears labels, not ratings.** The confirm dialog states the
   number of players affected. After switching, every player needs a level assigned
   again; their earned Elo stays.
3. **Any unfinished session blocks editing**, including one nobody started. A host
   who left a stale session open must end it first.
4. **The web client now sends a ladder revision with every level choice**, so an old
   browser tab is refused rather than re-applying a cleared label.

## Not covered

- **No real-browser pass for F** (no login in this unattended run). Worth a look on a
  phone: the editor's rows (name + Elo + up/down/remove all at 44 px), the confirm
  dialog, and the compact pickers in the roster table and dashboard panel.
- The race test could not make an assignment win before the rename (the rename always
  started first); ordering coverage comes from the unit race test, which accepts either
  order and checks the invariant.
- The final review of the branch is a self-review (no fresh reviewer dispatched).
