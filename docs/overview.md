# JubBad — overview

A badminton court-pairing app for casual Thai groups. The host pastes the
week's roster out of LINE, the app fuzzy-matches the names against players it
already knows, and then runs the night: each court proposes its own fair
doubles pairing, the host confirms it, plays, and records who won.

This file is the durable part of the project — what it is, what was decided,
and why. It is not a status log: `git log`, `docs/archive/plans/` and
`docs/archive/specs/` record how it got built, and
`docs/2026-09-21-feature-review-and-roadmap.md` records what is still open.

## The gap this fills

*Revised 2026-09-21. The original premise here turned out to be wrong, and
what it got wrong is the useful part.*

Existing apps (Racket Social, Kiki-match, Badminton Match Manager, Qcourt,
GroupSlam, ShuttleFlow, Shuttl) already solve fair doubles pairing, rotation,
sit-out balancing and cost splitting — well. Rebuilding those is not the point.

This section used to claim that nothing Thai-language existed for running a
session for a group that already exists, and that localization was therefore
the differentiator. That is no longer true, and may not have been true when it
was written. A competitor review on 2026-09-21 found at least three Thai tools
built for exactly this job:

- **T-BAD** (tbadapp.com): free with no paid tier. Imports the roster from a
  pasted LINE message, tags skill levels (ระดับมือ), keeps singles and doubles
  Elo separate, and has fixed pairs, a TV display, voice announcements and
  offline use.
- **PlayMatch**: says it serves 550+ ก๊วน, with paid tiers at 149 and
  219 THB/month. Splits the court fee and shuttle cost, generates a PromptPay
  QR, tracks payments, and shows the live queue on players' phones.
- **BC COURT**: queue, skill-level checks, duplicate-pair checks, shuttle
  stock and a wallet. Tiers at 99, 199 and 599 THB.

Being in Thai and friendly to LINE is now the minimum any competitor offers,
not a moat. What still separates this app:

- **Pairing quality.** Partner and opponent history is counted across the
  group's whole life. The search is exact for up to eight players on court,
  and above that a local search is checked against the exact result on every
  test run (see "Pairing"). The competitors advertise a duplicate-pair check.
- **Thai nickname matching.** It suggests a match but never merges on its
  own.
- **Per-court singles/doubles**, per-court undo, and a rest toggle that credits
  missed games.
- **Correctness.** The server serializes court fills, so no two devices can
  put one player on two courts.

The comparison, the features it found missing and their priority are in
`docs/2026-09-21-feature-review-and-roadmap.md`.

## Product decisions (and why)

