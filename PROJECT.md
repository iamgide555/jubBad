# Badminton court pairing app

## 1. Opportunity

Existing apps (Racket Social, Kiki-match, Badminton Match Manager, Qcourt,
GroupSlam, etc.) already solve fair doubles pairing, rotation, sit-out
balancing, and cost splitting — well. Not worth rebuilding.

The gap: **nothing is Thai-language + LINE-friendly, and built to fit
alongside the tools these groups already use** (LINE for coordination,
KhunThong for PromptPay splitting) for casual Thai badminton groups.
Existing pairing apps are English-first, generic multi-sport tools with
their own account/PWA/bot ecosystems. Existing Thai badminton apps
(e.g. Lenkila) are court-booking/partner-finding marketplaces, not
session-running tools for an existing regular group.

The differentiator is localization + fitting into how these groups
already coordinate (LINE group chat, existing bots like KhunThong for
splitting bills) — not a smarter pairing algorithm or a bigger feature set.

## 2. Key product decisions (and why)

| Decision | Why |
|---|---|
| No bot in the LINE group chat, ever | A posting bot notifies people who aren't even playing that day — spammy |
| No passive "listener" bot | Even listen-only, it technically sees the *entire* conversation; host's consent doesn't cover the other ~15-20 people in the chat. Bigger trust risk than the convenience is worth for a casual friend group |
| Import is paste-based | App's data footprint = exactly what the host explicitly hands over. No infra (no webhook server, no persistent message store) |
| No LIFF / LINE Login / LINE platform integration in v1 | Paste-based import + manual share means zero technical touchpoint with LINE's platform is needed. Pure UX polish, addable later |
| No login/auth in v1 | Groups identified by shareable link/code instead of accounts. Removes a whole feature surface |
| Trigger-word LINE bot (reconsidered, still rejected) | Idea: bot watches group for a keyword ("Play") then auto-extracts the roster, skipping manual paste. Rejected on inspection — LINE Messaging API has no message-history endpoint (confirmed via LINE docs), so a bot can only look *forward* from when it joins. Real usage is roster posted days before "Play" is typed, so the bot would need to continuously store *all* group messages in a rolling buffer to look backward — that's full passive listening + retention, the exact risk already rejected above, not a lighter trigger-gated version. Also reopens "no infra" and "no posting bot" decisions at once. Revisit only if paste-based friction proves to be a real dealbreaker after real sessions; a lower-risk fix for the "typing/copying name" pain is a tap-to-register roster link instead |
| No cost-splitting / PromptPay QR generation in-app | KhunThong (ขุนทอง), KBank/KBTG's LINE bot, already does this well — bill split (equal or not), PromptPay QR, and payment verification via e-slip scan, which our planned v1 didn't even have. Same "not worth rebuilding" logic as the pairing-app landscape in §1. Host just invites KhunThong separately; no integration needed |
| Score logging: final score only, no live scoreboard | Point-by-point/serve-indicator/timers is scope creep nobody asked for. Final score per court is low-friction and still bootstraps match-history data for future skill/Elo balancing |
| No host role — anyone with the link can edit (**accepted risk**) | No auth means the link doesn't distinguish host from player. Acceptable for a trusted friend-group context; add a host role later only if abuse becomes real |
| No data-retention/deletion policy in v1 (**accepted risk**) | Names persist indefinitely under a group's link code. Revisit if group turnover or privacy requests make it necessary |

## 3. v1 feature set

1. **Import from LINE (paste-based)** — host pastes the roster message
   text; app parses date/time, court count, main roster, waitlist
   (สำรอง) separately. Fuzzy-matches names against known players and
   flags new/unmatched names for host confirmation. Nothing is
   auto-committed without host review.
2. **Roster review** — host reviews/edits the imported (or manually
   entered) list, confirms it. See §7 for the full UI flow.
3. **Fair pairing engine, per court, independently** — courts rotate
   on their own schedule (not synchronized "rounds") — whoever finishes
   first gets the next match right away. Avoids repeat partners,
   softly balances repeat opponents, and prioritizes whoever's waited
   longest to play next. History tracked per group across sessions
   (not just within one session). See §7 for the UI flow, §6.3 for the
   engine.
4. **Manual sharing** — host views results in-app, shares manually
   (screenshot, or "copy as text" button), plus a read-only display
   view for a venue screen/projector. No bot, no auto-posting.
