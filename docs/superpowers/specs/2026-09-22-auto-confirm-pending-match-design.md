# Auto-confirm a pending match — design

Status: Draft for the owner's review, 2026-09-22. Nothing built yet.
Branch for the build: `feat/auto-confirm-pending`, cut from `main`.

**Goal:** A proposed match that nobody touches for 60 seconds starts by
itself, and its timer reads as if play began 30 seconds after the lineup was
settled, so it shows about 30 s when the court flips to active. The host no
longer has to remember to tap ยืนยัน.

## Problem

The TV display shows a pending court's lineup, so players walk on and start
playing. The host often never taps confirm. Nothing records a start time until
someone does, and today that usually happens only when the game is over: the
host needs to record the result, `finish` refuses with
`PAIRING_CONFIRMATION_REQUIRED`, so they confirm and then finish straight
away. The live timer never ran, and the summary's per-match duration
(`endedAt − confirmedAt`, `SessionsService.getSummary`) comes out at about 0.

## Decisions log (owner, 2026-09-22)

| # | Decision |
|---|---|
| D1 | The delay is 60 s after the pending match last changed. |
| D2 | The countdown shows on the host dashboard only, not on the TV display. |
| D3 | Custom mode is included once every seat is filled. |
| D4 | Always on. No per-session or per-group switch. |
| D5 | An auto-start sets `confirmedAt = pendingSince + 30 s`. Players need time to read the lineup, check with the host and walk on, so the timer shows about 30 s at the moment of auto-start rather than the full 60 s. |

Anything marked "default" below was proposed, not asked. It is the first thing
to revisit if review turns up a reason to.

## Grounding facts (checked in code)

- A court is pending when its open `Pairing` has `confirmedAt = null`, and
  active once it is set. The live timer is `startedAt = confirmedAt`
  (`sessions.service.ts` `getSession`).
- Every write to a pending pairing bumps `revision`. `Pairing` has no
  timestamp for when it last changed.
- Confirm refuses an empty seat (`PAIRING_INCOMPLETE`) and a resting player
  (`PLAYER_UNAVAILABLE`), in `confirmPairingExclusively`.
- Undo on a confirmed court sets `confirmedAt` back to null
  (`undoExclusively`, the `'confirm'` branch).
- All session writes go through the in-process `SessionLock` (single API
  container).
- The dashboard refreshes every 30 s and on window focus
  (`session-dashboard.ts`). A locked phone suspends JS timers.
- The court panel already knows `restingInProposal()` and
  `emptySeatCount()` for a pending court, and ticks once a second through
  `ClockService`.
- `endSession` refuses while any pairing is unfinished, pending included.

---

## 1. Data

New nullable column on `Pairing`:

```prisma
/// When this pending pairing last changed. The auto-confirm delay counts
/// from here, and an auto-confirm sets `confirmedAt` to 30 s after it. Null means
/// auto-confirm is off for this pairing: a confirm that was undone, or a row
/// written before this column existed.
pendingSince DateTime?
```

Migration `<timestamp>_add_pairing_pending_since`, which only adds the column
(no backfill). Pending rows that exist at deploy time keep `null` and never
auto-confirm. That is intended: nobody should see a court from before the
deploy suddenly start.

## 2. When `pendingSince` changes

The rule is that `pendingSince` records the last time anything changed that
decides whether this lineup can start.

**Set to now:**

| Write | Where |
|---|---|
| Propose / reshuffle (create or replace) | `upsertPendingPairing` |
| Fill all idle courts (both custom and engine branches) | `fillExclusively` |
| Swap, rotation's pick | `swapPlayerExclusively` |
| Swap with a chosen player, on **both** rows when it trades with another pending court | `swapWithChosenPlayer` |
| Seat edit (custom mode) | `setSeatExclusively` |
| Fill empty seats | `autoPairExclusively` (only when it writes) |
| A player is rested or brought back: every pending pairing that seats them | `setRosterActiveExclusively` |