| Decision | Why |
|---|---|
| No bot in the LINE group chat, ever | A posting bot notifies people who aren't even playing that day — spammy |
| No passive "listener" bot | Even listen-only, it technically sees the *entire* conversation; the host's consent doesn't cover the other ~15-20 people in the chat. Bigger trust risk than the convenience is worth for a casual friend group |
| Import is paste-based | The app's data footprint = exactly what the host explicitly hands over. No infra (no webhook server, no persistent message store) |
| No LIFF / LINE Login / LINE platform integration | Paste-based import plus manual share means zero technical touchpoint with LINE's platform is needed. Pure UX polish, addable later |
| Per-user accounts for hosts, not player accounts | Administrative screens and writes require signing in as a real user (email + password, session cookie signed server-side). Each user owns the groups they create; an admin role sees and manages every user and group. There are still no individual *player* accounts or profiles — this is identity for whoever runs a session, not for who plays in one. Superseded the earlier one-shared-token design (backlog B12, done 2026-09-12); see the per-user-login design doc for the schema and guard design. |
| Trigger-word LINE bot (reconsidered, still rejected) | The idea: a bot watches the group for a keyword ("Play") then auto-extracts the roster, skipping the manual paste. Rejected on inspection — the LINE Messaging API has no message-history endpoint (confirmed in LINE's docs), so a bot can only look *forward* from when it joins. In real use the roster is posted days before "Play" is typed, so the bot would have to continuously store *all* group messages in a rolling buffer to look backward — that is full passive listening plus retention, the exact risk rejected above, not a lighter trigger-gated version. It also reopens "no infra" and "no posting bot" at once. Revisit only if paste friction proves to be a real dealbreaker; the lower-risk fix for the typing/copying pain is a tap-to-register roster link |
| No cost-splitting / PromptPay QR in-app | KhunThong (ขุนทอง), KBank/KBTG's LINE bot, already does this well — bill split (equal or not), PromptPay QR, and payment verification by e-slip scan, which the planned v1 didn't even have. The host invites KhunThong separately; no integration needed. **Partly reopened 2026-09-21, and narrowed 2026-09-22, not reversed.** The session now records its shuttle count and price, and every Thai competitor leads with a per-person bill. The owner decided the app will *calculate* each player's share and copy it out as text for LINE, under one of three charging models (fair pay, per game, buffet), with an optional host-fee line. The QR, payment tracking and slip checking stay with KhunThong. Built 2026-09-24 (roadmap C3); see "Bill (C3)" below and `docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md`. |
| Score logging: final score only, no live scoreboard | Point-by-point, serve indicators and timers are scope creep nobody asked for. A final score per court is low-friction and still bootstraps the match history that future skill/Elo balancing would need |
| Per-group host role (resolved 2026-09-08 decision, built 2026-09-12) | Was: one shared admin token distinguished no one from anyone else — equal power for every holder, including deleting a group, with all-or-nothing revocation. Closed by backlog B12: `Group.ownerId` names one owner per group, `OwnershipGuard` refuses any other host with a 404 (never a 403 — that would confirm the code exists), and disabling one user bumps only their `tokenVersion`, signing out just that person's devices. An admin role bypasses ownership and manages every user and group from `/admin`. Built on a branch and merged into `main` on 2026-09-12 (`559ea5a`). |
| No data-retention/deletion policy (**accepted risk**) | Names persist indefinitely under a group's link code. A host can now export the group as JSON or delete it outright, which covers the practical need without a policy |
| Export and delete require the group's owner (or an admin) to be signed in | They are administrative operations; the client also requires typing the group name to prevent an accidental delete. Revocation is now per-user (disabling one account bumps only that account's `tokenVersion`) rather than the old shared-token design's all-or-nothing. |
| No promoting a waitlisted (สำรอง) player mid-session | The สำรอง list is resolved in LINE *before* the session — a waitlisted player was told not to come, so there is nobody at the venue to promote. The feature would serve a situation that cannot occur. Waitlisted names are still imported and shown, so the host can see who was turned away |
| Court format (doubles/singles) is per court, not per session | Courts are booked and run independently already — the app models a court as its own idle/pending/active lifecycle, not as part of a shared session-wide round. A per-session switch would force every court to the same format even though a host's actual need (a short roster, two people wanting a quick game, a court freeing up with only two waiting) is local to one court |

## Explicitly out of scope

- Multi-sport support — badminton-only, Thai-first. This used to be called
  the moat. Since the Thai competitors above exist, it no longer is; it stays
  out of scope because focus is still worth more than breadth.
- Any LINE bot, posting or passively listening (reconsidered once; still out).
- LIFF / LINE Login as an identity provider. Note that plain user accounts left
  this list on 2026-09-08 and are now built (backlog B12): per-user login,
  each host owning the groups they create. What stays out of scope is
  *player* accounts — players never log in. The accounts that exist are for
  whoever administers a group.
- Live point-by-point scoreboard.
- PromptPay QR, collecting money and tracking payments — delegated to
  KhunThong. Calculating each player's share is in scope as of 2026-09-22
  (roadmap C3); the QR and collecting the money stay out.
- Individual player accounts. Still out — see the decision table above. Host
  accounts and per-group ownership are no longer on this list; see B12.

## Stack and layout

```
engines/     Pure, dependency-free TypeScript. No framework, no npm deps.
             parser.ts       LINE roster message -> structured data
             fuzzy-match.ts  parsed names -> known Player records
             pairing.ts      roster + history -> court assignments
             Tested with node:test, run via `npm run test:engines`.

server/      NestJS + Prisma + SQLite. Imports engines/ by relative path.
             The engines run server-side, so the server can serialize
             decisions — see "Why the engines run on the server" below.
             Importing engines/ needs tsconfig.build.json's rootDir widened
             to the repo root, which pushes the build output down to
             dist/server/src/ rather than the usual dist/src/. That is why
             nest-cli.json sets an explicit entryFile and why start:prod
             names that longer path.

web/         Angular, standalone components, signals. Talks to the API only;
             holds no business logic and no localStorage state.
```

`npm test` at the repo root runs all three suites.

Data model lives in `server/prisma/schema.prisma` — that file is the source of
truth, so it is not duplicated here. Two shapes worth knowing: arrays
(`Player.aliases`, `Pairing.teamA`/`teamB`) are JSON-encoded string columns
because SQLite has no array type, and court status is always *derived* from
`Pairing` rows rather than stored — `idle` = no open row for that court,
`pending` = a row with `confirmedAt` null, `active` = `confirmedAt` set and
`endedAt` null.

SQLite rather than Postgres: casual-friend-group scale, single-host deployment,
zero ops. Nothing locks that in — swapping to Postgres later is a config
change. Deployment is Docker Compose behind a Cloudflare Tunnel; see
`dockerDeploy.md`.

