# JubBad — overview

A badminton court-pairing app for casual Thai groups. The host pastes the
week's roster out of LINE, the app fuzzy-matches the names against players it
already knows, and then runs the night: each court proposes its own fair
doubles pairing, the host confirms it, plays, and records who won.

This file is the durable part of the project — what it is, what was decided,
and why. It is not a status log: `git log`, `docs/active/plans/` and
`docs/active/specs/` record how it got built, and
`docs/2026-09-05-review-and-v2-backlog.md` records what is still open.

## The gap this fills

Existing apps (Racket Social, Kiki-match, Badminton Match Manager, Qcourt,
GroupSlam) already solve fair doubles pairing, rotation, sit-out balancing and
cost splitting — well. Rebuilding those is not the point.

What does not exist is anything **Thai-language and LINE-friendly, built to sit
alongside the tools these groups already use** — LINE for coordination,
KhunThong for PromptPay splitting. The existing pairing apps are English-first
generic multi-sport tools with their own account/PWA/bot ecosystems. The
existing Thai badminton apps (Lenkila and similar) are court-booking and
partner-finding marketplaces, not tools for running a session for a group that
already exists.

**The differentiator is localization and fitting into how these groups already
coordinate — not a smarter pairing algorithm or a bigger feature set.**

## Product decisions (and why)

| Decision | Why |
|---|---|
| No bot in the LINE group chat, ever | A posting bot notifies people who aren't even playing that day — spammy |
| No passive "listener" bot | Even listen-only, it technically sees the *entire* conversation; the host's consent doesn't cover the other ~15-20 people in the chat. Bigger trust risk than the convenience is worth for a casual friend group |
| Import is paste-based | The app's data footprint = exactly what the host explicitly hands over. No infra (no webhook server, no persistent message store) |
| No LIFF / LINE Login / LINE platform integration | Paste-based import plus manual share means zero technical touchpoint with LINE's platform is needed. Pure UX polish, addable later |
| Shared admin authentication, not player accounts | Administrative screens and writes require one venue-admin token stored in an httpOnly cookie. There are still no individual player accounts, profiles, or per-group host roles. |
| Trigger-word LINE bot (reconsidered, still rejected) | The idea: a bot watches the group for a keyword ("Play") then auto-extracts the roster, skipping the manual paste. Rejected on inspection — the LINE Messaging API has no message-history endpoint (confirmed in LINE's docs), so a bot can only look *forward* from when it joins. In real use the roster is posted days before "Play" is typed, so the bot would have to continuously store *all* group messages in a rolling buffer to look backward — that is full passive listening plus retention, the exact risk rejected above, not a lighter trigger-gated version. It also reopens "no infra" and "no posting bot" at once. Revisit only if paste friction proves to be a real dealbreaker; the lower-risk fix for the typing/copying pain is a tap-to-register roster link |
| No cost-splitting / PromptPay QR in-app | KhunThong (ขุนทอง), KBank/KBTG's LINE bot, already does this well — bill split (equal or not), PromptPay QR, and payment verification by e-slip scan, which the planned v1 didn't even have. The host invites KhunThong separately; no integration needed |
| Score logging: final score only, no live scoreboard | Point-by-point, serve indicators and timers are scope creep nobody asked for. A final score per court is low-friction and still bootstraps the match history that future skill/Elo balancing would need |
| No per-group host role | The shared admin token protects every administrative route, but it does not distinguish one group member from another or assign ownership of a particular group. One secret means equal power for everyone holding it — including deleting a group — and revocation is all-or-nothing. Acceptable only while the token holder is the person who runs the sessions. The owner decided on 2026-09-08 to build per-user login (backlog B12), sequenced after the current build has been validated in real sessions — it changes the layer every route passes through, so it should not move while the core is still unproven in the field. |
| No data-retention/deletion policy (**accepted risk**) | Names persist indefinitely under a group's link code. A host can now export the group as JSON or delete it outright, which covers the practical need without a policy |
| Export and delete require the shared admin token | They are administrative operations; the client also requires typing the group name to prevent an accidental delete. The token is shared rather than per-user, so revocation means changing it and signing every admin device out. |
| No promoting a waitlisted (สำรอง) player mid-session | The สำรอง list is resolved in LINE *before* the session — a waitlisted player was told not to come, so there is nobody at the venue to promote. The feature would serve a situation that cannot occur. Waitlisted names are still imported and shown, so the host can see who was turned away |

## Explicitly out of scope

- Multi-sport support — badminton-only, Thai-only. That is the moat.
- Any LINE bot, posting or passively listening (reconsidered once; still out).
- LIFF / LINE Login as an identity provider. Note that plain user accounts left
  this list on 2026-09-08: per-user login is now planned work (backlog B12).
  What stays out of scope is *player* accounts — players never log in. The
  accounts being added are for whoever administers a group.
- Live point-by-point scoreboard.
- Cost splitting / PromptPay QR — delegated to KhunThong.
- Individual player accounts and per-group roles. Still out — see the decision table above.

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
one edit destroys most bigrams — and the namespace is small and dense enough
that near-misses are often genuinely different people (เกีย and เกียร์ are two
different players in the real example messages). Auto-linking on a fuzzy score
would risk a wrong, silent merge. This extends the parser's "never silently
guess" rule rather than inventing new tolerance.

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

**Two pairing modes.** *Variety* is the behaviour described above. *Balanced*
adds a rating-gap term so the two sides come out close in strength. Balance
leads there — one repeat partnership is worth about five rating points — which
is the reason for choosing the mode at all; variety still separates
arrangements that are level on skill. The mode is per session and defaults to
variety.

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
ignores is worse than no queue. A court always needs exactly 4, so a roster
that isn't a multiple of 4 leaves a remainder sitting out even when the court
count itself isn't the limit.

A wait starts at the latest of the session start, the end of that player's last
match, and the moment they joined or returned (`engines/waiting.ts`, shared by
the engine, the API and both screens). Taking the latest is what stops someone
who arrived an hour late from being owed an hour they were not here for.

**The search is exact when it can afford to be, and local otherwise.** A
court's score reads only within-court pairs, so a court's contribution is
independent of the others — which means that once you know who shares a court,
the best way to split those four into teams can be chosen court by court and
is genuinely optimal, not greedy. All that is left to search is *who shares a
court*.

With eight or fewer players on court that space is 315 arrangements, so the
engine enumerates it and returns a provably optimal round. Larger rosters use
random restarts feeding a steepest-descent local search: repeatedly exchange
two players across two courts, keep the best improving exchange, stop when
none improves. A swap only touches two courts, so each candidate is scored by
re-splitting those two and reusing the rest.

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

The display view shows only *active* courts, so a proposed-but-unconfirmed
pairing never reaches the venue screen. It refreshes every 30 seconds and has
a manual refresh control; neither needs extra server infrastructure such as
websockets.

## Current state

Everything described above is built: the three engines, the API, the Angular
client in Thai with English as a second locale, the display view, per-court
undo, resting players, wait timers, one-tap fill, both pairing modes, session
archive, player pages, export and delete, and a PWA manifest.

`docs/2026-09-05-review-and-v2-backlog.md` records the review that drove most
of it. One item there is deliberately unbuilt — a host role. Its original
justification (that a host role would reverse a "no auth" decision, and that
export and delete were gated only by knowing the group code) no longer holds:
admin authentication was built, `AdminGuard` closes every route by default, and
export and delete sit behind it. That entry was revised on 2026-09-07 to defer
on what is actually still missing — per-user identity and per-group ownership,
which one shared token cannot express. The trigger for revisiting is a second
group with a different host sharing the deployment, not abuse.
