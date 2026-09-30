# Level-mode rework + per-court mode — design (sub-project B)

Status: implemented (sub-project B); archived 2026-09-30. This is the
historical approved design, not a description of current behavior. The
2026-09-28 decision to seat multiple eligible newcomers together supersedes
the separate-carry rule below; see `docs/overview.md` and
`docs/2026-09-27-real-host-feedback.md` for current state.

## Context

Owner talked with a real badminton group host (2026-09-27). Findings are
real-session evidence, so they pass the roadmap filter (memory
`feedback_roadmap_real_session_filter`). Real groups care about game
*quality*, not game count, and run level mode (ตามระดับ) only. The owner's
feedback list had 7 items, too big for one spec, so it is split into 5
sub-projects:

| # | Sub-project | Owner items | Depends on | Status |
|---|---|---|---|---|
| A | Court labels (rename court no. → real hall court) | 5 | — | not started |
| **B** | **Level-mode rework + per-court mode in custom** | **1, 2, 3** | — | **this spec** |
| C | Pair rules (couple / never teammates / never same court) — revives deferred C5 | 4.1–4.3 | B | not started |
| D | Shuttle tracking per court per game | 6 | A | not started |
| E | Early-leaver checkout + per-shuttle bill model | 7 | D | not started |

Each gets its own spec → plan → build. This spec covers **B only**.

### Owner decisions (2026-09-27/28)
- "ตามลำดับ" in the original message = existing `level` mode (ตามระดับ).
- Level mode: **level band first, then wait time**. Games played is ignored.
- Item 1 is automated as a **carry game**: a player far below the group gets
  one game partnered with a pro, then plays normal level mode.
- Trigger = **level tag** (not "new to group", not Elo). New players arrive
  untagged (1200 Elo, `null` level); the host tags them after watching.
- Carry fires on their first game tonight **after tagging**.
- Pro may jump the queue. Opponents are "fair in level with the pro" (±1).
- Two or more weak newcomers each get their own carry (count-based trigger).
- Reshuffle on a carry court → **new opponents**, same newbie + pro.
- Custom mode gets a **sticky per-court mode**. Each court uses its own
  mode's queue rule: สลับคู่ / สูสี → games then wait; ระดับ → band then wait.
- Custom session waiting list stays games-then-wait, plus a hint when any
  court is ระดับ.

## Section 1 — Engine (`engines/pairing.ts`, `engines/levels.ts`)

### 1a. Level queue = band, then wait
- `selectSittingOut` (`engines/pairing.ts:76`) gets `queueBy: 'games' | 'wait'`.
  With `'wait'`, the sort at `:120-127` skips the games comparison and orders
  by `waitingSince` only (`engines/waiting.ts`). The shuffle-then-stable-sort
  random tiebreak stays (it matters only at session start).
- `bandOrderedByCourt` (`:185`) is unchanged in principle: it still clusters
  ±1 around each court's anchor, but the anchor order is now wait-only.
- `generateRound` (`:1041`) threads `queueBy` through. The caller passes it
  from the court's *effective* mode (section 2): `level` → `'wait'`;
  `variety` / `balanced` → `'games'` (unchanged).
- `completeCourt` (`:1269`, auto-pair on a เลือกเอง court) unchanged: games
  then wait.
- `gamesOffset` credit (rest/walk-in) has no effect under `'wait'`. That's
  fine: `activatedAt` already restarts their wait (same fairness goal).

### 1b. Carry game

**Far below** — new pure helper `isFarBelow(id, activeLevels)` in
`engines/levels.ts`:
- the player is tagged, **and**
- fewer than 4 active roster players (self included) are within ±1 of them
  (`withinBand`, tagged only), **and**
- every active *tagged* player outside their band is above them.
- Untagged (`null`) players never qualify, and never count toward "in band"
  or "above". Two BGs in a P+ group → 2 in band → both qualify. A lone top
  player (B in an N group) doesn't qualify (not at the bottom).