"Zero ops" stops at backups, because the database is the only thing on the box
that git cannot rebuild. `npm run db:backup` takes a consistent snapshot
through SQLite's online backup API while the API keeps serving — a file copy
would not do, since WAL mode leaves committed writes in a sidecar and copying
three files while they are being written is a torn read. Restores are scripted
too, mostly so that the `-wal` removal cannot be forgotten: leave the journal
behind and SQLite replays it over the restored file. The group JSON export is
deliberately not a restore path — it omits fairness offsets and activation
times, so it can be read but not reloaded.

## How the engines think

### Parser

Heuristic and **lenient, not strict** — real LINE messages vary in spacing,
punctuation and trailing whitespace on empty slots. Two rules matter:

- **Never silently drop or guess.** Anything ambiguous (a 2-digit year,
  Buddhist vs. Gregorian) goes to a `warnings` array; anything unclassifiable
  (หมายเหตุ notes) goes to `unrecognizedLines`. Nothing is discarded.
- **Empty numbered slots are preserved** (`3.` → `{position: 3, name: null}`)
  so slot counts stay accurate before names are filled in.

### Fuzzy matching

Normalized Levenshtein similarity, and **it never auto-links on a fuzzy
match** — only an exact match auto-links. A fuzzy hit is surfaced as a
suggestion ("ใช่ [X] ไหม?") for the host to confirm or reject.

The reasoning is specific to this domain: Thai nicknames here run 2-4
characters (ปอม, ตี๋, เบส). Bigram/Dice similarity is weak at that length —
one edit destroys most bigrams. Because a fuzzy hit only ever *asks* — never
writes anything until the host taps to confirm — the threshold (0.5) is tuned
to catch a real shortening (a previous session's เกียร์ pasted as เกีย the
next time, similarity 0.667) rather than to avoid ever prompting. A missed
prompt silently creates a duplicate player with no rating history; an
unwanted prompt costs one tap to dismiss. This extends the parser's "never
silently guess" rule rather than inventing new tolerance.

**One player can only hold one slot in a list.** A second name resolving to an
already-claimed player is reported as `duplicate` and defaults to being its own
new player, for the host to override. Exact hits claim first across the whole
list, before any fuzzy hit is considered — an exact hit is evidence about who
the player is, a fuzzy hit is only a suggestion, so resolving in list order
would let a suggestion one line higher take the player and demote the real name.

The reason is the same wrong-merge risk arriving by the other door. Hosts
number two people with the same nickname as "ตั้ม (1)" and "ตั้ม (2)";
`normalizeName` strips the note, so both hit the one stored ตั้ม *exactly*,
where the fuzzy threshold never gets a say. Left alone that silently merges two
people into one rating and one partner history, and it also fails hard —
`SessionRoster` and `Waitlist` are unique per player, so the repeated id aborts
the write and the host loses the entire import. The two mistakes are not
symmetric: a spurious extra player is visible and editable afterwards, while a
merge cannot be pulled apart, which is why "same person" is the deliberate tap
and not the default.

### Pairing

Courts rotate **independently, not as synchronized rounds** — whoever finishes
first gets the next match right away. There is no shared "round" object.

How many courts there are is a session-level number, and it is editable during
the evening rather than fixed at import. Bookings routinely change part-way
through — one court from 19:00, three from 20:00 is normal — and the imported
message can only give the session one count. The parser warns when the message
books different counts in different slots, so nobody is left guessing why the
extra courts never appeared, and the host adds them when the later slot starts.
Growing is unconditional; shrinking is refused while an unfinished match sits on
a court above the new count, because those players are physically on that court
and a mis-typed number must not delete a match in progress. There is no
scheduled-availability feature: it would need the session to watch the wall
clock, and a two-tap change covers the actual booking pattern.

Proposing for one court still plans across every idle court and commits only
the one asked for. Solving a court in isolation takes the four least-played and
leaves whoever remains to be shovelled onto the next court together — that
court then gets no choice of players at all, only of how to split them, which
recreates the same opponents whenever two courts finish together. Planning
across the idle courts keeps the per-court flow while giving the engine the
freedom it needs.

**A roster of exactly four per court locks players into fixed fours.** With 12
players on 3 courts each player partners with 3 of the other 11 all night; one
spare player takes that to 7-10. It is not a scoring fault and no weighting
fixes it: in the steady state exactly one court is free at a time, so the only
available players are the four who just walked off, and four players have three
possible splits. The engine rotates all three — the pods themselves never mix.
Reshuffling cannot help for the same reason; dragging a player to another court
is what breaks a pod, as is playing with a spare. See B13 in
`docs/archive/plans/2026-09-05-review-and-v2-backlog.md`, carried forward in
the roadmap.