5. **Match result logging** — after a court's match finishes, host
   optionally enters final score (e.g. "21-15"), stored against that
   match's record. No live scoreboard.

**Mid-session edits — decided.** No new algorithmic work — both
`fuzzy-match.ts` and `pairing.ts` already compose correctly around one
app-level rule: **history (`partnerCounts`, `opponentCounts`,
`gamesPlayedThisSession`) only updates when a court's match is
*confirmed* (host taps confirm/start — see §7), never on generation.**

- **Reshuffle** — regenerate a court's current, not-yet-confirmed
  match (host doesn't like the draw, taps reshuffle before anyone
  plays): just call `generateRound` again with a new random seed for
  that court. Free and unlimited, since nothing has been committed to
  history yet.
- **Late arrival** — add the player to the roster array used for the
  *next* idle-court fill. Their name goes through the fuzzy-match
  layer like initial import. No engine change needed: a new player
  naturally has `gamesPlayedThisSession = 0`, so the existing
  priority logic already prioritizes them to play as soon as a court
  frees up.
- **No-show removal** — remove the player from the roster/waiting pool
  for future court fills. Past confirmed/played matches are never
  retroactively edited. If someone assigned to a *current unconfirmed*
  match turns out to be a no-show, that's just "remove them, then
  reshuffle that court."

## 4. Explicitly out of scope for v1

- Skill/Elo-based match balancing — schema already supports adding
  this later with **no changes needed**: `Pairing.teamA`/`teamB` (who
  played with/against whom), `scoreA`/`scoreB` (outcome + margin), and
  `confirmedAt` (a real timestamp, giving the chronological order a
  rating algorithm like Elo needs to replay history) are already
  captured. The one soft dependency: `scoreA`/`scoreB` are optional
  (§3), so ranking quality later depends entirely on how consistently
  hosts bother entering scores — a match with no score is invisible to
  a future rating model. Nothing to change now, just worth knowing.
