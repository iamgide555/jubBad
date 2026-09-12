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
> better by `git log` and `docs/archive/`. The numbers are left as written
> rather than remapped, since this is a point-in-time review; the original is
> `git show 0aac515:PROJECT.md`.

**Status:** everything in this document is built, including B12 as of
2026-09-12 — see its entry for why it sits on an unmerged branch rather than
`main`. Suite: 52 engine + 78 server + 100 web = 230 tests, all passing, both
packages building clean, as measured against `main` at review time; B12's
branch carries its own larger count, noted in its own entry.

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

### - [x] A7. Roster is frozen after session creation

§3 decided late-arrival add and no-show removal; §7.4 admits neither is built
("the roster panel only supports the initial paste-and-confirm flow").

Both happen at essentially every real session. Note §3 already established
that no engine change is needed — a new player has
`gamesPlayedThisSession = 0`, so existing priority logic handles them.

**Done, via B3's rest toggle**: a no-show is toggled out, and a rostered player
who turns up late is toggled back in.

### - [x] A8. "Copy as text" share button is missing

§3's v1 feature #4 lists it explicitly ("host views results in-app, shares
manually (screenshot, or 'copy as text' button)"). Not present in
`session-dashboard.html`. Sharing back to LINE is screenshot-only today, which
undercuts the LINE-friendly positioning in §1.

**Not fixed — feature, not defect.** Was bundled into B3; now stands alone and
unscheduled, since it has nothing to do with roster editing.