The roster row is there so that reactivating a player on a court that has sat
pending for 10 minutes doesn't start the match instantly with a 10-minute
timer.

**Set to null:** undoing a confirm (`undoExclusively`, `'confirm'` branch).
This is how "undo turns auto off" works. *Default:* any later edit to that
court sets it again, so the countdown comes back once the host changes the
lineup. If the host undoes and then leaves the lineup as it is, they confirm
by hand.

**Not touched:** confirm, finish, undo-finish, and undo-propose (which deletes
the row).

**Every session route, checked** (`sessions.controller.ts`, plus the one
pairing write outside it):

| Route | Effect on a pending match |
|---|---|
| `POST /sessions` | Creates no pairings. |
| `courts/fill`, `courts/:n/propose`, `pairings/:id/swap`, `…/seats`, `…/autopair` | Set `pendingSince` (table above). |
| `roster/:playerId/active` | Sets it on the player's pending pairings (table above). |
| `courts/:n/undo` | Confirm branch clears it. The propose branch deletes the row. The finish branch doesn't touch a pending match. |
| `pairings/:id/confirm`, `…/finish` | Only act on the pairing they name. The sweep's revision guard handles a race. |
| `courts/:n/format` | Idle courts only (`COURT_ACTIVE` otherwise). |
| `court-count` | Refuses to shrink below a court holding any open pairing (`COURT_IN_USE`), so a pending match can never sit on a court the dashboard doesn't show. |
| `mode` | Never rewrites a pending pairing, and eligibility doesn't depend on mode. |
| `roster/deprioritize-waiting` | Writes `gamesOffset` only. |
| `end` | Refuses while any pairing is open, pending included. |
| `shuttle-details` | Session metadata only. |
| `GroupsService.buildDeleteGroupOps` | Deletes pairings without the session lock. The sweep must treat a vanished row as a skip (section 3). |

## 3. The server sweep

The server does this, not the browser, because hosts lock their phones.

**`SessionsService.autoConfirmDue(now = new Date())`**

1. Finds pairings where `confirmedAt = null`, `endedAt = null`,
   `pendingSince ≤ now − 60 s` and the session has not ended.
2. Groups them by session. For each pairing, inside
   `lock.run(sessionId, …)`:
   - re-reads the row, and skips it if it has been confirmed or ended, or if
     its `revision` or `pendingSince` differs from what step 1 read (an edit
     landed in between);
   - skips it if any seat is empty or any player on it is resting. It stays
     pending, and the host sees the usual reason on the dashboard;
   - otherwise writes `confirmedAt = pendingSince + 30 s` and `revision + 1`,
     with the same `{ id, confirmedAt: null, endedAt: null, revision }` guard
     as a manual confirm.
3. Returns the ids it confirmed (for tests and one log line).

Failure handling inside the sweep:

- A row that vanishes between the query and the write (a group deleted in
  between) is a skip. `findUnique` returns null or `updateMany` returns count
  0, and neither throws.
- Each row runs in its own try/catch. A corrupt row (`INVALID_SESSION_STATE`
  from the seat parse) is logged and skipped, and doesn't stop the rows after
  it.

No index is added. The query filters on `confirmedAt IS NULL` over a
`Pairing` table of a few thousand rows every 5 s, which is trivial for
SQLite. Revisit if `Pairing` passes about 100k rows.

The empty-seat and resting-player checks move into one small helper that
both `confirmPairingExclusively` (which throws) and the sweep (which skips)
call, so the two can't drift apart.

**Backdating (D5):** `confirmedAt = pendingSince + 30 s`, not now. That is
the estimate of when play actually began: the lineup was settled, then
players took about 30 s to read it, check with the host and walk on. At the
normal auto-start moment (60 s after `pendingSince`) the timer shows about
30 s.

It is anchored to `pendingSince`, not written as "now − 30 s", on purpose.
The sweep can run a few seconds late, or much later after an API restart, and
an anchor that moved with the sweep would put that lateness into the match
time. A manual confirm keeps `confirmedAt = now`, as today.