Arrangements are scored, lowest wins:

```
score = 10 × (times these partners have played together)
      +  1 × (times these opponents have faced each other)
```

**The terms count repeats; they are not yes/no.** This looks like a detail and
is not. Every pair in a 12-player group has partnered at least once by the
second session, so a binary "have they met?" scores every possible arrangement
identically from then on and silently stops steering anything. Measured over
ten sessions that left some pairs together three times as often as others —
which is exactly what players report as "I always play with the same person".
Counting keeps the spread to about one game.

**Counts are measured against the group's floor, not from zero.** A group where
everyone has partnered everyone forty times is perfectly varied and scores the
same as one on its first night. Without that normalisation the scores grow
without bound, and every other number here — the balance weight, and the
reshuffle guard when it was still a penalty — quietly stops meaning what it was
set to mean.

**Repeat-partner avoidance is the primary goal; opponent balancing is a
secondary soft signal.** In variety mode the two are compared
lexicographically: fewer partner repeats always wins, and the opponent count
only separates arrangements already tied on partners. A 10:1 weighting was
used for this originally and could not actually guarantee it — ten
opponent-repeats outweigh one partner-repeat, and history grows without bound,
so the trade the ratio was meant to forbid became reachable. The weighted
score is still what balanced mode optimises, and it remains useful for
diagnostics. A hard opponent constraint on top of the partner constraint would
risk making sessions with a lot of history unsolvable, since it over-constrains
an already-small namespace.

Two scopes, deliberately different:

- **Partner and opponent history is all-time across sessions.** The whole
  point is spreading variety over the group's life, not just one evening.
- **Games played is this session only.** Sit-out rotation should be fair within
  tonight, not carried over from weeks ago.

**Bad input fails loudly.** The engine checks its arguments before doing any
work and throws rather than coping: a duplicated or empty player id, a
fractional or negative court count, a negative or non-finite count in any
history map. Coping was the old behaviour and it was worse than useless — a
corrupt count made every candidate score `NaN`, no candidate was ever chosen,
and the empty result surfaced as "not enough players". That sends the host
looking around the hall for people who are not missing while the actual fault
sits in the database, unnoticed. The API reports it as `INVALID_SESSION_STATE`
instead. An empty roster is not an error, only an empty round.

**Three pairing modes.** *Variety* is the behaviour described above. *Balanced*
adds a rating-gap term so the two sides come out close in strength. Balance
leads there — one repeat partnership is worth about five rating points — which
is the reason for choosing the mode at all; variety still separates
arrangements that are level on skill. *Custom* hands the whole decision to the
host: proposing a court creates an empty pairing (every seat unfilled) instead
of running the engine, and the host fills seats one at a time by tapping a
player then a seat. Auto-pair fills whatever seats are still empty on that one
court from the normal rotation pool — games played, then longest wait —
without moving anyone already seated or touching any other court. Its
tiebreak among rotation-equal candidates reuses variety's own lexicographic
partner/opponent objective, never ratings: the host is placing people by
hand, and a hidden balance term would quietly pull against the seats they
just chose. The mode is per session and defaults to variety.

Reshuffling excludes the split it was asked to avoid outright, rather than
taxing it. A tax has to be larger than any real score difference, and no fixed
number stays larger as a group accumulates history. The exclusion applies to
one split of court 1, not to a whole candidate arrangement, so a legal
alternative always survives — the engine can no longer be forced to hand back
the very split it was asked to avoid.

Sit-out selection is deterministic and outside the weighted score: whoever has
played the most so far today sits, and **among players level on games the
shortest wait sits** — so the longest waiter goes on first. Only a full tie is
broken randomly, which is what the start of a session is, when nobody has
played and everyone's wait began together. Predictable to the host ("they've
played the most, so they sit"), and it matches the waiting list on screen: that
list is sorted the same way, by games then wait, because a queue the engine
ignores is worse than no queue. Each court needs exactly its own configured
size — 4 for doubles, 2 for singles — so a roster that doesn't divide evenly
across the offered courts leaves a remainder sitting out even when the court
count itself isn't the limit.

