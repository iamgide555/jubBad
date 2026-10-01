# Host feedback D — reusable numbered shuttles: build + smoke report

Branch `feat/shuttles-d` (not merged, not deployed). Plan:
`docs/superpowers/plans/2026-09-30-reusable-shuttles.md`, spec:
`docs/superpowers/specs/2026-09-30-match-shuttles-design.md`. Written 2026-10-01.

## Bottom line

D works end to end in a real browser against the real API. The core promises
held under a 60-player / 8-court run: a shuttle is never current on two
courts, numbers stay contiguous and are never reused, a shuttle reused across
games counts once, and the bill shares one shuttle's cost once.

Two small UI defects were found in the browser smoke test and fixed. Several
real bugs were caught earlier by the new tests, before any browser test.
Nothing is left open that blocks shipping, but see "Not covered" below.

Suites at the end: engines 279, server 616, web 593, all passing; server
`npm run lint` and `npm run build`, web `ng build` clean.

## What was built (9 plan tasks)

| # | Piece | Result |
|---|---|---|
| 1 | Group switch `shuttleToolsEnabled` snapshotted per session; plus `crossSessionHistory` (replaces the hardcoded constant) | done |
| 2 | `SessionShuttle`, `PairingShuttleUse`, `Pairing.shuttleLogKnown/lastShuttleId`; export; deletion order | done |
| 3 | Confirm with a shuttle choice (atomic), auto-confirm default, undo rules | done |
| 4 | Switch / retire / restore / void / correct (owner-only, revision-guarded) | done |
| 5 | Distinct-used accounting; public log; owner inventory | done |
| 6 | Bill engine: share one shuttle's cost once | done |
| 7 | Bill source selection, `readyToCopy`, consistent read | done |
| 8 | Group page switches; confirm picker; live controls | done |
| 9 | Summary log + owner corrections; bill guard; docs | done |

## Smoke test — what I ran and what I found

Environment: local API + web on the dev DB, real Chrome, light theme (dark
spot-checked), logged in as the dev admin. Seed data was deleted afterwards.

### A. Browser pass, 16-player group, 4 courts

