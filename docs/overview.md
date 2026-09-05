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
| No login/auth | Groups are identified by a shareable link/code instead of accounts. Removes a whole feature surface |
| Trigger-word LINE bot (reconsidered, still rejected) | The idea: a bot watches the group for a keyword ("Play") then auto-extracts the roster, skipping the manual paste. Rejected on inspection — the LINE Messaging API has no message-history endpoint (confirmed in LINE's docs), so a bot can only look *forward* from when it joins. In real use the roster is posted days before "Play" is typed, so the bot would have to continuously store *all* group messages in a rolling buffer to look backward — that is full passive listening plus retention, the exact risk rejected above, not a lighter trigger-gated version. It also reopens "no infra" and "no posting bot" at once. Revisit only if paste friction proves to be a real dealbreaker; the lower-risk fix for the typing/copying pain is a tap-to-register roster link |
| No cost-splitting / PromptPay QR in-app | KhunThong (ขุนทอง), KBank/KBTG's LINE bot, already does this well — bill split (equal or not), PromptPay QR, and payment verification by e-slip scan, which the planned v1 didn't even have. The host invites KhunThong separately; no integration needed |
| Score logging: final score only, no live scoreboard | Point-by-point, serve indicators and timers are scope creep nobody asked for. A final score per court is low-friction and still bootstraps the match history that future skill/Elo balancing would need |
| No host role — anyone with the link can edit (**accepted risk**) | With no auth the link can't distinguish host from player. Acceptable for a trusted friend group; add a host role later only if abuse becomes real |
| No data-retention/deletion policy (**accepted risk**) | Names persist indefinitely under a group's link code. Revisit if group turnover or privacy requests make it necessary |
| No promoting a waitlisted (สำรอง) player mid-session | The สำรอง list is resolved in LINE *before* the session — a waitlisted player was told not to come, so there is nobody at the venue to promote. The feature would serve a situation that cannot occur. Waitlisted names are still imported and shown, so the host can see who was turned away |

## Explicitly out of scope

- Multi-sport support — badminton-only, Thai-only. That is the moat.
- Any LINE bot, posting or passively listening (reconsidered once; still out).
- LIFF / LINE Login, user accounts, login.
- Live point-by-point scoreboard.
- Cost splitting / PromptPay QR — delegated to KhunThong.
- Skill/Elo match balancing. Deliberately deferred, not designed out: the
  schema already captures everything a rating model would replay —
  `Pairing.teamA`/`teamB` (who played with and against whom), `scoreA`/`scoreB`
  (outcome and margin), `winner`, and `confirmedAt` (a real timestamp, giving
  the chronological order Elo needs). The one soft dependency is that scores
  are optional, so ranking quality would depend on how consistently hosts enter
  them; `winner` is one tap and far better populated.

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

### Pairing

Courts rotate **independently, not as synchronized rounds** — whoever finishes
first gets the next match right away. There is no shared "round" object; the
app calls `generateRound` with `courtCount = 1` and a roster of whoever isn't
currently on another court, every time a single court frees up.

Arrangements are scored, lowest wins:

```
score = 10 × (repeat-partner pairs) + 1 × (repeat-opponent pairs)
```

**Repeat-partner avoidance is the primary goal; opponent balancing is a
secondary soft signal.** The 10:1 ratio exists so an arrangement can never
trade away a partner-repeat to save on opponent-repeats — the opponent term
only decides between arrangements already tied on partners. A hard opponent
constraint on top of the partner constraint would risk making sessions with a
lot of history unsolvable, since it over-constrains an already-small namespace.

Two scopes, deliberately different:

- **Partner and opponent history is all-time across sessions.** The whole
  point is spreading variety over the group's life, not just one evening.
- **Games played is this session only.** Sit-out rotation should be fair within
  tonight, not carried over from weeks ago.

Sit-out selection is deterministic and outside the weighted score: whoever has
played the most so far today sits, ties broken randomly. Predictable to the
host ("they've played the most, so they sit"). A court always needs exactly 4,
so a roster that isn't a multiple of 4 leaves a remainder sitting out even when
the court count itself isn't the limit.

The search is randomized — shuffle, greedily build a candidate, score it,
repeat ~200 times, keep the best. "Good enough and fair", not "provably
optimal". Exhaustive enumeration is infeasible at 10-20 players, and a real
min-cost matching optimizer would be overkill here.

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

**Confirm is the commit point.** History — partner counts, opponent counts,
games played — updates only when a match is confirmed, never when one is
proposed. That single rule is what makes free reshuffling, late arrivals and
no-show removal compose correctly without any extra engine work.

The display view shows only *active* courts, so a proposed-but-unconfirmed
pairing never reaches the venue screen. It refreshes manually, matching the
app's no-extra-infra style — no websockets, no polling loop.

## Current state

v1 is built and deployed: parser, fuzzy matching, pairing engine, the API, the
Angular client, the display view, end-session, per-player stats, and targeted
player swaps.

Known gaps, with reasoning and suggested order, are in
**`docs/2026-09-05-review-and-v2-backlog.md`**. The largest one is that the UI
is currently English throughout, while the whole differentiator above is
Thai-language support.