**`AutoConfirmScheduler`**, in a new `AutoConfirmModule` that imports
`SessionsModule` (which now exports `SessionsService`) and is registered only
in `AppModule`.

It gets its own module because the session specs build their test app from
`SessionsModule` directly and share one test database per run. A background
sweep inside those apps would race the specs that create a backdated pending
row on purpose, confirming it before the spec's own `autoConfirmDue()` call
or its "still pending" assertion. With the scheduler outside
`SessionsModule`, those specs have no background sweep and call
`autoConfirmDue()` themselves. The two specs that boot `AppModule`
(`auth.boundary.spec.ts`, `admin.spec.ts`) do get the timer, which is
harmless: it is `unref()`'d, stopped on `app.close()`, and they never create
a pending row 60 s old.

The scheduler:

- On `onApplicationBootstrap`, starts a `setInterval` of 5 s (*default*)
  calling `autoConfirmDue()`. The interval is `unref()`'d so it never holds
  the process or a test run open.
- On `onModuleDestroy`, clears it.
- Skips a tick if the previous one is still running, and catches and logs
  errors so one bad row can't stop the loop.
- No new dependency. Plain `setInterval`, not `@nestjs/schedule`.

`AUTO_CONFIRM_DELAY_MS = 60_000`, `AUTO_CONFIRM_WALK_ON_MS = 30_000` and
`AUTO_CONFIRM_SWEEP_MS = 5_000` live in one server file. The web never needs the delay value, because the server
sends the deadline (section 4).

## 4. API

`GET /sessions/:code`: a pending court gains `autoStartAt`:

```ts
{ status: 'pending', pairingId, revision, format, teamA, teamB,
  autoStartAt: string | null }   // ISO; pendingSince + 60 s
```

It is `null` when `pendingSince` is null, a seat is empty, or a player on it
is resting. It mirrors the sweep's skip rules, so the countdown only shows
when the sweep will act on it. The roster is already loaded in `getSession`.
The endpoint stays `@Public`, and the display ignores the field.

## 5. Dashboard UI

In `court-panel`, on a pending court with `autoStartAt` set:

- A small line under the ยืนยัน button: **"เริ่มอัตโนมัติใน 42 วิ"**
  (`@@court.autoStartIn`), counting down each second from
  `autoStartAt − (clock.now() − serverSkewMs())`, the same skew correction
  the live timer uses.
- At 0 it reads **"กำลังเริ่ม…"** (`@@court.autoStarting`).
- About 6 s past the deadline (the sweep has run by then) the panel calls
  `liveSession.refresh()` once for that pairing and deadline, so the court
  turns active without waiting up to 30 s.
- The line is hidden when `autoStartAt` is null, which also covers the
  resting-player and empty-seat warnings the panel already shows.
- The ยืนยัน button works exactly as today at any point in the countdown.

Both strings go into `web/src/locale/messages.xlf` and
`web/src/locale/messages.en.xlf` by hand, like every other unit there (there
is no extract script). English targets: "Auto-starts in {n}s" and
"Starting…".

The TV display does not change (D2).

## 6. Edge cases