**The ±1 level band (C1, the `level` pairing mode) is the one exception to
that predictability.** It is a fourth mode (`variety` / `balanced` / `level`
/ `custom`), not a toggle layered on top of the others — mutually exclusive
with `balanced` and `custom`, owner decision 2026-09-23. A same-level group
gets little from balance-by-rating on top, and a `custom`-mode host is
already placing people by hand with the level badge in view, so band-aware
auto-pair suggestions were dropped from `completeCourt` along with that
choice; `level` mode otherwise spreads partners and opponents exactly like
`variety`. With it selected, who plays is biased toward clustering with
players close to their own level, court by court from an anchor (the front
of the queue), so the split search downstream actually has same-level
groups to work with — `bandOrderedByCourt` in `engines/pairing.ts`. This can
pull a player ahead of, or behind, where plain games-then-wait order would
place them; the only guarantee kept is that the single most-deserving
remaining player is always an anchor, so a rare level waits at most until it
reaches the front of the queue. The waiting list on screen still shows plain
rotation order — the mode's own hint under the segmented control says the
queue may not run in that exact order. `bandBreaks` (a court whose players
span more than one level) is scored right after `groupRepeat`, before
partner/opponent, in both `compareArrangements` and `compareComponents` —
dominant, but never a hard exclusion: a court is never left empty for lack
of a same-level match, and it never makes a round unsolvable.

**Court format is per court, not per session, and only changeable while a
court is idle.** A host can run doubles on courts 1-2 and singles on court 3
in the same session — set from the toggle in that court's panel, refused with
`COURT_ACTIVE` while a match is pending or active there. Capacity is a sum
over whatever sizes the courts on offer are, consumed in order with no
skipping — `propose` offers the requested court first so it is never starved
by another idle court ahead of it. `fillIdleCourts` instead chooses which
idle courts to offer at all: sorting them smallest-first and taking a prefix
optimizes for *court count*, not *players seated*, and the two diverge once
sizes differ — an idle singles court and an idle doubles court with exactly 4
players free would offer the singles court first, seat 2, and leave the
doubles court empty with the other 2 still benched, when filling the doubles
court instead seats all 4 for the same one court used. Since a court is only
ever 2 or 4, the exact best combination is cheap to find directly, so
`fillIdleCourts` does that rather than sorting and hoping. Enabling singles on
a court that would otherwise be doubles trades throughput for variety — it
seats 2 players instead of 4, and everyone else's rotation absorbs that.

A singles match counts as 1 game played for sit-out rotation, exactly like
doubles, and its two players are recorded as having faced each other — but,
having no partner, it adds nothing to partner history. That also means a
singles reshuffle can only change *who* plays, never *how* the two split:
a 2-player group has exactly one possible arrangement, so `avoidSplit` on a
singles court is routed through the same soft group-repeat signal that steers
courts away from an immediate rematch, rather than the doubles path's hard
exclusion, which would otherwise leave no legal split at all.

A wait starts at the latest of the session start, the end of that player's last
match, and the moment they joined or returned (`engines/waiting.ts`, shared by
the engine, the API and both screens). Taking the latest is what stops someone
who arrived an hour late from being owed an hour they were not here for.

**The search is exact when it can afford to be, and local otherwise.** A
court's score reads only within-court pairs, so a court's contribution is
independent of the others — which means that once you know who shares a court,
the best way to split those players into teams can be chosen court by court
and is genuinely optimal, not greedy. All that is left to search is *who
shares a court*, and — for a doubles court — which of the three ways to split
its four into two pairs.

With eight or fewer players on court that space is enumerated outright and the
engine returns a provably optimal round: 315 arrangements for two doubles
courts, fewer for any mix including a singles court. Larger rosters use random
restarts feeding a steepest-descent local search: repeatedly exchange one
player across two courts, keep the best improving exchange, stop when none
improves. A swap only touches two courts and preserves each court's size
regardless of whether the two match, so it works unchanged across a mixed
doubles/singles round; each candidate is scored by re-splitting those two
courts and reusing the rest.

This replaced a fixed 200-candidate random sample, which was measurably weak:
against exhaustive enumeration it never once found the best twelve-player
round in 100 seeded attempts and averaged 41% above optimum. The current
search reaches the optimum in 98 of those 100 runs.
`engines/pairing-quality.test.ts` re-checks that against exhaustive
enumeration on every run, so the engine cannot quietly regress while its
behavioural tests keep passing.

### Ratings

Win/loss Elo (`engines/elo.ts`), replayed over the group's whole history in the
order matches were confirmed — Elo is path dependent, so that ordering is part
of the answer rather than a detail. Ratings are always recomputed, never
stored, so there is no second source of truth to drift.

**Scores are deliberately ignored.** They are optional, so a score-based rating
would be sparse and biased toward whichever hosts bother typing numbers in.
`winner` is a single tap and is recorded on essentially every finished match,
which makes it the honest signal. K is deliberately low (16): a casual group
plays a handful of matches a week, doubles outcomes are noisy, and a rating
that swung hard on one unlucky game would make balanced mode feel arbitrary.