- Multi-sport support (badminton-only, Thai-only — that's the moat)
- Any LINE bot (posting OR passively listening) — reconsidered, still out; see §2
- LIFF / LINE Login
- User accounts / login
- Live point-by-point scoreboard
- Cost splitting / PromptPay QR generation — delegated to KhunThong (ขุนทอง)

## 5. Tech stack

- **Frontend:** Angular (plain web app, no LIFF wrapper for v1)
- **Backend:** NestJS — parsing logic, pairing/rotation engine
- **DB:** relational

```
Group        — id, name/link-code (no user auth)
Player       — id, groupId, name, aliases[] (fuzzy-match targets;
               populated when host confirms an unmatched import name
               maps to an existing Player)
Session      — id, groupId, date, courtCount, rawImportText (kept for
               parser debugging)
Pairing      — id, sessionId, courtNumber, matchNumber (sequential
               per court, since courts rotate independently — no
               shared "Round" batches them together, see §7),
               teamA[2 playerIds], teamB[2 playerIds],
               scoreA, scoreB (nullable), confirmedAt (the
               history/games-played commit point — see §7)
Waitlist     — id, sessionId, playerId, position
```

## 6. Core engines — design notes

### 6.1 LINE roster-message parser — **built** (`parser.ts`)

Parses a LINE badminton-session roster message (Thai format) into
structured data: header (date, time slots, court count/numbers, venue),
main roster, waitlist. Source: `src/parser.ts`. Verified against 3 real
example messages from the user's actual LINE groups: `src/test-examples.ts`.

Design principles:
- **Lenient, not strict** — heuristic parsing; real messages vary in
  spacing, punctuation, trailing whitespace on empty slots.
- **Never silently drop or guess** — anything ambiguous (e.g. 2-digit
  year, Buddhist vs. Gregorian) goes to a `warnings` array; anything
  unclassifiable (หมายเหตุ notes) goes to `unrecognizedLines`, never
  discarded.
- **Empty numbered slots preserved** (`3.` → `{position: 3, name: null}`)
  so slot counts stay accurate before names are filled in.
- **`@All`/`@all` excluded from venue detection** — looks like an
  `@venue` tag syntactically but means something different.

### 6.2 Fuzzy-match layer — **built** (`fuzzy-match.ts`)

Parsed roster/waitlist names → known `Player` records for the group.

**Algorithm:** normalized Levenshtein, no auto-link on a fuzzy match —
only on exact match. Reasoning: Thai nicknames here run 2-4 chars
(ปอม, ตี๋, เบส); bigram/Dice similarity is weak at that length (one
edit breaks most bigrams), and the namespace is small/dense enough that
near-misses are often distinct people (e.g. "เกีย" vs "เกียร์" are two
different players across the example messages). Auto-linking on a fuzzy
score risks a wrong silent merge — extends the parser's "never silently
guess" principle rather than inventing new tolerance rules.

1. Normalize: strip trailing `(...)` note (e.g.
   `พี่แวน(พี่ที่ทำงานไกด์)` → `พี่แวน`), trim, Unicode NFC.
2. Exact match (post-normalize) vs `Player.name` + `aliases[]` →
   auto-link (still shown in review screen, never hidden).
3. No exact match → normalized Levenshtein similarity
   (`1 - distance/maxLen`) vs all known names+aliases for the group.
   Score ≥ 0.7 → surface as "ใช่ [X] ไหม?" suggestion, host taps
   confirm/reject. Below 0.7 → flag "new player?".
4. Host confirms a fuzzy/new mapping → pasted text saved as new
   `Player.alias`.
5. Implement inline in TS (~15 lines, no npm dep) — matches
   `parser.ts`'s no-dependency style.

### 6.3 Pairing/rotation engine — **built** (`pairing.ts`)

Input: confirmed roster + court count + partner-history AND
opponent-history from prior `Pairing` records for the group (**all-time**
across sessions — the whole point is spreading out variety over the
group's life, not just one evening) + games-played-so-far **this
session only** for sit-out fairness (see below — deliberately a
different scope than the partner/opponent history). Output: this
round's court assignments, minimizing repeat partners and balancing
who sits out.

**Opponent-balancing decision:** in scope for v1, as a secondary
soft signal — not an equal-weight constraint. Repeat-*partner*
avoidance stays the primary goal; repeat-*opponent* balancing only
ever breaks a tie between arrangements that are already equally good
on partners. Reasoning: the host (also a player) confirmed people
care about both, but "if possible" — a hard opponent constraint on
top of the partner constraint risks making sessions with a lot of
history unsolvable, since it over-constrains an already-small
namespace (casual groups, not a large league).

**Algorithm:** score every candidate court arrangement for the round:

```
score = 10 × (repeat-partner pairs in this arrangement)
      +  1 × (repeat-opponent pairs in this arrangement)
```

Pick the arrangement with the lowest score. The 10:1 weight ratio
means an arrangement never trades away a partner-repeat to save on
opponent-repeats — the opponent term only decides between arrangements
already tied on partner-repeats. Example (4 players, 1 court, ตั้ม+เบส
already partnered twice, ปอม+ไม้ already opponents 3 times):

| Arrangement | Repeat partners | Repeat opponents | Score |
|---|---|---|---|
| ตั้ม+เบส vs ปอม+ไม้ | 1 | 0 | 10 |
| ตั้ม+ปอม vs เบส+ไม้ | 0 | 1 (ปอม-ไม้) | 1 |
| ตั้ม+ไม้ vs เบส+ปอม | 0 | 1 (ปอม-ไม้) | 1 |

Row 1 loses outright on the partner term alone; rows 2 and 3 tie (both
still cross ปอม-ไม้ as opponents) — a tie the algorithm breaks
arbitrarily (e.g. first found), since there's no further signal to
prefer one over the other.

**Sit-out selection — decided.** Deterministic, not part of the
weighted score: rank roster players by games-played *this session only*
(resets each session — rotation is fair within today's rounds, not
carried over from weeks ago), and whoever needs to sit out this round
is whoever has played the *most* rounds so far today, ties broken
randomly. Predictable to the host ("they've played the most today, so
they sit") and keeps rotation fair without folding another term into
the scoring formula above.

Number who must sit out this round = `roster.length - usableCourts * 4`,
where `usableCourts = min(courtCount, floor(roster.length / 4))` — a
court always needs exactly 4 players, so a roster that isn't a multiple
of 4 leaves a remainder sitting out even when `courtCount` itself isn't
exceeded (e.g. 10 players, 3 courts: only 2 courts are usable, 2 people
sit out).

**Search strategy — decided.** Real groups run 10-20+ players across
2-3 courts; exhaustively scoring every possible court arrangement (as
in the 4-player example above) is combinatorially infeasible at that
size. Use randomized search instead: shuffle the (non-sitting-out)
roster, greedily build one candidate arrangement from the shuffle,
score it with the formula above, repeat ~200 times, keep the
lowest-scoring candidate. "Good enough and fair," not "provably
optimal" — matches this project's existing no-dependency,
no-over-engineering style (`parser.ts`, `fuzzy-match.ts`). A real
matching-theory optimizer (min-cost perfect matching) would be
overkill for a casual v1.

**Usage note — courts rotate independently, not as synchronized
rounds** (decided in §7): `roster` and `courtCount` were never required
to mean "everyone in the session" and "every court" — they're just
parameters. The app calls `generateRound` with `courtCount = 1` and
`roster = ` only the players currently *not* occupying another active
court, every time a single court frees up. `courtCount > 1` is still
used when multiple courts are idle at once (e.g. session start, before
anyone is playing). No engine change was needed for this — see §7 for
why.

## 7. UI/UX design

Two views, matching how the host actually runs a session: host phone
(interactive) + a venue screen/projector (read-only, "courts + who's
waiting").

### 7.1 Routes

- `/g/:groupCode` — group entry point. Host bookmarks this once; opens
  it weekly to either resume an active session or paste today's roster
  to start a new one. Each session gets its own URL below (not one
  mutable "current session" pointer) — cleaner to share/archive as the
  app scales to more groups.
- `/s/:sessionCode` — the session dashboard (§7.2). Created once the
  host confirms a roster.
- `/s/:sessionCode/display` — read-only variant of the same session,
  cast to a venue screen/projector separately from the host's phone.

### 7.2 Session dashboard (host phone)

One screen, stacked sections — not a step-by-step wizard, since courts
rotate in a loop rather than moving through the flow once.

**Roster panel** — one panel, three states:
1. Paste box (raw text + "Parse") — shown until first parse.
2. Confirm/review list — fuzzy-match results per name (exact matches
   auto-linked but still shown, fuzzy suggestions need confirm/reject,
   new-player flags), "Confirm roster" button. See §6.2.
3. Collapsed chips — roster locked in. Still allows **+ add late
   arrival** (re-opens a mini version of state 2 for just that name)
   and **remove** (no-show), both of which only affect future court
   fills — see §3's mid-session-edits note.

**Court panels** — one per court, each with its own independent
lifecycle (no shared "round" state across courts):

```
IDLE                          ACTIVE
┌───────────────────┐         ┌───────────────────┐
│ Court 2            │        │ Court 2            │
│                    │        │ ตั้ม + ไม้          │
│                    │        │      vs            │
│ [Start next match] │        │ เบส + ปอม          │
└───────────────────┘         │                    │
                                │ Score: [__]-[__]  │  <- optional
                                │  [Finish match]   │
                                └───────────────────┘
```

- Idle → `[Start next match]` calls `generateRound` scoped to this one
  court (see §6.3 usage note) → shows the proposed pairing with
  `[reshuffle]` (free, re-rolls) and `[confirm]`.
- Confirmed → active: pairing locked, this is the history-commit point
  (`partnerCounts`/`opponentCounts`/`gamesPlayedThisSession` update
  here, not on generation — §3).
- Active → `[Finish match]` is the single action that both saves
  whatever score was entered (score is optional, never blocks
  finishing) and returns those 4 players to the waiting pool, freeing
  the court back to idle.

**Waiting/queue panel** — shows who's currently in the waiting pool,
ordered by priority (longest-waiting/fewest-games-played first, same
ranking `generateRound`'s sit-out logic already produces). Transparency
for host and players, cheap to add since the engine already tracks
`gamesPlayedThisSession`.

### 7.3 Display view (venue screen/projector)

Read-only, no host controls, big text for cross-room readability:

```
┌──────────────────────────────────────┐
│         แบดวินนิ่ง อังคาร              │
│                                        │
│  COURT 1            COURT 2           │
│  ตั้ม + ไม้          เกม + ปอม          │
│    vs                 vs              │
│  เบส + ปอม          ไกด์ + บูม         │
│                                        │
│  รอคิว: ซัน, ไบรท์                     │
│                                        │
│            [↻ refresh]                │
└────────────────────────────────────────┘
```

Manual refresh, not auto-polling or live push — matches the app's
existing no-extra-infra style (no websocket server, no polling loop
running for the whole session). Whoever's near the screen taps refresh
after a court's match changes.

### 7.4 Build status

Routing is built (`web/`, Angular 22, standalone components, Vitest):
`/g/:groupCode` → `GroupEntry`, `/s/:sessionCode` → `SessionDashboard`,
`/s/:sessionCode/display` → `SessionDisplay`.

Roster panel is built: `GroupEntry` handles paste → confirm (parsed
header fields + fuzzy-match review per name) → confirm creates a
`Session` and persists `Player` records to `localStorage`, then
navigates to `/s/:sessionCode`, where `SessionDashboard` renders the
confirmed roster as chips. Business logic lives in
`web/src/app/core/roster-review.ts` (`buildReviews`, `resolveReviews`)
and `web/src/app/core/roster.service.ts` — both call the root-level
`parser.ts`/`fuzzy-match.ts` engines directly by relative import
(`allowImportingTsExtensions` + `rewriteRelativeImportExtensions` in
`web/tsconfig.json` make this work).

Court panels + waiting queue are built on `SessionDashboard`: one
`CourtPanel` per court (idle → `[Start next match]` → pending →
`[reshuffle]`/`[confirm]` → active → `[Finish match]`), plus a waiting
queue listing everyone not currently on a court. `LiveSessionService`
(component-scoped, fresh per session visit) holds an append-only
`matches` log and per-court state in `localStorage`, calling
`pairing.ts`'s `generateRound` directly (`courtCount=1`, scoped to
whoever isn't reserved by another court) for both starting and
reshuffling — the same operation either way. History
(partner/opponent/games-played) is derived from the match log on
demand via `deriveHistory`, and is **within-session only** for now —
real cross-session history needs the backend, not built yet.

`Group` is now a real entity (`code`, `name`) — editable from
`GroupEntry`, persisted in `localStorage` (`group:${groupCode}`), and
carried forward to every future session under that group.

Display view is built (`SessionDisplay`, `/s/:sessionCode/display`):
read-only, big text, its own `LiveSessionService` instance reading the
same session state as `SessionDashboard`. Header shows `Group.name` if
set, else falls back to `date · venue`. Only `active` courts show a
pairing — `idle`/`pending` courts render as "waiting", so a
proposed-but-unconfirmed pairing never reaches the venue screen.
Manual `[↻ refresh]` re-reads from `localStorage` — no auto-polling or
live push, matching the app's no-extra-infra style.

All 4 pieces of §7's UI/UX design are now built. Add-late-arrival /
remove-no-show interactivity (§3's mid-session-edits decision) is not
built yet — the roster panel only supports the initial paste-and-confirm
flow.

## 8. Backend design (draft — pending your review)

Written overnight per request, autonomously — no interactive
back-and-forth on the calls below. Marked **RECOMMENDATION** (low-risk
default, easy to change) vs **NEEDS YOUR SIGN-OFF** (expensive to
reverse once built on) so review time goes where it matters.

### 8.1 The big fork: where do the engines run? — **decided: server-side**

§5's original tech-stack line says "Backend: NestJS — parsing logic,
pairing/rotation engine" — i.e. the original intent was for
`parser.ts`/`fuzzy-match.ts`/`pairing.ts` to run *server-side*. What
actually got built (§7) runs them *client-side*, bundled straight into
the Angular app, with the backend never in the loop for computation —
only for holding data. That was the right call at the time (no backend
existed yet, and building the UI against real engine logic beat
building it against nothing), but it's a real fork now that a backend
is being built for real.

**Decided: move them server-side**, matching §5's original wording.
Client sends raw actions (paste text, "start next match") to NestJS,
server runs `parser.ts`/`fuzzy-match.ts`/`pairing.ts`, returns results.
Reasoning: the deciding factor was a real correctness gap in the
client-side alternative — if two different devices both trigger
"start next match" for two different courts at nearly the same
moment, each computes its proposal against its own locally-fetched
snapshot of "who's already on a court." If both snapshots are
slightly stale, the *same player* could get assigned to two courts at
once — a server computing the decision itself can serialize writes
and avoid this; client-side fundamentally can't. Chosen for
future-proofing multi-device use (host's phone + others potentially
interacting with the same session), even though today's actual usage
is closer to single-host-at-a-time.

Real cost, accepted: re-plumbing every `GroupEntry`/`CourtPanel`/
`SessionDisplay` call site from a direct function call to an HTTP
round-trip — a meaningful slice of the last 4 implementation plans'
work gets redone at the call-site level (the pure engine logic itself
doesn't change at all, just who calls it and how). `parser.ts`/
`fuzzy-match.ts`/`pairing.ts` stay exactly as built and tested (39
engine tests unaffected) — they're isomorphic, so NestJS imports them
by relative path the same way Angular did, no source changes needed.

**Scaffold built and cross-boundary import proven** (`server/`, see
`docs/superpowers/plans/2026-09-04-nestjs-scaffold.md`). NestJS's `tsc`-based
build is stricter than Angular's esbuild bundler about this: needed
`allowImportingTsExtensions`/`rewriteRelativeImportExtensions` plus a
`rootDir` widened to the repo root in `tsconfig.build.json` (Angular's
bundler never enforced `rootDir` at all), and a root-level
`package.json` (`{"private": true, "type": "module"}`) so the engines
compile to ESM matching `server/`'s own output — without it, the build
succeeds but the app crashes at runtime with a missing-export
`SyntaxError`. One layout consequence: the widened `rootDir` means
compiled app files land at `dist/server/src/*.js`, not the default
`dist/src/*.js` — `start:prod` points at the former. Next up: the API
endpoints (§8.3) and Prisma schema (§8.2/§8.4).

### 8.2 Schema refinement — `Pairing` needs an explicit lifecycle

The client-side `CourtState` (`idle`/`pending`/`active`) doesn't map
cleanly onto §5's `Pairing` row as originally specified — `confirmedAt`
alone can't distinguish "confirmed and currently being played" from
"confirmed and finished," which the schema needs once `Pairing` is the
real source of truth instead of a `courts[]` array with an
implicit pointer to "the current one":

```
Pairing — id, sessionId, courtNumber, matchNumber, teamA[2], teamB[2],
          scoreA, scoreB (nullable), confirmedAt (nullable — null =
          pending/not yet confirmed, matches §7's "reshuffle is free
          before confirm"), endedAt (nullable — new field; null =
          still active/being played, set = finished, court is free)
```

Court status is then always derivable, never stored separately:
`idle` = no `Pairing` row for that court with `confirmedAt` set and
`endedAt` null; `pending` = a row with `confirmedAt` null;
`active` = a row with `confirmedAt` set, `endedAt` null. This is a
small addition (`endedAt`), not a rework — **RECOMMENDATION**, low
risk to change later if it turns out wrong.

### 8.3 API surface — **decided, built**

Now that engines run server-side (§8.1), the API has two kinds of
endpoints — plain persistence, and ones that actually run
`parser.ts`/`fuzzy-match.ts`/`pairing.ts` server-side and return a
computed result:

```
GET/PUT   /groups/:code                     — read/rename [data]
GET       /groups/:code/players             — list [data]
POST      /groups/:code/parse               — runs parseLineRosterMessage
                                               + matchName against this
                                               group's known players;
                                               returns header fields,
                                               warnings, unrecognizedLines,
                                               and roster/waitlist name
                                               reviews [engine]
POST      /sessions                         — resolves host's review
                                               decisions (confirmExisting-
                                               PlayerAlias/createNewPlayer),
                                               creates the Session [engine
                                               + data]
GET       /sessions/:code                   — read [data]
POST      /sessions/:code/courts/:n/propose — runs generateRound against
                                               the server's own current
                                               Pairing state (courtCount=1,
                                               scoped to whoever isn't on
                                               another open court);
                                               creates a pending Pairing
                                               row or reports "not enough
                                               players" [engine] — this is
                                               the endpoint the whole
                                               server-side move was for:
                                               no stale-snapshot race
                                               between devices
PATCH     /sessions/:code/pairings/:id      — confirm (set confirmedAt)
                                               or finish (set endedAt +
                                               scores) [data]
```

`toggleDecision` (flipping a fuzzy-match suggestion between accept/
reject) stays purely client-side — it's local UI state over an
already-fetched `/parse` result, no engine call needed until the host
submits via `POST /sessions`.

No websockets, no polling — `[↻ refresh]` re-fetches from the API
instead of `localStorage`, same manual-refresh UX already decided in
§7.3, now backed by a real network call instead of a local read.

**Built** (`server/src/groups/`, `server/src/sessions/`; see
`docs/superpowers/specs/2026-09-04-api-layer-design.md` and
`docs/superpowers/plans/2026-09-04-api-layer.md`). The above sketch
left several shapes open, resolved during design: `/parse` upserts the
`Group` row implicitly (no separate create endpoint) but never renames
an existing group; `propose`'s "not enough players" outcome is a 200
with `{ok: false, reason: 'not-enough-players'}`, not an HTTP error;
confirm/finish are two explicit `POST` actions, not one overloaded
`PATCH`; `lastSessionCode` is computed on `GET /groups/:code` (queried,
not stored, matching §8.2's already-derived-field pattern). `propose`
also upserts the single pending `Pairing` row per court in place on a
reshuffle rather than inserting a new row every time — `matchNumber`
only increments once a match is actually confirmed.

Two real Prisma 7 + `better-sqlite3` findings surfaced while building
and testing this layer, beyond what the schema plan already found:
`$queryRaw` returns SQLite integers as `BigInt`, not `number`; and
running the test suite's `@nestjs/testing` modules concurrently (each
opening its own connection to the same `dev.db`) intermittently threw
`SQLITE_BUSY` under the default rollback-journal mode — fixed by
setting `PRAGMA journal_mode = WAL` and `PRAGMA busy_timeout = 5000`
in `PrismaService.onModuleInit`. Next up: migrating the Angular
services off `localStorage` to call this API (§8.6).

### 8.4 DB engine + ORM — **decided, built**

- **SQLite**, not Postgres. Casual-friend-group scale, single-host
  deployment implied throughout this doc (no mention of scaling
  needs anywhere) — zero ops, zero separate service to run, matches
  the project's consistent no-extra-infra ethos (`parser.ts`
  onward). Trivial to swap for Postgres later if a real multi-host
  deployment ever becomes necessary — nothing here locks that in.
- **Prisma** over TypeORM. Lighter mental model, generates types
  directly from the schema (one source of truth), and the project has
  consistently favored explicit/typed over decorator-heavy magic
  (`fuzzy-match.ts`/`pairing.ts`'s plain-function style over classes
  where possible).
- Lives at `server/` (sibling to `web/`) — `server/prisma/schema.prisma`
  defines the tables from §8.2/§5.

**Built and round-trip proven** (see
`docs/superpowers/specs/2026-09-04-prisma-schema-design.md` and
`docs/superpowers/plans/2026-09-04-prisma-schema.md`). Six models:
`Group`, `Player`, `Session`, `SessionRoster` (join table, new — makes
the roster symmetric with `Waitlist`), `Waitlist`, `Pairing`. Three
representation decisions beyond §8.2's sketch: arrays
(`Player.aliases`, `Pairing.teamA`/`teamB`) are JSON-encoded `String`
columns (SQLite/Prisma has no array column type); `Group`/`Session`
use their existing `code` as primary key, no separate internal id;
`Group.lastSessionCode` is dropped from the schema entirely — derived
via a query (`Session` where `groupId=X` order `createdAt desc`), not
stored, to avoid a second source of truth.

Prisma 7 (pinned to `7.10.0` — its `latest` npm tag is currently an
`8.0.0-rc` pre-release with an incompatible CLI) removed
`datasource.url` from `schema.prisma` and requires `PrismaClient` to
take an explicit driver adapter at runtime even for SQLite
(`@prisma/adapter-better-sqlite3`) — connection config for CLI
commands now lives in `server/prisma7.config.ts`. Next up: the API
layer (§8.3) that builds on this client.

### 8.5 Group-creation flow — **decided, built**

Was a gap: `GroupEntry` only ever read whatever `groupCode` was
already in the URL, with no `''` (root) route and nothing to generate
a new one. Decided against auto-create-on-any-URL (bad UX — a typo'd
URL would silently create a new empty group). Built explicit creation
instead: `Landing` (`/`, `web/src/app/pages/landing/`) — one "Start a
new group" button, generates a fresh code
(`crypto.randomUUID().slice(0, 8)`, matching `Session.code`'s existing
pattern) and navigates to `/g/:code`. No manual "enter an existing
code" field — a returning host uses their bookmarked `/g/:code` link,
same as before.

### 8.6 Migration path — **decided, built**

Two different amounts of rework, now that engines moved server-side
(§8.1) — both done. `RosterService` is a thin `HttpClient` wrapper
(`getGroup`/`renameGroup`/`getPlayers`/`createSession`/`parseRoster`);
`LiveSessionService` wraps one `httpResource<Session>` plus the three
mutating actions (`proposeMatch`/`confirmMatch`/`finishMatch`, POST
then `.reload()`). Every `localStorage` call is gone from `web/` —
confirmed by checking that no file still imports `matchName`/
`matchRoster`/`confirmExistingPlayerAlias`/`createNewPlayer`/
`parseLineRosterMessage`/`generateRound` as a runtime value; only
type-only imports of `fuzzy-match.ts`'s types remain, for DTO shapes.
Dead code removed as a direct consequence: `history-derivation.ts`
(server now derives history) and `roster-review.ts`'s `resolveReviews`
(server now resolves reviews) — both had server-side equivalents
already built in the API layer plan.

Real findings from building this (see
`docs/superpowers/plans/2026-09-04-client-migration.md`): Angular's
`httpResource()` throws from `.value()` when in an error state rather
than returning `undefined`, even from a template binding — every read
must check `.error()` first; `.reload()` and *dependent* resources
(one resource's URL computed from another's resolved value) both need
explicit `TestBed.tick()` + a microtask wait in tests, since
`fixture.whenStable()` deadlocks the moment settling one resource
fires another's request without anything to flush it. `GET
/sessions/:code`'s court derivation needed a `pairingId` field added
(confirm/finish need the `Pairing` row's id, which a court number
alone doesn't give them) — a small, required addition to the
already-shipped API layer, not scope creep.

## 9. Progress checklist

### Design / decisions
- [x] v1 plan written (scope, tech stack, schema, build order)
- [x] Plan reviewed for gaps (8 findings folded in)
- [x] Fuzzy-match algorithm decided
- [x] LINE bot (trigger-word or passive) reconsidered — stays out of v1, see §2
- [x] Cost-splitting/PromptPay dropped from v1 — delegated to KhunThong, see §2
- [x] Opponent-balancing scope decision for pairing engine — in, as secondary soft signal, see §6.3
- [x] Mid-session edit flow designed (reshuffle / late-add / no-show removal) — see §3
- [x] UI/UX flow designed — per-court independent rotation, not synchronized rounds; dashboard + display view — see §7
- [x] Backend design drafted and engine-location decision made — server-side, see §8.1
- [x] Group-creation flow decided — explicit `/` landing page, see §8.5

### Build order
- [x] 1. LINE roster-message parser (`parser.ts`, verified vs 3 real messages)
- [x] 2. Fuzzy-match layer (parsed names → `Player` + `aliases[]`, `fuzzy-match.ts`)
- [x] 3. Pairing/rotation engine (repeat-partner avoidance + sit-out balancing, `pairing.ts`)
- [x] 4. Angular screens: roster panel → per-court panels (idle/active/finish) → waiting queue → display view (see §7)
- [x] 5. Migrated Angular services off `localStorage` to the real API — see §8.6
- [x] 6. End session action + reshuffle fairness fix (root-caused from manual testing: with exactly 4 players available, only 3 possible team-splits exist and score equally with no history yet, so reshuffle could repeat the same split — `pairing.ts`'s `generateRound` now penalizes reproducing the immediately-previous split; `Session.endedAt` added, blocked while any court is unfinished)

### Infra
- [x] Git repo initialized, `.gitignore` added
- [x] NestJS backend scaffolded (`server/`, cross-boundary import of `parser.ts`/`fuzzy-match.ts`/`pairing.ts` proven at build and runtime — see §8.1)
- [x] Angular frontend scaffolded (`web/`, routing skeleton only — see §7.4)
- [x] DB schema created (Group, Player, Session, Pairing, Waitlist) — `server/prisma/schema.prisma`, round-trip proven — see §8.4
- [x] API layer built (groups/parse/sessions/propose/pairings) — see §8.3