| Case | Behaviour |
|---|---|
| Phone locked or tab closed | The server still confirms. When the host comes back, the focus refresh shows the court active with the correct timer. |
| Two hosts or tabs open | Only the server confirms, and the tabs just display. The revision guard covers a manual confirm racing the sweep: whichever loses gets `PAIRING_CONFIRMED` or `PAIRING_STALE`. |
| Host taps ยืนยัน in the same second the sweep fires | Whichever write lands first wins, serialized by the session lock. If the sweep wins, the host's tap gets the existing "แมตช์นี้ยืนยันไปแล้ว" (`PAIRING_CONFIRMED`) and the court shows active on reload. *Accepted:* the message is true, and the race is a one-second window. |
| Host has picked a player to swap when the countdown ends | The swap is refused with the existing `PAIRING_NOT_PENDING` message. The host undoes (back to pending) and swaps. *Accepted:* selecting a player is client-only state that the server can't see. |
| Session start: fill all courts, players still warming up | Courts start 60 s later and the timer includes warm-up. *Accepted:* undo if it matters. |
| API restarts | The first tick after boot confirms anything overdue, still at `pendingSince + 30 s`, so downtime doesn't change the match time. |
| Pending rows from before the deploy | `pendingSince` is null, so they never auto-confirm. |
| Elo replays in `confirmedAt` order | Backdating can't reorder two matches that share a player: everyone on a pending court is reserved from `pendingSince` on, and `pendingSince + 30 s` falls inside that window, so no match with any of them can be confirmed between the backdated start and the real auto-confirm. Ratings are unchanged. |
| `queueGames` counts only confirmed matches | A forgotten confirm used to leave those players undercounted in the rotation. Auto-confirm fixes that too. |

## 7. Testing

**Server** (existing Nest + real SQLite spec style):

- `autoConfirmDue` confirms at ≥ 60 s, sets
  `confirmedAt = pendingSince + 30 s`, and bumps `revision`. It does nothing
  at 59 s. A run long after the deadline (restart case) still writes
  `pendingSince + 30 s`, not a time based on "now".
- It skips each of: an empty seat, a resting player, `pendingSince = null`,
  an ended session, and a row edited between the query and the write.
- Every write in the section 2 table sets `pendingSince`, including both rows
  of a cross-court trade and the rest/return of a seated player.
- Undo-confirm clears it, and a following swap sets it again.
- `getSession` returns `autoStartAt` in the set and null cases.
- The sweep skips a row deleted between query and write, and a corrupt row
  doesn't stop the next one.
- The scheduler starts on bootstrap, stops on close, and doesn't overlap
  ticks (fake timers).
- Sweep specs make a row due by backdating its own `pendingSince` through
  Prisma, then calling `autoConfirmDue()`. They don't pass a future `now`,
  which would also confirm pending rows left over from earlier specs in the
  same file.
- The confirm, propose, swap, seats and autopair endpoints return raw
  `Pairing` rows, which now carry `pendingSince`. Any exact-match
  (`toEqual`) assertion on those responses needs the field added.

**Web:**

- The court panel shows the countdown, shows "กำลังเริ่ม…" at 0, hides the
  line when `autoStartAt` is null, and refreshes once past the deadline.
- `CourtState` fixtures in the existing specs gain `autoStartAt`.

## 8. Files

| File | Change |
|---|---|
| `server/prisma/schema.prisma` + new migration | `Pairing.pendingSince` |
| `server/src/sessions/sessions.service.ts` | Set/clear `pendingSince` in the writes above, `autoConfirmDue`, the shared confirm check, and `autoStartAt` in `getSession` |
| `server/src/sessions/auto-confirm.ts` (new) | Constants, `AutoConfirmScheduler` and `AutoConfirmModule` |
| `server/src/sessions/sessions.module.ts` | Export `SessionsService` |
| `server/src/app.module.ts` | Import `AutoConfirmModule` |
| `web/src/locale/messages.xlf`, `messages.en.xlf` | Two new units |
| `web/src/app/core/live-session.model.ts` | `autoStartAt` on pending |
| `web/src/app/pages/session-dashboard/court-panel/court-panel.{ts,html}` | Countdown line and refresh past the deadline |
| Specs next to each | Tests above. Pending `CourtState` fixtures that need `autoStartAt`: `court-panel.spec.ts` (17), `live-session.service.spec.ts` (2), `session-dashboard.spec.ts` (2), `session-display.spec.ts` (1) |
| `docs/overview.md` | One paragraph on the pending → active auto-start |

## 9. Deploy

This carries a migration. Following `dockerDeploy.md`, run
`docker compose exec -T api npm run db:backup` on the home server **before**
`git pull` and rebuild. Check the pull's file list for any other
`server/prisma/migrations/` the server doesn't have yet.