**Singles and doubles are two independent rating tracks**, replayed from the
same rows split by team size (`computeRatingTracks`). A player's singles
rating is never moved by a doubles result or vice versa — they are different
skills, and mixing them would make a rating meaningless for either. A player
new to a format starts at 1200 on that track rather than being seeded from
their rating in the other, since seeding would be exactly the cross-pollution
the split exists to prevent. Balanced mode still picks the track matching
each court's own format, so one round can mix formats correctly.

**A player's skill level (ระดับมือ, C1) seeds their starting rating instead**,
900 + 100 per level from BG (900) to B (1600) — `engines/levels.ts`
`seedFor`. This is not the cross-track pollution the paragraph above rules
out: a level is a human judgement about the person, not a rating carried
over from the other format, so the same seed applies to both tracks. It
fixes the practical consequence noted above — a group's first singles
matches no longer have to be 1200-vs-1200 if the players are tagged. The
seed only ever moves where a player's *own* replay starts from
(`computeRatings`' anchor/seed parameter): a player with no matches yet in
a format still has no entry in the returned map, so a stats page's
null-vs-shown-rating distinction (`singlesRating`) is unaffected. Pairing,
which needs a number for every player on court tonight including one who
has never played, merges the seed in as a default only at the point the
ratings are handed to the engine (`SessionsService.loadRatings`) — never
inside `computeRatingTracks` itself.

A level is host-only: it is never present in a `@Public` response (the
display, the summary, the player card). It only ever appears in
owner-guarded reads (`GroupsService.listPlayersManage`,
`SessionsService.getLevels`, and the dashboard's toggle player panel,
`SessionsService.getPlayerPanel` / `GET /sessions/:code/players`, C1a).

**A level is settable mid-session, not only before the first match (C1a,
owner review of C1, 2026-09-23)** — a host usually cannot judge a new
player's level until they have watched them play, so the roster-review
picker is optional and the dashboard's player panel lets the host set or
edit a level any time. **Setting a level — the first time or an edit —
resets the player's rating to the level's seed at that exact moment; only
matches confirmed afterwards move it.** This is `engines/elo.ts`'s
`RatingAnchor`: `{ rating, setAt }`, replacing the plain numeric seed
above wherever a level can already have been set partway through a
group's history (`player-levels.ts`'s `loadRatingAnchors`, keyed off the
new `Player.levelSetAt` column). `setAt: null` (a legacy row, or a level
set before the player's first match) behaves exactly like the old numeric
seed. The alternative — adding the seed on top of whatever the player
earned while unlevelled — was rejected: those earlier results were played
against a false 1200 baseline (the true unlevelled rating for anyone
without a seed), so they carry no signal about where the level should
land, and letting them accumulate under a level chosen precisely because
the host watched those same wins would double-count them. An edit
(P → C, say) is the same operation as a first assignment for exactly that
reason: whatever the player earned since the last time a level was set is
just as tainted, having been earned under a rating the host has now
decided was wrong. The player's win/loss record (`played`/`won`/`lost`)
is unaffected either way — only the Elo rating resets, never the shown
game count. The player panel shows the rating as a difference from the
seed (`ratingDelta`, e.g. "P +50") rather than the raw number, since a
bare 1350 means nothing to a host without the seed already in their head;
it is exactly 0 the instant a level is set with no games on top of it
yet, and `null` with no level at all (there is no seed to diff against).

### Why the engines run on the server

The engines are isomorphic and were originally called straight from the Angular
app. They were moved server-side for one concrete correctness reason: if two
devices both trigger "start next match" for two different courts at nearly the
same moment, each computes its proposal against its own locally-fetched
snapshot of who is already on a court. If both snapshots are slightly stale,
**the same player can be assigned to two courts at once.** A server computing
the decision can serialize those writes; a client fundamentally cannot.

(That serialization is `server/src/sessions/session-lock.ts`. It is
in-process, which suits the single-container deployment; more than one API
process would need a database-level lock.)

## How a session runs

Three routes:

- `/g/:groupCode` — group entry. The host bookmarks this once and opens it
  weekly, to either resume an active session or paste a new roster.
- `/s/:sessionCode` — the session dashboard, the host's phone.
- `/s/:sessionCode/display` — read-only, big text, for a venue screen.

The dashboard is one screen of stacked sections, not a wizard, because courts
rotate in a loop rather than moving through a flow once: a roster panel, one
panel per court, and a waiting queue.

Each court runs its own lifecycle — **idle** → *Start next match* proposes a
pairing → **pending**, where reshuffling is free and unlimited and a single
player can be tapped to swap in a substitute → *Confirm* → **active**, then
*Finish* records the winner (or "No result") and frees the court.

**A pending match nobody confirms starts itself after 60 seconds.** Every
edit — reshuffle, swap, a seat filled or cleared, a player rested or brought
back — resets that window, so a host still setting up the court never gets
cut off, and it only fires once every seat is filled and nobody on it is
resting. The confirm it produces is backdated to 30 seconds after the match
last changed, an estimate of when players actually walked on, rather than to
the moment the window closes — so the live timer doesn't start a full minute
behind. Undoing an auto-confirm turns it off for that match; editing the
lineup again turns it back on.

**A court's format — doubles or singles — is a toggle in its own panel,
changeable only while that court is idle.** Restricting it to idle is what
guarantees a live pairing's team size can never disagree with the court's
current setting; the toggle stays visible but disabled once a match is
pending or active, so the host can still see what the court is set to.

**Swapping has two speeds.** Tapping a name means "take this player off, you
choose the replacement", which follows normal rotation and is one tap. Choosing
the replacement yourself is the deliberate version: pick a player up — by the
handle beside their name, or from the waiting list — then drop or tap them onto
whoever they replace. If the player picked up was on another *pending* court,
the two trade places, and both rows are written in one transaction so a
rejected swap cannot leave one player on two courts. A trade is refused once
the far court is confirmed: pulling someone out of a running match would mean
the score being entered no longer belongs to the players it names.

Drag and tap are deliberately both supported rather than drag alone. HTML5
drag-and-drop does not fire on touch at all, and this app is used one-handed at
the court, so drag runs through Angular CDK (which uses pointer events) and the
tap path doubles as the keyboard-accessible route.

**Confirm is the commit point.** History — partner counts, opponent counts,
games played — updates only when a match is confirmed, never when one is
proposed. That single rule is what makes free reshuffling, resting a player and
undo compose correctly without any extra engine work.

Custom mode leans on the same rule for its own extra bit of state: an unfilled
seat is represented as `null` inside `Pairing.teamA`/`teamB`'s existing
JSON-encoded arrays — no new column, no migration. Confirm refuses with
`PAIRING_INCOMPLETE` while any seat is still `null`, which is what turns
"every confirmed pairing has a `null` seat" from a hope into a guarantee
every downstream reader (history, ratings, stats, export) can rely on without
its own check. A half-filled draft can outlive a mode switch back to variety
or balanced — switching mode is a one-column write that never rewrites a
pending pairing, the same principle as resting a player mid-proposal above —
so the seat-editing and auto-pair endpoints are deliberately not gated on the
session still being in custom mode.

Two controls fall out of it. **Rest** excludes a player from future court fills
and back again — one toggle covering a no-show, an early leaver, someone
sitting a few rounds out, and a mis-tap; a player rested mid-match simply plays
that match out. A *pending* proposal they are standing in is a different case:
it is left on screen rather than rewritten underneath a host who may be reading
it aloud, but confirming it is refused, the court panel names them, and either
swapping that name or reshuffling clears it. Both draw only from active
players. Bringing someone back credits them with the games they were
absent for, so they rejoin the rotation rather than jumping it — without that
credit a player enabled part-way through sits on zero games and wins every
draw until they catch up. The credit is for rotation only; the stats table
always shows what someone actually played. **Undo** reverses the most recent step on one court, whatever
it was, so a mis-tapped winner is recoverable even after the next match has been
proposed. It refuses when the players involved have already started elsewhere,
since restoring would double-book them.

The waiting queue shows how long each player has been off court, derived rather
than stored: the wait runs from the latest of their last match ending, the
moment they joined, and the session start. Counting from the session start
alone would tell a player who arrived an hour late that they had been waiting
an hour, contradicting the rotation, which deliberately does not owe them that
time.

How long a game took is derived the same way, from the same two `Pairing`
timestamps: `confirmedAt` (host confirms, players go on court) to `endedAt`
(score submitted, court freed). The live dashboard shows a ticking stopwatch
on the active court; the post-session summary shows each match's duration and
a player's total time on court. Undo reuses this honestly rather than adding
a pause concept — un-finishing a match clears `endedAt` and the timer keeps
counting through the gap, and un-confirming clears `confirmedAt` and restarts
it at zero on the next confirm. There is no cumulative history: elapsed is
always "latest confirm to latest finish."

The display view shows only *active* courts, so a proposed-but-unconfirmed
pairing never reaches the venue screen. It refreshes every 30 seconds and has
a manual refresh control; neither needs extra server infrastructure such as
websockets.

The roster review screen, before a session is created, also has one search
field for adding someone the paste missed. It finds an existing player (so
their history carries over) or creates a new one.

A walk-in — someone not on the pasted list — can also be added to a session
that is already running, from a "+ เพิ่มคน" button on the dashboard. The same
search-or-create choice applies: an existing group player (their history
carries over) or a brand-new one. They are credited `gamesOffset` up to the
highest active games-played count already on the roster, the same rotation-
fairness credit a returning (rested) player gets on the way back in (B14),
so they join the rotation instead of winning every draw until they catch up.
Someone already on tonight's roster, including a resting one, is refused as
a duplicate; the search field points the host at the existing roster chip
instead of creating a second row for the same person.

**Ending a session asks for confirmation.** "จบก๊วน" opens a dialog that also
asks how many shuttles were used and their price. The host
only knows the count once the night is over, so this is asked at the end
rather than tracked per match. Both fields are optional and can be corrected
later from the summary page. The price is stored in satang as an integer, and
null means "not recorded", which is different from 0. The public summary shows
both.

### Bill (C3)

A host-only "คิดเงิน" button on the session summary turns those two fields,
plus the night's confirmed matches, into a per-person amount, copied out as
Thai text for the LINE group — the app *calculates* each share; collecting
the money and checking payment still stay with KhunThong (see the decision
table above). `Session.billConfig` stores only the inputs (model, toggles,
rates, host fee, rounding, and the added/removed/overridden player ids) —
the same recompute-never-store rule ratings and wait times follow — and
`engines/bill.ts`'s `computeBill` derives everything else, in integer
satang, on every read.

Three models, chosen per session: หารตามจริง (fair pay) splits the actual
court fee and shuttle cost, each independently either equally or by games
played; คิดต่อเกม (per game) charges a flat rate per game with an optional
entry fee and cap; บุฟเฟ่ต์ (buffet) is a flat price per person, with
shuttles optionally folded in. **A removed player's share behaves
differently depending on the model:** in fair pay, a cost-based split,
removing someone spreads what they would have owed equally over the
remaining billed players, so the actual cost stays covered; the price-based
models (per game, buffet) never derived their per-person rate from a total
in the first place, so removing or adding someone changes who pays, not how
much each remaining person owes.

**A walk-in's surcharge (C2, C3's D7 amendment) is a group discount, not
host profit.** A roster row marked as a walk-in pays a flat fee on top of
its own bill line; `distributeCapped` hands that fee straight back as an
equal discount to every other billed player, capped so nobody's amount goes
negative, so the total collected is exactly what it would have been with no
walk-in fee at all — the fee only changes who pays how much of it. Whether a
row is a walk-in is billing data (`SessionRoster.walkIn`, set from the bill
page), deliberately not surfaced as a badge on the `@Public` dashboard feed
that also serves the venue display.