**Done.** A "คัดลอกเป็นข้อความ" button on the dashboard copies the courts and the
waiting queue as plain text. Built from what is already on screen rather than a
second server view, so the two cannot disagree. Clipboard access can be refused
(insecure origin, older browser), so the failure path says so rather than
leaving a dead button.

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
(deliberately, per `docs/archive/plans/2026-09-03-pairing-engine.md` — zero npm
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

### - [x] A13. The test suite is intermittently flaky

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

**Fixed — and it was two causes, not one.** `fileParallelism: false` in
`server/vitest.config.ts` settles the SQLite contention: with parallelism left
on, a Prisma `SocketTimeout` still reproduces within about a dozen runs, which
is what the earlier WAL and `busy_timeout` work could not remove, because
SQLite serializes writers regardless.

That was only half of it. The rest was supertest calling `listen()` for every
request when the server is not already listening; the churn surfaced as `socket
hang up` and a bogus `501 Not Implemented` that read like an application
failure. Both spec files now listen once in `beforeAll` and reuse that server.

Verified rather than assumed: 40 consecutive clean runs with both fixes, and
each cause reproduced independently before fixing it.

### - [x] A14. `class="ghost"` is inert on the court panel

`court-panel.html` puts `class="ghost"` on the Reshuffle button, but `.ghost`
is defined only in `group-entry.css`. Angular's default view encapsulation
scopes that rule to `GroupEntry`, so the Reshuffle button renders as a normal
primary button. Cosmetic, pre-existing, and left alone — flagged so it isn't
mistaken for a working style later. (The new **No result** button styles itself
in `court-panel.css` rather than inheriting the same dead class.)

**Fixed.** `.ghost` is now defined globally in `styles.css` alongside `.error`,
which had the identical problem. View encapsulation is exactly why a
per-component definition silently does nothing elsewhere.

---

### - [x] A15. A matchmaking fix from real play was silently reverted

Found 2026-09-08, while reviewing the engine before deploy. Fixed the same day.

`3af5021` made `propose` plan across every idle court and commit only the one
asked for. That was not a refinement — it was one of three faults reported
after an actual session, where two courts finishing together kept producing the
same opponents. Measured at the time, it moved faced-as-opponent from 3..15x
down to 6..8x.

The audit commit `2cae74d` replaced `generateRound(...)` with
`this.runGenerateRound(...)` throughout, and in `propose` it dropped the
`idleCourtCount` calculation and its explanatory comment along the way, passing
a literal `1`. The behaviour reverted to exactly what the real session had
complained about.

Two things made it invisible for a day:

- **The guarding test went with it.** `chooses a court's four with the other
  idle courts in mind` was deleted in the same commit, so nothing failed.
  Restored, and verified to fail against the reverted code before being
  accepted — a regression test that passes either way is worse than none,
  because it certifies the thing it no longer checks.
- **`overview.md` still described the intended behaviour**, so reading the
  documentation confirmed a fix that was no longer running. The docs were right
  and the code was wrong, which is the direction that survives review longest.

The lesson worth keeping is about the shape of the mistake rather than the line
of code: a large mechanical refactor across one file is exactly where a
behavioural fix disappears, because every hunk looks like the same rename. The
defence is not more care while refactoring — it is that behaviour learned from
real play should be pinned by a test whose deletion is itself conspicuous.

**Restoring it exposed a second, subtler error.** The audit had not simply
dropped the old test; it had rewritten it in place with the opposite assertion
and a new name, keeping the original setup and even the original comment, which
then contradicted the assertion below it. The audit's reasoning was that a
one-court proposal should commit the four players who have waited rather than
reserve them for a plan that is not being committed — sound in the abstract,
and it justified giving up cross-court planning.

The premise was unreachable. Both versions built their scenario by writing
roster and pairing rows directly: four players on six games, four on zero. A
session cannot reach that state. The roster is fixed when the session is
created, there is no route that adds a player to a running session, and
re-activating a player credits their `gamesOffset` up to the highest count
already on the roster — a fix made for exactly this reason (see the returning
player entries). Within a session the spread stays around one game, and when
two courts are idle and eight players are free nobody sits out at all, so
rotation has nothing to decide.

So the audit traded a measured improvement, from real play, for a guarantee
about a state that cannot occur. Rotation priority is still guarded, but now in
the only shape it can take: someone free who must be left out is the someone
who has already played.

Worth naming the general fault, because it is not carelessness and will recur:
a test written from reasoning rather than from a reachable state will look
rigorous, pass, and quietly forbid correct behaviour. The old test could only
be created by bypassing the API that makes its premise impossible — which is
the tell.

### - [x] A16. Notes written above the roster were silently dropped

Found 2026-09-08 by fuzzing the parser against its own contract; fixed the
same day.

The parser's stated rule is that nothing is discarded — anything it cannot
classify goes to `unrecognizedLines` or `warnings` for the host to review.
Everything above the first numbered line was read for a date, a time and a
venue, and whatever was left was then thrown away. So this message:

```
@All
แบดวินนิ่ง อังคาร 8/9/26
19.00-20.00  1 คอร์ท
ค่าสนามคนละ 80 บาท
ใครมาสายบอกด้วยนะ
1. ตั้ม
```

imported with `unrecognizedLines` empty. The court fee and the note about
arriving late were gone, with nothing on screen to say they had ever been
there. The identical note placed *below* the list was surfaced correctly, so
the behaviour depended on where in the message the host happened to type it —
a distinction no host could be expected to know about.

Header lines that the header parser made no use of now go to
`unrecognizedLines`, which the import screen already displays. A name stranded
above the roster start is covered by the same change.

Found by asserting the contract directly over 3,000 generated messages: every
non-empty input line must be traceable to the roster, the waitlist, the header,
`unrecognizedLines` or a warning. That property is worth more than any
individual case, because it fails on inputs nobody thought to write a test for
— which is precisely the population that reaches a parser fed by whatever
people type into LINE.

The fuzzy matcher was checked the same way over 5,000 rosters and needed no
change: no player is ever claimed twice, duplicates always point at a genuinely
earlier claim, fuzzy never fires below threshold, and the similarity metric is
symmetric and bounded. The double-claim invariant is the load-bearing one — a
repeat would abort the whole import on the roster's uniqueness constraint and
lose the host's paste.

## B. v2 candidates

### - [x] B1. Thai UI

§1 states the *entire* differentiator is Thai-language + LINE-friendly. Every
user-facing string outside `session-display.html`'s `รอคิว:` is English:
"Start next match", "Reshuffle", "Waiting", "End session", "Pair up. Play
more.", "Session not found."

This is the single largest gap between the product as documented and the
product as built. Ship `@angular/localize` with a `th` locale before any other
new feature.

**Done** (`931bea6`, `9472d2d`; plan in `docs/archive/plans/2026-09-05-thai-ui.md`).
Thai is the source locale and is served at `/`, English at `/en/`. Server
messages are Thai too, since several reach the host verbatim. Noto Sans Thai
was added because Inter and Archivo carry no Thai glyphs at all — every Thai
string would otherwise have fallen back to each device's default face.

One field check still open: **read the display view from across the hall on
the real venue screen.** Thai has a smaller apparent x-height than Latin at the
same size, so `session-display.css` may want a size bump. Cosmetic, and the
only thing left from B1.

### - [x] B2. Undo last action

The app is used one-handed, in a noisy hall, mid-game. A mis-tapped
"X & Y won" is currently permanent, and silently corrupts the data any future
rating model (B4) would depend on. Single-step undo on confirm and finish.

**Done.** `POST /sessions/:code/courts/:n/undo` reverses the single most recent
step on that court — a finish back to active, a confirm back to pending, an
unconfirmed proposal discarded so the court returns to idle. One rule rather
than three special cases, which matters because a mis-tapped winner is usually
noticed only after the next match has been proposed; two taps get back to it.

Undoing a finish refuses with `players-busy` when any of those four has since
been picked up by another open match, since restoring would double-book them.

### - [x] B3. Toggle a player in or out for tonight

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
  players actually say.

**Done.** Built as sketched. `SessionRoster.active` (migration
`20260905174000_add_session_roster_active`), `POST
/sessions/:code/roster/:playerId/active` taking the desired state rather than a
flip so two taps in flight are idempotent, and the roster chips as the control
— a resting chip renders muted, dashed and struck through, stays legible so the
host can find it to tap back, and drops out of the waiting queue.
`generateRound` was untouched, as predicted.

### - [x] B4. Skill / Elo balancing

§4 claims the schema needs no changes for this, and that is accurate —
`teamA`/`teamB`, `scoreA`/`scoreB`, `winner`, and `confirmedAt` are all
captured. §4's flagged soft dependency (optional scores → sparse data) is real,
but `winner` is a single tap and already recorded on every finished match, so
a win/loss Elo works without score entry ever improving.

Add a per-session mode toggle: *balanced* (minimize rating gap) vs *variety*
(today's behavior). Do B2 first so the input data is trustworthy.

**Done.** `engines/elo.ts` computes win/loss Elo over the group's history,
replayed in `confirmedAt` order. Scores are ignored deliberately: they are
optional, so a score-based rating would be sparse and biased toward whoever
types numbers in, while `winner` is one tap and recorded on nearly every match.
K is 16 — low, because doubles outcomes are noisy and a rating that swings on
one unlucky game would make balanced mode feel arbitrary.

`Session.mode` toggles between `variety` (unchanged behaviour) and `balanced`,
which adds a rating-gap term to the arrangement score. At the chosen divisor a
100-point gap costs the same as one repeat partner, so the search will accept a
repeated partner to avoid a real mismatch but will not chase a marginal one.
Passing no ratings removes the term entirely, so variety mode scores exactly as
it always did.

### - [x] B5. Wait timers

The waiting queue shows names but not how long each has been waiting — which is
the host's actual question. `confirmedAt` / `endedAt` are already stored;
derive minutes-waiting per player, sort by it, surface on both the dashboard
and the display view. Cheap, high perceived value.

**Done.** `GET /sessions/:code` now returns `createdAt` and `lastPlayedAt`
(player id to the time they last finished). Waiting time is derived from those
in `web/src/app/core/waiting-time.ts` rather than stored, so there is no clock
to keep in sync — a player with no entry has been waiting since the session
started, which is why a missing entry is meaningful rather than absent data.
The queue sorts longest-wait-first on both the dashboard and the display.

### - [x] B6. Display view auto-refresh

§7.3 rejected polling as "extra infra". Polling needs none: `setInterval` plus
the existing `LiveSessionService.refresh()`. Nobody walks across the hall to
tap refresh mid-game.

**Done.** The display view refreshes itself every 30 seconds. §7.3 rejected
polling as "extra infra", but it needs none — an interval plus the `refresh()`
that already existed. The manual button stays for anyone who wants it sooner.

### - [x] B7. "Fill all idle courts" in one tap

Session start with 3 courts is 3 propose + 3 confirm taps. The engine already
supports `courtCount > 1` (§6.3 usage note) — batch the endpoint.

**Done.** `POST /sessions/:code/courts/fill` proposes for every idle court in
one `generateRound` call across all of them, rather than a loop of single-court
calls, so the arrangement is scored as a whole and nobody can land on two
courts. Busy courts are left alone and their players stay reserved. The button
only appears when a court is actually idle.

### - [x] B8. Session archive per group

`GET /groups/:code` returns only `lastSessionCode`
(`server/src/groups/groups.service.ts:19`). No way to browse past sessions. The
`Session` rows already exist; needs a list endpoint plus a history section on
`/g/:code`.

**Done.** `GET /groups/:code/sessions` lists sessions newest first with a match
count, and `/g/:code` shows them above the paste box, tagging any session that
has not been ended.

### - [x] B9. Player page

`played` / `won` are already computed in `getStats`. Add best partner,
most-faced opponent, win rate. Naturally shareable back into the LINE group.

**Done.** `GET /groups/:code/players/:id/stats` returns record, win rate, Elo
rating, most-wins-with partner and most-faced opponent, rendered at
`/g/:code/p/:id` and linked from every name in the stats table. The partner
metric is **win rate together** over a floor of 5 decisive games, ties going to
the pair that has played more (2026-09-08). It is named `bestPartner` and
labelled "คู่ที่ดีที่สุด". Two earlier attempts are worth recording: it began as
a raw count called "best partner", which promised a judgement it did not make;
finding 33 renamed it to `mostWinsWith` to match the arithmetic; the owner then
confirmed that best partner really did mean best win rate, so the arithmetic
moved to meet the name instead. The floor is what makes that safe — without it
a single lucky game shows as a 100% partner. Below the floor the response falls
back to most wins together and sets `provisional`, and the profile drops the
percentage and says why, so a new group sees an honest count rather than an
empty panel. The rate counts decisive games only, since an abandoned match was
played but proves nothing about the pairing. A player who
has not finished a match gets a null win rate rather than 0%, since those are
different facts.

### - [x] B10. PWA manifest

Weekly recurring use, on a phone, launched from a bookmark. Manifest + icon +
`display: standalone` is near-zero cost and makes the bookmark feel like an
app.

**Done.** `web/public/manifest.webmanifest` plus generated icons (a badminton
court, drawn to the app's own palette) and the iOS meta tags. `start_url` and
`scope` are relative so installing from `/en/` starts in English rather than
bouncing to Thai.

### - [x] B11. Export and delete-group

§2 logs "no data-retention/deletion policy in v1" as an accepted risk. A
JSON/CSV export plus a hard group delete closes it, and doubles as the
migration path off SQLite if Postgres ever becomes necessary (§8.4).

**Done.** `GET /groups/:code/export` returns the whole group as JSON — players
with real alias arrays, every session, every match — and `DELETE /groups/:code`
removes it all in one transaction. Both sit behind a "จัดการก๊วน" disclosure on
`/g/:code`, and delete stays disabled until the group's name is typed back,
since there is no auth and no undo behind it.

The access question that raises is a recorded accepted risk — see the end of
this file.

### - [x] B12. Per-user login (host role)

**Built 2026-09-12, on branch `worktree-per-user-auth` — not yet merged.**
This entry was rewritten twice while the work was still pending, and that
history is kept below because the reasoning is what explains why the branch
sits finished and unmerged rather than being a delay. Design in
`docs/archive/plans/2026-09-12-b12-per-user-login.md`.

What existed before: a global default-deny guard (`AdminGuard`, registered as
an `APP_GUARD`) — every route required the one shared admin cookie unless
explicitly `@Public()`. `auth.boundary.spec.ts` walked the router Express
actually built rather than a hand-kept list, so "anyone with the link can
edit" was already closed. What was genuinely missing was *identity*:

- The token was one shared secret, so everyone given it had equal power,
  including deleting a group.
- It granted access to every group, not the one someone hosts. There was no
  concept of owning a group.
- Revocation was all-or-nothing: changing the token signed out every device.

All three are closed now. `AuthGuard` replaces the shared-token guard with
real accounts (email + password, scrypt-hashed, signed session cookie).
`OwnershipGuard` — a second global guard running after it — resolves
`Group.ownerId` (a new, nullable-by-necessity column; nullable because the
migration cannot create the admin account that backfills it, see the schema
comment) and refuses any non-owner with a 404, never a 403, so a code's mere
existence is never confirmed to someone who doesn't own it. An admin role
bypasses ownership entirely and manages every user and group from `/admin`.
Disabling a user bumps only their `tokenVersion`, so revocation is per-user,
not all-or-nothing. A new `/admin` console covers user CRUD, the delete-user
disposition flow (every group a deleted user owns must be explicitly
reassigned or deleted — never both, in one atomic transaction with the user
row), group reassignment, and the forgot-password request queue. Password
reset is a one-time link an admin sends by hand (LINE, usually) — there is no
SMTP, so there is no automated delivery, matching this app's existing
paste-based, no-infra posture.

**Why unmerged rather than shipped:** the sequencing the owner set on
2026-09-08 — behind the current build being validated in real sessions, since
authentication touches every route and changing it while the core is unproven
would give any later fault two plausible causes — governs the *merge*, not
whether the work gets built. Building it on a branch and holding the merge
satisfies both: the design and tests exist now, and `main` still runs Tuesday
sessions on the code that has actually been played on. The branch stays
unmerged until the parts no test can cover have run for real: manual swap
under a thumb on a phone, the backup and restore scripts against the real
database, and the partner metric once pairs actually cross five games
together.

---

### B13. A roster of exactly 4 x courts locks players into fixed fours

**Status:** known and accepted for now, 2026-09-08. Measured, not suspected.

With 12 players on 3 courts, each player partners with **3 of the other 11 all
night**. With 16 on 4 courts, 3 of 15. Give the same group one spare player and
it jumps to 7-10.

This is not a scoring bug, and no change to the weights will move it. Courts
finish one at a time, so when court 1 ends and the others are mid-match the
only free players are the four who just walked off. `propose` correctly offers
the engine exactly those four, and four players have only three possible
splits. The engine already rotates all three -- it is extracting everything
available to it. What never happens is the pods themselves mixing, so the
groups formed in the first round persist for the whole session.

Worth stating plainly because it defeats the engine's main purpose in the most
ordinary setup there is: a full roster with nobody resting is precisely the
case where "I always play with the same people" comes back.

Measured over ten simulated nights, twelve matches per court, staggered finish
times:

| Roster | Courts | Spare | Distinct partners per player |
| --- | --- | --- | --- |
| 8 | 2 | 0 | 3 of 7 |
| 12 | 3 | 0 | 3 of 11 |
| 16 | 4 | 0 | 3 of 15 |
| 13 | 3 | +1 | 7-10 of 12 |
| 17 | 4 | +1 | 7-10 of 16 |

Games-played fairness is unaffected either way; this costs variety only.

Re-measured after restoring the plan-across-idle-courts behaviour (see A15) and
the numbers are identical, which is the expected result rather than a
disappointing one: that fix helps when several courts are idle at once, and in
the steady state of a full session exactly one court is free at a time.

**Why it is accepted rather than fixed:** the host can break a pod by dragging
a player between courts, which is now available. Note that **reshuffle does not
help** -- it re-splits the same four and can only reach the same three
arrangements. Only the cross-court drag, or a change in roster size, mixes
pods. Anyone acting on this entry should not substitute the one for the other.

**If it needs solving later**, the cheap option is a dashboard hint when
`roster == 4 x courts` ("nobody is resting, so the same four keep sharing a
court -- drop to N-1 courts or add a player"), which turns an invisible
property into a choice. The thorough option is holding finishers until a second
court frees so eight players can be mixed at once, which buys real variety at
the cost of making people wait -- likely the wrong trade for a casual night.

---

### B14. Adding a player mid-session must credit them like a re-activation

Not a defect — a constraint on work that does not exist yet, written down
because something already depends on it.

There is currently no way to add a player to a running session; the roster is
fixed when the session is created, and a late arrival is handled by starting
them inactive and switching them on, which credits their `gamesOffset` up to
the highest count already on the roster. That single fact is what keeps the
within-session spread near one game, and A15 leans on it to argue that a large
games gap is unreachable.

If an add-to-session feature is ever built, it must apply the same credit. A
player inserted on zero while everyone else is on five would win every rotation
draw until they caught up — the exact complaint that produced the credit in the
first place — and it would also quietly invalidate the reasoning in A15, which
would then be wrong without anyone touching it.

Anything that changes how players enter a session should re-read A15 rather
than only this entry.

## Suggested order

Everything here is done except B13. B12 is also done, but sequenced last on
purpose and unmerged: it changes the layer every route passes through, so it
should not merge until the current build has been proven in real sessions.
See its entry for the full reasoning and for what "proven" means concretely.

B13 is a measured limitation with a manual workaround, not scheduled work. It
is worth reading before anyone tunes the pairing weights, because it looks like
a scoring problem and is not one.

B14 is not work at all — it is a condition that any future change to how
players enter a session has to meet.

## Export and delete: accepted risk (resolved 2026-09-07)

**This risk is closed.** It is kept here because the reasoning is worth
retaining, not because it is still live.

Originally, export and delete were gated only by knowing the group code — the
same 8-hex-char code that gated editing. §2 accepted "anyone with the link can
edit" when the worst case was a messed-up session someone could fix by hand.
Export widened that to "walk off with every name and every result", and delete
to "destroy the group's whole history, irreversibly". The call at the time was
to leave it: the link lives in one private group chat among people who already
know each other, and the alternatives each cost more than the risk was worth.

Admin authentication was subsequently built, which resolved this without the
per-group passphrase that was considered and rejected. `GET /groups/:code/export`
and `DELETE /groups/:code` carry no `@Public()` marker, so the global
`AdminGuard` closes them: knowing a group code is no longer sufficient to read
or destroy a group. A leaked code is now an editing-surface question at worst,
not a data-exfiltration one.

The delete button still sits behind a disclosure and requires typing the
group's name. That guards against a mis-tap, which is the realistic failure
now that an intruder has to get past the token first — and it was never meant
to be the guard against the intruder.
