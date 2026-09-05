# JubBad — code review + v2 backlog

Reviewed 2026-09-05 against `PROJECT.md`. Baseline at review time: all tests
pass (server 32, web 71 — 103 total), branch `main` clean at `0aac515`.

Two sections: **A. Bugs / spec drift** (things that are wrong *now*, against
the spec the project had already written for itself) and **B. v2 candidates**
(new scope). Suggested order at the bottom.

> **On the `§` references below.** They point into `PROJECT.md` as it stood at
> review time. That file has since been replaced: its durable content — the
> product decisions and the engine reasoning — is now `docs/overview.md`, and
> its build log and progress checklist (§7.4, §8, §9) were dropped as recorded
> better by `git log` and `docs/active/`. The numbers are left as written
> rather than remapped, since this is a point-in-time review; the original is
> `git show 0aac515:PROJECT.md`.

**Status:** every bug is fixed except A7 and A8, which are unbuilt features
rather than defects and stay bundled into B3. A6 turned out not to be a bug at
all — see its entry. **B1 (Thai UI) is also done and shipped.** Suite: 40
engine + 49 server + 75 web = 164 tests, all passing, both packages building
clean.

---

## A. Bugs / spec drift

### - [x] A1. Cross-session history is never used

`server/src/sessions/sessions.service.ts:140`

```ts
const confirmed = await this.prisma.pairing.findMany({
  where: { sessionId: sessionCode, confirmedAt: { not: null } },
});
```