The copied LINE text is always Thai, regardless of the host's own UI locale
(owner decision) — money going into a group chat is not the place to
localize on the host's behalf. The margin (amount collected vs. actual
cost) is shown to the host only and never appears in that text. The bill
routes (`GET /sessions/:code/bill`, `POST /sessions/:code/bill-config`, and
the roster walk-in mark) are owner-only, like contact data and export, and —
unlike almost every other session mutation — stay reachable after the
session has ended, since a host normally sits down to bill only once the
night is actually over.

## Current state

Everything described above is built: the three engines, the API, the Angular
client in Thai with English as a second locale, the display view, per-court
undo, resting players, wait timers, one-tap fill, all four pairing modes
(variety, balanced, level, custom), per-court singles/doubles format, session
archive, the public session summary, player pages, the host-only player roster
page (contact details, plus rank by rating or win rate), manual add on the
roster review screen, adding a walk-in to a running session, shuttle count
and price, the per-person bill (C3), export and delete, per-user host login
with an admin console, and a PWA manifest (no service worker, so no offline
use).

What is still open, and in what order, is in
`docs/2026-09-21-feature-review-and-roadmap.md`.

`docs/archive/plans/2026-09-05-review-and-v2-backlog.md` records the review
that drove most of it. Its last open item, per-user login (B12), is built and
merged — see
`docs/archive/plans/2026-09-12-b12-per-user-login.md` for the design. Its original
justification for staying unbuilt (that a host role would reverse a "no auth"
decision, and that export and delete were gated only by knowing the group code)
stopped holding once admin authentication was built — the old `AdminGuard`
closed every route by default and both operations sat behind it. What one
shared token could not express was identity: per-group ownership, unequal
power between holders, and per-user revocation. `AuthGuard` and
`OwnershipGuard` now provide exactly that.

It was built on branch `worktree-per-user-auth` and held unmerged behind the
sequencing the owner set on 2026-09-08. Authentication touches every route,
so changing it while the core was unproven would have given any later fault
two plausible causes. The branch merged into `main` on 2026-09-12 (`559ea5a`).

A separate audit on 2026-09-07 found 35 issues across the engine, the API and
the docs, all since implemented; it is archived at
`docs/archive/plans/2026-09-07-project-audit-and-matchmaking-gaps.md`.