| Check | Result |
|---|---|
| Group page → ตั้งค่าขั้นสูง → tick shuttle tools | Saved on the server; box court-green; history switch stayed independent. **Found S1** (below). |
| New session from that group | `shuttleToolsEnabled: true` snapshotted. A session from a flag-off group got `false`. |
| Fill 4 courts, tap ยืนยัน on court 3 | Picker opened with "open new" selected (no last shuttle yet). **Found S2** (below). |
| Confirm with new shuttle | Court 3 active, "ลูกแบด #1", used [#1]; 3 live controls shown beside the winner buttons |
| Let the other 3 courts auto-confirm | Got #2, #3, #4: distinct, no extra identities |
| "เปิดลูกใหม่" on court 3 | Now #5, used [#1, #5], revision bumped, UI showed #5 |
| "ลูกนี้ใช้ไม่ได้แล้ว" | Picker opened with retire pre-ticked; only idle #1 offered (others were in hands); switched to #1 and retired #5 in one action; #5 stayed in the game's history |
| Finish all, next round, tap ยืนยัน on court 4 | Picker pre-selected "ใช้ลูกเดิมของคอร์ทนี้ #4"; idle chips #1–#3; retired #5 not offered; confirmed with #4: no new identity |
| Next round left to auto-confirm | Each court reused its own last shuttle: identities stayed 5 |
| End session → summary page | 8 chronological rows, "5 ลูก" distinct (not 8), #5 on court 3's first game, 8 edit buttons |
| Correct a game (drop #1, add retired #5) after the session ended | Saved, row updated, dialog closed, distinct total consistent |
| Bill page, inputs missing | Count 5 derived from games; warnings for court fee and shuttle price; per-person amounts hidden; copy disabled with an explanation |
| Bill with court fee 0 and price 10฿ | 5 × 10฿ = 50฿; with physical count 8: 80฿, "นับจริง", difference +3 shown; amounts and copy enabled |
| Ordinary session | One-tap confirm, no dialog, no inventory request, no shuttle UI |
| Venue display of the advanced session | No shuttle information (unchanged, as specified) |
| Dark theme picker | Surface, ink, 22px radius, shadow all correct |

### B. Scale run through the real API, 60 players, 8 courts

6 rounds of fill → 8 parallel manual confirms → live switches (open new,
switch-and-retire, take an idle one, a deliberately stale revision) → finish.

- 48 games, 48 confirms, 30 switches, 6 retirements; whole run under 1s.
- After every confirm and every switch: no shuttle current on two courts;
  identity numbers contiguous 1..N; no duplicate used shuttle in a game;
  every active court's current shuttle is in the held list.
- Stale switch refused every round (409 `PAIRING_STALE`).
- Distinct total 52 = size of the union of all log rows; the naive sum of
  uses was 78, so the reused-once rule was actually exercised (factor 1.5).
- After ending the session: corrections to none, adding a retired shuttle,
  and opening a missed new shuttle all worked; the replayed stale correction
  was refused (409) and left the log unchanged; voiding a referenced shuttle
  refused (`SHUTTLE_IN_USE`).
- Bill for 60 players: derived count 53 → shuttle shares sum to exactly
  53,000 satang; physical count 70 → exactly 70,000; all integers, none
  negative; the read took ~5ms.

One apparent failure in that run ("stale correction accepted") was my script
reusing a freshly read revision; re-run correctly it was refused.

## Defects found and fixed

Caught by the new tests while building:

1. **Switch with no `choice` crashed with a 500.** `@ValidateNested` does not
   require the object to exist. Fixed with `@IsDefined`; HTTP test added.
2. **Picker ignored its defaults when opened.** The court panel set the
   dialog's inputs and opened it in the same tick, so "reuse last" and the
   pre-ticked retire box were computed from stale inputs. Defaults are now
   derived reactively.
3. **Group switch could show an unsaved value after a failed save.** If the
   save failed before change detection ran, the native checkbox stayed
   ticked. The box now never shows an unsaved value.
4. **Wrong shuttle word.** I wrote ลูกขนไก่; the app says ลูกแบด everywhere.
   All new copy aligned.
5. **An error code I added to every failed write broke six exact-shape
   tests.** It is now only present on the writes that need it.
6. **An English string lost its "incomplete" note.** An `@if` inside one
   translated message dropped the conditional part in English; split into two
   messages.
7. **Fixture wording hid a gap:** two courts whose *last* shuttle is the same
   one both auto-confirming. Test added (passed on first run — a guard, not a
   fix).

Found in the browser smoke test:

- **S1.** On the group page "ตั้งค่าขั้นสูง" and "จัดการก๊วน" touched edge to
  edge (the same defect fixed earlier on the dashboard). Now one flex row,
  8px gap, 44px tall — measured after the fix.
- **S2.** The picker title read "เลือกลูกแบด — 3" with no "คอร์ท". Now
  "เลือกลูกแบด — คอร์ท 1" (or the court's label) — confirmed after the fix.

## Rulings I made (details in the ledger)

- Lifecycle tests in a new `shuttle-lifecycle.spec.ts`, not the 270KB
  controller spec.
- A shuttle payload on an ordinary session's confirm is refused (409), not
  ignored.
- 404 for missing/foreign/voided shuttles, 409 for retired or busy.
- Bill read uses one read transaction instead of the session lock.
- Engine receives zero-padded shuttle numbers as opaque ids so remainders
  follow shuttle numbering.
- The owner inventory also returns `heldShuttleIds` and `lastShuttleByCourt`
  (the picker needs them; the plan interface omitted them).
- `CourtState.active.revision` stays optional on the client type to avoid
  touching 23 fixtures; a write without a revision is refused and refreshes.
- Group switches load lazily inside the advanced section.

## Not covered / honest limits

- **Real phone width.** The Chrome window could not be resized, so 320–390px
  layout was checked from the CSS only (wrapping flex rows, 44px targets), not
  on screen. Worth a look on a real phone before relying on it courtside.
- **Auto-confirm racing the picker in a browser.** Unit-tested (the prompt
  closes, the error shows, the session reloads) but I did not time a real
  60-second collision in Chrome.
- **Final whole-branch review was a self-review**, not a fresh reviewer: this
  session only spawns agents on request. It is weaker than an independent
  review; the plan's five review-focus cases each have a test (see ledger).
- **Home server:** this adds **two migrations** (one redefines the `Group`,
  `Session` and `Pairing` tables). Take the DB backup first when deploying.
- Per-shuttle wear, tube inventory, E's early checkout and frozen amounts are
  out of scope here, as the spec says.