**Eligible tonight** — the server computes `carryEligible: Set<PlayerId>`:
far-below players with no confirmed pairing this session where
`confirmedAt >= Player.levelSetAt`. `levelWrite`
(`server/src/player-levels.ts:6`) already stamps `levelSetAt` only on an
actual change → no migration. Late tag works; re-tagging to a different
level re-arms it. Undoing a confirmed carry game re-arms it too (that's
correct: the game didn't happen).

**Engine shape: carry groups are locked outside the search.**
`bandOrderedByCourt` only decides *who plays*; the search decides *who
shares a court* (`forEachExactArrangement`, `improveArrangement` swaps
players across courts). A carry court formed only by ordering would be
broken apart by the search. So:
1. In `generateRound`, before the normal search, walk the offered courts in
   order (the requested court first, as today). When a doubles court's
   anchor (the front of the band/wait order among players not yet placed)
   is carry-eligible, build a **locked carry group**:
   - **Pro** = the tagged player with the highest `levelIndex` among
     players not yet placed. They may jump the queue. Tie → one who hasn't
     carried tonight (server passes `carriedTonight: Set<PlayerId>`), then
     longest wait.
   - **Opponents** = the two longest-waiting unplaced players within ±1 of
     the pro's level.
   - **Split fixed**: {far-below, pro} vs {opponents}. No split search.
2. Remove locked players and courts. Run the existing `selectSittingOut` +
   search on the remainder, unchanged. `pairing-quality.test.ts` keeps its
   meaning because the searched part is the same algorithm.
3. Return the locked courts + searched courts in offered order, so
   `result.courts[0]` is still the requested court.
- Carry-eligible players are **not used as out-of-band filler** on another
  anchor's court. They wait for their own anchor turn. Exception: if the
  court can't be filled otherwise (the never-unsolvable rule).

**Fallbacks** (must never make a round unsolvable):
- No tagged unplaced player above the carry player → no carry; normal band.
- Fewer than 2 in-band opponents → top up with the longest-waiting unplaced
  players of any level.
- Singles court → no carry there. The player stays eligible.
- Fewer than 4 unplaced players left → no carry; normal path.

**Reshuffle on a pending carry court** (owner: new opponents):
- `generateRound` gets `avoidSplit` as today. If court 0's avoided split is
  the carry player's current pairing, build the carry group with the
  **same pro** and choose opponents **excluding the two current
  opponents**.
- If no other opponents exist (in band, then any level) → pick the next
  pro (next-highest level, not the current pro) and rebuild.
- If neither works → return the same court (nothing else possible).
  `generateRound` must not throw here.

**Cancel (undo pending) + propose again** → the same carry court comes
back (eligibility and wait are unchanged by a proposal). That's intended.
The host's exits are: tap-swap the newbie out (carry stays armed), rest
them, or set the court to เลือกเอง.

**After the carry game is confirmed** → not eligible. They're still
isolated, so level mode fills their next court out of band from the queue:
the "not easy anymore" game.

## Section 2 — Server + per-court mode

### Data
- New nullable `Session.courtModes String?`: a JSON array, one entry per
  court, in the same pattern as `courtFormats` (`formatAt`/`withFormatAt`
  helpers). Values: `variety | balanced | level | custom`. A missing entry
  = `custom`, so existing custom sessions are unchanged. Read only while
  `session.mode === 'custom'`. Kept across session-mode switches. A court
  added later = `custom`. One Prisma migration.

### Effective mode
- `effectiveCourtMode(session, n)` in `server/src/sessions/session-mode.ts`
  = the session mode, or the court's own entry when the session is custom.
- Replace the session-wide checks at every per-court site in
  `sessions.service.ts`:
  - propose (`:638` custom branch, `:710` band flag),
  - substitute/tap-swap (`:1100-1122`),
  - fill idle courts (`:1792`, `:1882`),
  - `ratingsForMode` (`:1507`) → per court.

### Propose court k (`proposeExclusively`, `:603`)
- Effective mode M.
  - `custom` → empty seats (unchanged).
  - Otherwise, co-plan across idle courts whose effective mode is also M,
    and commit only k. One `generateRound` call is still one mode, using
    M's `queueBy` and band flag.
- Level (M = `level`): pass `carryEligible` + `carriedTonight`.
  `carriedTonight` = players who partnered any currently-far-below player
  in a confirmed game tonight. Derived from pairings + tags, no storage.
  (Close enough for a tiebreak; it doesn't need to know whether that game
  was formally a carry.)

### Substitute / tap-swap (`:1100`)
- Sort key per the court's effective mode: `level` → wait, then quality;
  otherwise games, then wait, then quality (unchanged).
- Swapping the pro or an opponent on a carry court: the replacement goes
  into that seat and the far-below player's partner seat is untouched.
  Swapping the newbie out: the carry stays armed.

### Fill idle courts (`:1792`)
- Custom session: `custom` courts → empty drafts. Other idle courts are
  grouped by effective mode; groups run in order of their lowest court
  number, each drawing from the players still available, each with the
  existing seats-maximising doubles/singles choice.
- Level session: carry inputs passed, same as propose.

### Set a court's mode
- New `POST /sessions/:code/courts/:n/mode` (owner-guarded like the format
  endpoint; `SetCourtModeDto` `@IsIn(SESSION_MODES)`).
- Allowed in any court state. It never rewrites a pending pairing and
  applies from the next propose/reshuffle (same principle as the
  session-mode switch).
- Refused with `SESSION_ENDED` after the session ends, and
  `INVALID_COURT_NUMBER` for a bad `n` (reuse `assertCourtNumber`, `:588`).

### Payload
- Session payload (built around `:407`, next to `courtFormats`) adds
  `courtModes` (effective mode per court).
- New `queueBy: 'games' | 'wait'` field next to the existing `queueGames`
  (which the web `buildWaitingList` sorts by). `level` session → `'wait'`,
  and `buildWaitingList` skips the games key. Every other session (custom
  included) → `'games'`.

## Section 3 — Web

- Dashboard (`web/src/app/pages/session-dashboard/`):
  - When the session is เลือกเอง, each court panel shows a 4-segment toggle
    (สลับคู่ / สูสี / ระดับ / เลือกเอง) below the singles/doubles toggle.
    Reuses `.scope-toggle`, 44px targets, Thai + English i18n ids
    (`messages.xlf` / `messages.en.xlf`). Hidden in other session modes.
  - Waiting list: wait-only in a level session. In a custom session it
    stays games-then-wait; a hint under the list shows when any court is
    ระดับ (e.g. "คอร์ทตามระดับอาจเรียกข้ามคิว").
  - Level-mode hint (`:195`) gets one more line about the carry game, e.g.
    "มือใหม่ที่ระดับห่างจากกลุ่ม จะได้เล่นคู่กับมือโปร 1 เกม".
- `/display` unchanged.

## Section 4 — Docs, branch, rollout

- **Branch:** `feat/level-rework` (memory `feedback_poc_branch`). `main`
  runs real weekly sessions.
- **Docs to update:**
  - `docs/overview.md` "Pairing":
    - level-mode paragraph: band-then-wait, carry game, locked carry
      groups;
    - custom-mode paragraph: per-court mode, each court uses its own
      mode's queue rule;
    - sit-out paragraph: games-then-wait applies to variety/balanced
      courts.
  - `CLAUDE.md` engine bullet: games-played rotation applies to
    variety/balanced courts only. Level courts queue by band then wait.
  - Roadmap doc: add A–E as new items with the 2026-09-27 real-host
    source. Mark C5 and C15 as revived by C/B respectively.
- **Deploy:** one migration (`courtModes`). Check for undeployed
  migrations before the rebuild (memory
  `project_session_summary_deploy_2026_09_21`).

## Verification

- `npm run test:engines`:
  - `engines/levels.test.ts`: `isFarBelow` (lone BG, two BGs, top outlier,
    middle outlier, untagged ignored).
  - `engines/pairing-levels.test.ts`:
    - wait-only order (a player with more games but a longer wait plays
      first);
    - carry court locked on the requested court with the forced split,
      including the 8+ player local-search path;
    - pro jumps queue; tie prefers not-carried-tonight;
    - opponents ±1 of the pro; top-up fallback;
    - no pro / singles / <4 players fallbacks;
    - carry player not used as filler;
    - reshuffle → new opponents; → new pro; → same court when nothing
      else.
  - `pairing-quality.test.ts` and `pairing-golden.test.ts` unchanged and
    green.
- `cd server && npm test`:
  - eligibility: late tag, re-tag re-arm, confirmed carry clears it, undo
    re-arms;
  - court-mode endpoint: set/get, owner 404, `SESSION_ENDED`, bad court;
  - propose per court mode + same-mode co-plan; level court band-then-wait
    and variety court games-then-wait in the same custom session;
  - fill-idle with mixed modes;
  - a mode change leaves the pending pairing untouched;
  - tap-swap sort per court mode.
- `cd web && npm test`: per-court toggle only in custom; waiting list
  order per mode; custom ระดับ hint.
- Manual (`server: npm run start:dev`, `web: npm start`):
  - Level session, P-heavy roster + two new BGs → tag both mid-session →
    each gets a carry court (different pros where possible) → reshuffle
    one → new opponents → confirm → next game out of band.
  - Custom session → court 1 ระดับ, court 2 เลือกเอง, court 3 สลับคู่ →
    propose each and fill-all.