The spec specifies partner/opponent history as **all-time across
sessions** ("the whole point is spreading out variety over the group's life,
not just one evening"), and `gamesPlayedThisSession` as **this session only**.
The code derives both from a single session-scoped query, so partner/opponent
avoidance silently resets every week.

Root cause: `deriveHistory` (`server/src/sessions/derive-history.ts`) returns
all three maps from one list of pairings, so one query has to serve two
different scopes.

Fix: two queries — group-wide (`session: { groupId }`, `confirmedAt not null`)
for `partnerCounts`/`opponentCounts`, session-scoped for
`gamesPlayedThisSession`. Same change needed in `swapPlayer`
(`sessions.service.ts:262`).

Highest-value fix in this list — the cross-session variety promise is currently
dead code.

**Fixed.** `deriveHistory` now takes the two scopes as separate arguments, and
a new `SessionsService.loadHistory` runs the two queries. Covered by
`derive-history.spec.ts` and two integration tests: one asserting a
partner-pairing used up in an earlier session is avoided today, one asserting
last week's games-played does *not* decide who sits out tonight.

### - [x] A2. `propose` is not actually serialized

`server/src/sessions/sessions.service.ts:114-181`

Read-then-write with no transaction: reads `nonEnded` to compute `reserved`,
then writes a `Pairing` row. Two courts proposing concurrently both read before
either writes, so the same player can be assigned to two courts at once.

This is the exact race §8.1 cited as *the* reason to move the engines
server-side. WAL mode does not prevent it. Fix: wrap read+write in a
`$transaction`, or add a constraint that makes a double-booking impossible.

**Confirmed and fixed.** Two concurrent `propose` calls for courts 1 and 2 with
8 players returned **5 distinct players instead of 8** — three double-booked.
Note the race does *not* reproduce through supertest: two requests started
together still reach the handler one after the other, so the regression test
drives `SessionsService` directly.

Fixed with `SessionLock` (`server/src/sessions/session-lock.ts`), which
serializes work per session code, applied to both `propose` and `swapPlayer`.
This is in-process, which is sufficient for the single-API-container
deployment in `docker-compose.yml`; running more than one API process would
need a database-level lock instead. That limitation is written into the class
doc comment.

### - [x] A3. Pairing lifecycle transitions are unguarded

`server/src/sessions/sessions.service.ts:195` (`confirmPairing`), `:201`
(`finishPairing`) — both only check that the row exists.

Consequences:

- `finish` on a **pending** (unconfirmed) row succeeds → row gets `endedAt`
  but never `confirmedAt`.
- That match then **counts in stats** (`getStats:311` filters on
  `endedAt: { not: null }` only) but is **invisible to pairing history**
  (`propose:141` filters on `confirmedAt: { not: null }`). Two derived views
  of the same data disagree.
- `confirm` on an already-ended row overwrites `confirmedAt`.

Fix: guard the transitions — `confirm` requires `confirmedAt === null &&
endedAt === null`; `finish` requires `confirmedAt !== null && endedAt ===
null`. Add `confirmedAt: { not: null }` to `getStats`'s filter.

**Fixed.** Both guards added, returning 409; `getStats` now filters on
`confirmedAt` and `endedAt` together. Three existing test fixtures had to be
updated because they built ended-but-never-confirmed rows — a state the guards
now make unreachable.

### - [x] A4. `endSession` is cosmetic

`propose` / `confirmPairing` / `finishPairing` / `swapPlayer` never check
`session.endedAt`. Only the UI hides the buttons
(`web/src/app/pages/session-dashboard/court-panel/court-panel.html`), so a
direct POST still mutates an ended session.

Fix: reject mutations on an ended session at the service layer.

**Fixed** — narrower than first written. `endSession` already refuses while any
pairing has `endedAt === null`, so once a session is ended every pairing is
ended too, and A3's guards already cover `confirm`/`finish`/`swap`. `propose`
is the only call that can still create new state on an ended session, so that
is where the check went (409).

### - [x] A5. A match cannot be finished without a winner

`server/src/sessions/dto/finish-pairing.dto.ts`

```ts
@IsIn(['A', 'B'])
winner!: 'A' | 'B';
```

Scores are optional (per §3), but the winner is mandatory. Abandoned match,
injury, or running out of booked time leaves the host with no way to free the
court except recording a false result — which then poisons the stats and any
future rating model.

Fix: allow `winner: null`.

**Fixed** on both sides. `winner` is now `@IsOptional()` in
`FinishPairingDto`, and the court panel gained a quieter full-width **No
result** button below the two winner buttons, which finishes with
`{scoreA: null, scoreB: null, winner: null}`.

### - [x] A6. Waitlist (สำรอง) is excluded from pairing — not a bug

Confirmed with you: a waitlisted player should *not* be in play when the host
starts the session, and that is what the code already does — `propose` and
`swapPlayer` both draw only from `SessionRoster`, never from `Waitlist`
(`sessions.service.ts`). No change needed.

What remains is a feature, not a defect: there is no way to *promote* a
waitlisted player into the roster when someone drops out. Moved to B3.

### - [ ] A7. Roster is frozen after session creation

§3 decided late-arrival add and no-show removal; §7.4 admits neither is built
("the roster panel only supports the initial paste-and-confirm flow").

Both happen at essentially every real session. Note §3 already established
that no engine change is needed — a new player has
`gamesPlayedThisSession = 0`, so existing priority logic handles them.

**Not fixed — feature, not defect.** Both halves are answered by B3's toggle:
a no-show is toggled out, and a rostered player who turns up late is toggled
back in.

### - [ ] A8. "Copy as text" share button is missing

§3's v1 feature #4 lists it explicitly ("host views results in-app, shares
manually (screenshot, or 'copy as text' button)"). Not present in
`session-dashboard.html`. Sharing back to LINE is screenshot-only today, which
undercuts the LINE-friendly positioning in §1.

**Not fixed — feature, not defect.** Was bundled into B3; now stands alone and
unscheduled, since it has nothing to do with roster editing.

### - [x] A9. `swapPlayer` ignores pairing history

`server/src/sessions/sessions.service.ts:271`

```ts
const substitute = [...pool].sort(
  (a, b) => (history.gamesPlayedThisSession.get(a) ?? 0)
          - (history.gamesPlayedThisSession.get(b) ?? 0)
)[0];
```

Picks purely by fewest games this session, ignoring `partnerCounts` /
`opponentCounts` — so a swap can hand a player the same partner repeatedly,
against the engine's primary goal. `history` is already computed two lines
above; use it.

**Fixed.** Each candidate substitute is now scored with the engine's own
`scoreArrangement` against the team it would join, so repeat partners dominate
and repeat opponents break ties — the same ranking `generateRound` uses (§6.3).
Games played tonight is now only the tie-break between candidates the history
term rates equally, which keeps the old behaviour where history is silent.

### - [x] A10. Docker bind-mounts the SQLite file, not its directory

`docker-compose.yml`

```yaml
volumes:
  - ./server/prisma/dev.db:/app/prisma/dev.db
```

`PrismaService.onModuleInit` sets `PRAGMA journal_mode = WAL`, which writes
`dev.db-wal` and `dev.db-shm` **beside** the database file. Those two paths are
not mounted, so they live in the container's ephemeral layer — a restart before
a checkpoint can lose committed writes.

Fix: mount the directory (`./server/prisma:/app/prisma`) rather than the single
file. Separately: there is no backup of that file anywhere.

**Fixed.** `docker-compose.yml` now mounts `./server/prisma:/app/prisma`. The
host directory already carries `schema.prisma` and `migrations/`, so
`prisma migrate deploy` still works at container start. This also removes the
`touch server/prisma/dev.db` dance and its matching troubleshooting entry from
`dockerDeploy.md` — a directory mount can't be mis-created as a directory.

Still open: **there is no backup of `dev.db`.** Tracked in B11.

### - [x] A11. CORS defaults to allowing every origin

`server/src/cors.ts` returns `true` when `CORS_ORIGINS` is unset. Combined with
no auth (§2, accepted risk) and 8-hex-char codes
(`crypto.randomUUID().slice(0, 8)`), any origin can drive any session whose
code it knows. The no-auth part is a deliberate, documented tradeoff; the
wide-open default is not, and is free to fix.

Fix: default to a deny/empty list, or at minimum require the variable in
production.

**Fixed.** `parseCorsOrigins` now takes `nodeEnv` (defaulting to
`process.env.NODE_ENV`, which `server/Dockerfile` sets to `production`). Unset
in production means an empty allow-list; unset in dev stays permissive. Prod is
served same-origin through nginx, so this costs nothing operationally.

---

## A′. Found while fixing

### - [x] A12. The engine tests ran in no package at all

`engines/fuzzy-match.test.ts` and `engines/pairing.test.ts` use `node:test`
(deliberately, per `docs/active/plans/2026-09-03-pairing-engine.md` — zero npm
dependencies). But `server`'s vitest only collects `**/*.spec.ts` under
`server/`, and `web`'s `ng test` only looks under `web/src`, so **nothing ran
these 40 tests** — including the tests for `generateRound`, the piece most of
the fixes above depend on.

Fixed by giving the root `package.json` real scripts:

```json
"test": "npm run test:engines && npm --prefix server test && npm --prefix web test",
"test:engines": "node --experimental-strip-types --test engines/*.test.ts"
```

`npm test` from the repo root now runs all 161 tests. All 40 engine tests were
already passing — they had simply gone unrun.

### - [ ] A13. The test suite is intermittently flaky

Two unrelated failures appeared once each across roughly a dozen full runs and
did not reproduce:

- `groups.controller.spec.ts` → 500, consistent with the `SQLITE_BUSY` under
  concurrent `@nestjs/testing` modules already described in the API-layer design notes
  (`WAL` + `busy_timeout` reduced it but did not eliminate it).
- `sessions.controller.spec.ts` → `Parse Error: Expected HTTP/, RTSP/ or ICE/`,
  a supertest/keep-alive artifact.

Not investigated — both are test-infrastructure noise rather than product
bugs, but they will erode trust in the suite. Worth either running the spec
files serially (`fileParallelism: false`) or giving each test file its own
database file.

### - [ ] A14. `class="ghost"` is inert on the court panel

`court-panel.html` puts `class="ghost"` on the Reshuffle button, but `.ghost`
is defined only in `group-entry.css`. Angular's default view encapsulation
scopes that rule to `GroupEntry`, so the Reshuffle button renders as a normal
primary button. Cosmetic, pre-existing, and left alone — flagged so it isn't
mistaken for a working style later. (The new **No result** button styles itself
in `court-panel.css` rather than inheriting the same dead class.)

---

## B. v2 candidates

### - [x] B1. Thai UI

§1 states the *entire* differentiator is Thai-language + LINE-friendly. Every
user-facing string outside `session-display.html`'s `รอคิว:` is English:
"Start next match", "Reshuffle", "Waiting", "End session", "Pair up. Play
more.", "Session not found."

This is the single largest gap between the product as documented and the
product as built. Ship `@angular/localize` with a `th` locale before any other
new feature.

**Done** (`931bea6`, `9472d2d`; plan in `docs/active/plans/2026-09-05-thai-ui.md`).
Thai is the source locale and is served at `/`, English at `/en/`. Server
messages are Thai too, since several reach the host verbatim. Noto Sans Thai
was added because Inter and Archivo carry no Thai glyphs at all — every Thai
string would otherwise have fallen back to each device's default face.

One field check still open: **read the display view from across the hall on
the real venue screen.** Thai has a smaller apparent x-height than Latin at the
same size, so `session-display.css` may want a size bump. Cosmetic, and the
only thing left from B1.

### - [ ] B2. Undo last action

The app is used one-handed, in a noisy hall, mid-game. A mis-tapped
"X & Y won" is currently permanent, and silently corrupts the data any future
rating model (B4) would depend on. Single-step undo on confirm and finish.

### - [ ] B3. Toggle a player in or out for tonight

One control per rostered player: sit them out, or bring them back. Replaces
what was first scoped as "remove a no-show" — a toggle is strictly better, for
three reasons:

- **One control covers every case.** No-show, arrived late, left early, resting
  a few rounds, injured, wrongly toggled. Removal needed a separate re-add path
  to undo itself; a toggle *is* its own undo.
- **It needs no special case for a player already on a court.** The rule is
  simply "excluded from future court fills", so someone toggled off mid-match
  plays that match out and is then skipped. Removal had to choose between
  refusing on an active pairing or mutating a confirmed one — see the git
  history of this entry for that dead end.
- **Nothing is destroyed.** Removal raised "does this delete the Player?"; a
  toggle obviously doesn't.

Sketch:

- Schema: a boolean on `SessionRoster` (default true). It belongs on the join
  row, not on `Player` — it is a fact about tonight, not about the person.
- `propose` and `swapPlayer` draw their pools from active roster entries only.
  That is the entire engine-side change; `generateRound` itself is untouched,
  since it already takes the roster as a parameter.
- The dashboard's roster chips become the control — tap a chip to toggle.
  Inactive chips render muted and drop out of the waiting queue.
- If the player is on a *pending* pairing when toggled off, the host taps their
  name to swap as they already can; the toggle deliberately does not do this
  implicitly, so it keeps its single meaning.
- Thai: **พัก** for sitting out, **กลับมาเล่น** to bring back — พัก is what
  players actually say. Confirm the wording before building.

### - [ ] B4. Skill / Elo balancing

§4 claims the schema needs no changes for this, and that is accurate —
`teamA`/`teamB`, `scoreA`/`scoreB`, `winner`, and `confirmedAt` are all
captured. §4's flagged soft dependency (optional scores → sparse data) is real,
but `winner` is a single tap and already recorded on every finished match, so
a win/loss Elo works without score entry ever improving.

Add a per-session mode toggle: *balanced* (minimize rating gap) vs *variety*
(today's behavior). Do B2 first so the input data is trustworthy.

### - [ ] B5. Wait timers

The waiting queue shows names but not how long each has been waiting — which is
the host's actual question. `confirmedAt` / `endedAt` are already stored;
derive minutes-waiting per player, sort by it, surface on both the dashboard
and the display view. Cheap, high perceived value.

### - [ ] B6. Display view auto-refresh

§7.3 rejected polling as "extra infra". Polling needs none: `setInterval` plus
the existing `LiveSessionService.refresh()`. Nobody walks across the hall to
tap refresh mid-game.

### - [ ] B7. "Fill all idle courts" in one tap

Session start with 3 courts is 3 propose + 3 confirm taps. The engine already
supports `courtCount > 1` (§6.3 usage note) — batch the endpoint.

### - [ ] B8. Session archive per group

`GET /groups/:code` returns only `lastSessionCode`
(`server/src/groups/groups.service.ts:19`). No way to browse past sessions. The
`Session` rows already exist; needs a list endpoint plus a history section on
`/g/:code`.

### - [ ] B9. Player page

`played` / `won` are already computed in `getStats`. Add best partner,
most-faced opponent, win rate. Naturally shareable back into the LINE group.

### - [ ] B10. PWA manifest

Weekly recurring use, on a phone, launched from a bookmark. Manifest + icon +
`display: standalone` is near-zero cost and makes the bookmark feel like an
app.

### - [ ] B11. Export and delete-group

§2 logs "no data-retention/deletion policy in v1" as an accepted risk. A
JSON/CSV export plus a hard group delete closes it, and doubles as the
migration path off SQLite if Postgres ever becomes necessary (§8.4).

### - [ ] B12. Host role

§2's other accepted risk (anyone with the link can edit). Keep deferred — only
worth building if abuse actually appears, exactly as §2 concluded.

---

## Suggested order

1. ~~A1 → A3 → A2, then A4, A5, A11, A10.~~ **Done**, plus A12.
2. ~~**B1 (Thai).**~~ Done.
3. **B3** — toggle a player in or out for tonight. One small feature.
4. **B2, B5, B6, B7.** Host ergonomics.
5. **B4 (Elo)** once B2 has protected the data quality it depends on.
6. **A13** whenever the flakes start costing time.

## Deploy note

`docker-compose.yml`'s volume line changed (A10). On the next deploy the API
container must be recreated, not just restarted, for the new mount to take
effect — `docker compose up -d --build` already does this. Existing data is
unaffected: the same `server/prisma/dev.db` file is still the database, now
reached through its parent directory.
