# Real-host feedback (2026-09-27/28)

Firsthand feedback from hosts running actual badminton sessions. This is the
living checklist for items A–F; the competitor-feature review and its C-series
roadmap remain in the [archived feature review](archive/2026-09-21-feature-review-and-roadmap.md).

### Feedback items

#### - [x] B. Level-mode rework: wait-only queue + carry game (2026-09-27 real-host feedback)

Real host feedback, 2026-09-27: groups running level mode only care who has
waited longest, and want a newcomer far below the group's level to get one
"carry" game with a strong partner before playing normal level-clustered
games. Historical design: `docs/archive/specs/2026-09-27-level-rework-design.md`.
Done: `feat/level-rework`.

#### - [x] A. Court labels — rename court numbers to match the physical hall

2026-09-27 real-host feedback. Design:
`docs/archive/specs/2026-09-30-court-labels-design.md`. Done: court names
on the session, shown on every reader (2026-09-30).

#### - [x] C. Pair rules — คู่กัน, ห้ามอยู่ด้วยกัน, ห้ามเล่นด้วยกัน

2026-09-27 real-host feedback. Revives the deferred C5 (fixed pairs). Depends
on B. Design: `docs/archive/specs/2026-09-30-pair-rules-design.md`. Done:
group rules on the player-roster page, tonight-only switches and rule-aware
conflict messages on the dashboard, enforced by the engine and server
(2026-09-30). The design questions below were settled there — notably manual
seating refuses a violation rather than warning.

Three rules a host sets between two players:

| Rule | Thai | Meaning |
|------|------|---------|
| Must pair | คู่กัน | Always teammates when both are on court. Never split across teams or courts. |
| Never teammates | ห้ามอยู่ด้วยกัน | May share a court (as opponents) but never be partners. |
| Never same court | ห้ามเล่นด้วยกัน | Never on the same court at all, on either team. |

Design questions to settle before building:

- **Hard vs soft.** All three are hard constraints on the engine, so they go
  through the exact-versus-local search reasoning in `overview.md`: they
  narrow the space the search explores and must not make a round unsolvable.
  Decide the fallback when a rule set can't be satisfied (e.g. 4 players, two
  of whom are "never same court").
- **คู่กัน takes two seats as one unit.** Sit-out rotation must bench or seat
  the pair together (games-played / wait time for the pair), and the pair must
  not be split by reshuffle, tap-swap or auto-confirm. Interaction with
  carry-game (B): a carry pair member counts once.
- **Scope of a rule:** per group (persistent, like a couple) or per session
  (one night). Likely both; per-group default, host can switch it off for a
  session.
- **History:** rules are constraints, not history — they don't feed
  `partnerCounts`/`opponentCounts`. Custom-mode manual seating may override
  with a warning rather than refusing.
- **Storage:** a rules table (groupId, playerA, playerB, kind), pair stored
  order-normalised (same key as `pairKey`).

#### - [ ] D. Shuttlecock tracking per court per game — by shuttle *number*

2026-09-27 real-host feedback (clarified 2026-09-28). Depends on A. Not yet
designed.

Today the host counts shuttles once, at the end of the night
(`Session.shuttleCount`, set via `setShuttleDetails`). Wanted: record shuttle
use **per court, per game**, and as **a number**: how many shuttles this
match used (e.g. 2), not a tick/checkbox and not free text.

- **Storage:** an integer on `Pairing` (e.g. `shuttlesUsed Int?`), `null` =
  not recorded, `0` valid — the same null-vs-0 semantics as
  `Session.shuttleCount`. Entered at finish time (a stepper next to the
  winner buttons, defaulting to the last value used on that court to save
  taps), editable afterwards.
- **Session total derives from games.** When per-game numbers exist,
  `Session.shuttleCount` becomes their sum. Decide whether the host can still
  override the total (the physical tube count is the ground truth if a
  shuttle got lost or used for warm-up), and how the two reconcile.
- **Undo:** undoing a finished match must drop its shuttle number with it.
- **UI:** one-handed courtside, 44px targets; a number stepper, not keyboard
  entry. Display route unaffected.

#### - [ ] E. Mid-session checkout for an early leaver (per-shuttle billing)

2026-09-27 real-host feedback (clarified 2026-09-28). Depends on D. Not yet
designed.

Someone leaves before the night ends and wants to pay now. Their bill must be
computable **mid-game**, from the shuttle numbers recorded in D — not from the
end-of-night total that C3's bill uses today (`bill.ts` takes one
`shuttleCount`).

- **Their shuttle share:** for each finished match they played, that match's
  `shuttlesUsed` split among its players (shuttle price × number ÷ 4 for
  doubles, ÷ 2 for singles). Sum over their matches. No dependence on the
  final tube count, so it stays fixed once they've left.
- **Court fee:** per-person court share is time/games-dependent on the
  billing model. Decide whether a leaver pays court by games played so far or
  pro-rata; must not change what the others owe in a way that surprises them
  (see the billing rule: surcharges redistribute, never profit).
- **Redistribution:** the group's remaining bill is computed over the
  remaining participants after the leaver's share is removed, so the host's
  total still nets to zero. Reuse the existing removed-participant handling in
  `bill.ts` (`kind: 'court' | 'shuttle'` split with removed players).
- **Match in progress:** a leaver mid-game is checked out only after that
  match finishes (or the match is abandoned as "no result"); its shuttles
  count only once entered.
- **Output:** same copy-as-text bill as C3, for that one person.

#### - [ ] F. Per-group level names — each host configures their own ladder

2026-09-28 real-host feedback. Not yet designed.

Groups don't share one ladder. One group grades `BG, N, S`; another `BG, BGN,
N, NS`, etc. Today the ladder is the fixed `LEVELS` list in `engines/levels.ts`
(`BG, N, S, P-, P, P+, C, B`), shared by every group. Wanted: each host
configures the level names for their own group (which names, and their order).

Design questions to settle before building:

- **Storage:** per-group ordered list on `Group` (JSON-encoded string column,
  same as `Player.aliases`), defaulting to today's `LEVELS` so existing groups
  don't change.
- **Order is meaning.** `levelIndex` drives the ±1 band in level mode, the
  Elo seed (`seedFor`: 900 + 100 × index), the carry-game "far below" check,
  and คอร์ดมือ. A custom ladder must feed all of these from the group's list,
  not the constant. Elo seed spacing may need to scale with ladder length.
- **Renaming/removing a level in use:** `Player.level` is a free string; a
  removed name must not orphan players (map to null? force the host to
  reassign?). `asLevel`/`isLevel` currently validate against the constant.
- **Roster paste:** parser may read a level suffix from LINE names; check it
  uses the group's names.
- **Web:** level pickers and labels read the group's list; bilingual UI unchanged.

Effort M.
