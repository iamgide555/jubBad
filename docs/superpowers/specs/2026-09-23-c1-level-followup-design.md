# C1 follow-up: set level mid-session, level resets Elo, live player panel, one-row picker

Status: Built and verified 2026-09-23. Engine, server and web changes below
are all implemented, tested (engines 181/181, server 401/401, web 397/397)
and building clean. See the roadmap doc's C1a entry for the summary and the
two real bugs found and fixed while finishing a partial implementation
(the `levelSetAt` migration was missing, and rating-loading match queries
didn't select `confirmedAt`).

## Context

Owner reviewed C1 (branch `feat/c1-skill-level`, not yet committed) on 2026-09-23. Hosts usually
don't know a new player's level until they've watched them play, so the level has to be settable
**during** the session, not only at roster review. Decisions:

1. **Elo rule, "reset on every set":** an unlevelled player sits at the neutral 1200 (not 0; a
   0-rated player breaks Elo for everyone they play with). Setting a level, first time or edit,
   sets that player's rating to the level's seed **at that moment**. Only matches confirmed
   afterwards move it. Earlier matches still count in W/L, and they still moved the other
   players' ratings as if this player were 1200. Setting the same level again does nothing.
   Choosing "ไม่ระบุ" resets to 1200.
2. **Dashboard player panel** (toggle): every player on tonight's roster, with games played /
   won / lost tonight, their level (editable in place), and their rating shown as `P +50`
   (the difference from the level's seed).
3. **Level picker**: keep it in roster review, but put every level chip on **one row**, and
   remove the "ช่วยเลือก" helper and the "?" list. Tapping a level already shows its definition.

## 1. Engine — `engines/elo.ts`

- `FinishedMatch` gets an optional `at?: number` (epoch ms of `confirmedAt`, which is the key
  replay is already ordered by).
- Replace the `seeds` param of `computeRatings` / `computeRatingTracks` with
  `anchors?: ReadonlyMap<PlayerId, RatingAnchor>`, where
  `RatingAnchor = { rating: number; setAt: number | null }`.
  - `setAt === null` → the anchor is where the player starts at their first appearance (today's
    seed behavior; this covers legacy rows and a level set before the player's first match).
  - `setAt !== null` → the player starts at `STARTING_RATING`. Before the first match with
    `at >= setAt` that includes them, set their rating to `anchor.rating`, then apply the match.
  - After the loop, if a player has an entry in the map and their anchor was never applied
    (they played before `setAt` but not since), set it to `anchor.rating`. Players with no
    matches stay absent, keeping the `.has(id)` contract.
  - Throw if an anchor has `setAt !== null` but a match in the list has no `at` (fail loudly, as
    the engine rules require).
- Update the doc comments (the "seeds" paragraph on `computeRatingTracks`).
- `engines/levels.ts` stays the same (`seedFor` is still the anchor rating).

Tests in `engines/elo.test.ts`:
- a level set before any play gives the same result as the old seed;
- 3 wins while unlevelled, then level P → rating equals `seedFor('P')` exactly;
- matches after the level move the rating from the seed;
- an edit resets again;
- opponents' ratings from the pre-level matches are computed against 1200;
- a player absent from all matches stays absent;
- the missing-`at` case throws.

## 2. Server

- **Migration**: add `Player.levelSetAt DateTime?` to `schema.prisma`, as a new migration after
  `20260923051354_add_player_level_and_session_level_mode`. No backfill: `null` means "from the
  start", which is correct for every level that exists today.
- **`server/src/player-levels.ts`**: add a helper `levelWrite(prev: Level | null, next: Level | null)`
  that returns `{ level: next, levelSetAt: new Date() }` when the level changes and `{}` when it
  doesn't. Use it in every write path:
  - `groups.service.ts` `updatePlayerLevel` (line ~180) and `updatePlayer` (line ~159, the edit
    dialog also writes `level`);
  - `sessions.service.ts` roster-review writes (~284–346) and walk-in create (~2082). For
    brand-new players this just stamps `now`, which is equivalent to `null`.
- **Replace `seedsFromLevels` with `loadRatingAnchors(prisma, groupId)`**, which selects
  `level, levelSetAt` and returns `Map<id, RatingAnchor>`. Keep `loadPlayerLevels` for the band
  callers (sessions 668/1088/1609/1865), which stay unchanged.
- **Rating callers** (select `confirmedAt` and map it to `at`):
  - `sessions.service.ts` `loadRatings` (~1457). Its fallback for players with no matches, now
    `new Map([...seeds, ...tracks])`, should use each anchor's rating;
  - `groups.service.ts` `listPlayersManage` (~110) and player stats (~337), plus their
    `finishedMatches` select (~229).
- **New host-only endpoint**: `GET /sessions/:code/players` in `sessions.controller.ts`, not
  `@Public`, since the level is host-only (C1 Q6). `SessionsService.getPlayerPanel(code)` returns
  one row per roster player: `{ playerId, name, level, resting, played, won, lost, ratingDelta }`.
  - `played` / `won` / `lost` are tonight only, using the same `finishedMatch` filter as
    `getStats` (~2189). `lost` counts decisive losses only, so no-result games are neither won
    nor lost.
  - `ratingDelta` = doubles-track rating − `seedFor(level)`, using `loadRatings`. It is `null`
    when there is no level.
  - Tests go in a new `sessions/player-panel.spec.ts`: counts, the delta after a level set, and
    a 404 on an ownership mismatch via the existing guard setup.

## 3. Web

- **`shared/level-picker`**:
  - Delete the helper flow (`helperQuestions`, `helperStep`, `answerHelper`, start/stop), the
    "?" definitions list (`showDefinitions`, `toggleDefinitions`, `.definitions`), and their CSS.
  - Delete the `@@level.helper.*`, `@@level.helperStart` trans-units from `messages.xlf` and
    `messages.en.xlf`. Keep `definitionsOf()` and `currentDefinition`.
  - One row: `.chips { flex-wrap: nowrap; gap: 0.25rem; overflow-x: auto }` and
    `.chip { flex: 1 1 0; min-width: 0; padding: 0 }`. Height stays `var(--tap)`.
  - The unset chip becomes "–" with `aria-label` "ไม่ระบุ", so 9 chips fit a 360px phone.
  - `:host` becomes `display: block` when not compact, so review rows give it the full width.
  - Compact mode: stay open after `choose()` so the chosen level's definition is visible. It
    closes via ปิด or the trigger.
  - Spec: drop the 3 helper tests, and add "compact stays open and shows the definition after
    choosing".
- **`pages/group-entry`**: check that the review row wraps the picker onto its own full-width
  line (flex-basis 100%, like the existing yes/no toggle).
- **`pages/session-dashboard`**:
  - A toggle button "ผู้เล่นทั้งหมด (n)" under the roster chips opens a panel with an
    `httpResource` on `/sessions/:code/players`, reloaded by the same every-mutation hook that
    reloads `statsResource` (~line 62–77).
  - Each row shows the name, a compact `app-level-picker`, `เล่น n`, `ชนะ w / แพ้ l`, and the
    rating as a `P +50` badge (hidden when there is no level).
  - A level change calls the existing `PUT /groups/:groupCode/players/:id/level` through the same
    service the player-roster page uses, then reloads the panel and `levels`.
  - The panel is closed by default (localStorage is not used; the app keeps no localStorage
    state).
  - Add Thai + English i18n units.
  - Spec: the panel toggles, rows render counts and the delta, and a level change calls the
    route and reloads.
- `pages/player-roster`: no change, since it already has the inline chip. Optionally show the
  `P +50` delta there too, as a later follow-up rather than part of this plan.

## 4. Docs

- `docs/overview.md`: update the Elo section with "level set = rating reset to seed at that
  moment; unlevelled = 1200", including the reason (no double-counting, and 0 breaks Elo).
- `docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md`: add the three decisions as
  another bullet under "C1 amendments, owner 2026-09-23".

## Verification

- `npm run test:engines` (elo + pairing-quality stay green).
- `cd server && npx prisma migrate dev` (applies the new migration locally), then `npm test` and
  `npm run lint`.
- `cd web && npm test && npm run build` (the i18n extraction and the build catch stale
  trans-units).
- Manual (`npm run start:dev` + `npm start`):
  - start a session with a new player left unlevelled, play and win 3 games, open the panel,
    and check W/L = 3/0 with no delta;
  - set P → the badge shows `P +0`; play one more win → the delta goes positive; edit to C →
    `C +0`;
  - check that the picker is one row on a 360px viewport in roster review, and that there is no
    ช่วยเลือก / ? button.
