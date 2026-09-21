# JubBad — feature review against competitors, and roadmap

Reviewed 2026-09-21 against `main` at `f4891cb`. This replaces
`docs/archive/plans/2026-09-05-review-and-v2-backlog.md` as the list of what is
still open. Every work item in that backlog is built. Its two remaining
entries were never work items, and both are carried forward below.

Items are numbered C1 onwards, continuing that backlog's A and B series, so
that a later plan, commit or doc can cite one by number.

Competitor features come from each product's own website or store listing. None
of these apps was used hands-on. Treat a feature in the comparison as
"advertised", not "verified".

---

## Headline: the premise in `overview.md` did not hold

`overview.md` used to say that nothing Thai-language existed for running a
session for a group that already exists, and that localization was therefore
the differentiator. At least three Thai tools do exactly that job:

| Product | Price | Scale claimed | Overlap with JubBad |
|---|---|---|---|
| **T-BAD** (tbadapp.com) | Free, with no paid tier ("ฟรี 100% ตลอดไป ไม่มีแพ็กเกจเสริม") | 11K+ players | Roster imported from a pasted LINE message, skill levels, Elo split into singles and doubles, fixed pairs, TV display, voice announcements, offline, PWA |
| **PlayMatch** | Free up to 40 members and 8 sessions/month (1 year); 149 THB/mo; 219 THB/mo unlimited | 550+ ก๊วน | Queue, court-fee and shuttle-cost split (3 methods), PromptPay QR, payment status, live queue on players' phones, MMR leaderboard |
| **BC COURT** | 99 / 199 / 599 THB (free during beta) | – | Time-based queue, skill-level check, duplicate-pair check, shuttle stock, wallet, ranking |

Two consequences:

1. **Being in Thai and friendly to LINE is now the minimum, not a moat.**
   `overview.md` has been revised to say what still separates this app. In
   short: pairing quality across the group's whole history, Thai nickname
   matching, per-court singles/doubles, per-court undo, a rest toggle that
   credits missed games, and refusing to double-book a player. None of the
   competitors' public material claims history-weighted variety; they
   advertise a duplicate-pair check.
2. **Pricing has to be set against these numbers.** One strong competitor is
   free, and the largest tops out at 219 THB/month, which already includes
   cost splitting, PromptPay and a leaderboard. Check the planned tiers
   (kept outside this public repo) against that before building any billing
   (C8).

---

## What JubBad has today

- **Import.** Parses the roster from a pasted LINE message. Fuzzy-matches Thai
  nicknames but only ever suggests, never auto-merges. The review screen also
  has a search field for adding someone the paste missed.
- **Pairing.** Three modes: variety, balanced (Elo) and custom (seat by seat,
  with auto-pair). Partner and opponent history counts across all sessions.
  The search is exact for up to eight players on court and a checked local
  search above that.
- **Courts.** Each court runs its own lifecycle and can be doubles or singles.
  Undo, void match and reshuffle. Swap players by tap, or by drag across
  pending courts. Fill every idle court in one tap. The court count can change
  mid-session.
- **Players on the night.** Rest toggle that credits missed games, wait
  timers, games tally, deprioritize waiting.
- **Screens.**
  - Host dashboard.
  - Venue TV display, refreshed every 30 s.
  - Public session summary: time on court, win rate split by singles and
    doubles, shuttle count and price.
  - Public player stat card.
  - Host-only player roster page: contact details, rank by rating or win rate.
- **Accounts and data.** Per-host login with ownership per group, admin
  console, export and delete, backup scripts, PWA manifest, Thai and English.

## Checked in code, not assumed

The gaps below were confirmed against the source, not inferred from the docs:

- `Player` has no skill or level field. Every rating starts at 1200, so
  balanced mode is close to random for a new group (`overview.md` "Ratings"
  says so).
- `SessionsController` has no route that adds a player to a running session.
  The manual add works on the review screen only, before the session exists.
- `Session` stores `shuttleCount` and `shuttlePriceSatang`. Nothing reads them
  except the summary display.
- There are no plan, tier or renewal fields anywhere in the schema, and no
  self-service sign-up route (`auth.controller.ts` has only login, logout, me,
  forgot and reset).
- There is no service worker. Only `manifest.webmanifest` is linked, so the
  app does not work offline.
- The dashboard and the display both refresh by polling every 30 s. A second
  device waits up to half a minute to see a change.

---

## Roadmap

Priority means:
- **P0:** a host comparing apps would leave without it.
- **P1:** it sets JubBad apart or keeps players coming back.
- **P2:** cheap polish.
- **P3:** skip unless the target customer changes.

Effort is rough: S is up to a day, M is a few days.

### P0

#### - [ ] C1. Skill level per player (ระดับมือ)

Tag each player with the level Thai groups already use: BG / N / S / P- / P /
P+ / C / B. Use it for two things:

- **Seeding the Elo.** A P+ player starts well above an N player instead of
  both starting at 1200. That fixes balanced mode's cold start, which
  `overview.md` currently admits to.
- **An optional "same level ±1" constraint** for groups that split courts by
  level.

Every Thai competitor has this: T-BAD's ±1-level mode, BC COURT's
"เช็คระดับมือ", Qcourt's "skill rank" on quick-add. It is the most visible
thing a Thai host will look for.

Design questions to settle first:
- Does the level live on `Player`? It should: it is a fact about the person.
- Does a level change reseed the rating, or only apply to new players?
- Singles and doubles tracks: one level seeding both, or one each?

Effort M.

#### - [ ] C2. Add a walk-in to a running session

Someone who is not on the pasted list turns up. Today the host has to end
the session and start a new one, or leave that player out. Competitors all
support adding on the fly (Qcourt, Queue Master, T-BAD).

**Must meet B14** (below): the new roster row gets the same `gamesOffset`
credit as re-activating a player, or the walk-in wins every rotation draw
until they catch up. Reuse the roster review's search-or-create field so an
existing player keeps their history.

Effort S–M.

#### - [ ] C3. Per-person bill, copied out as text

Court fee plus shuttles, split per player, copied as text for the LINE group.
The collecting stays with KhunThong. This is what every host does after every
session. The session already stores shuttle count and price, so this is half
built. PlayMatch offers three calculation methods. A Pantip thread asking for
exactly this formula (people arriving and leaving at different hours) shows
the pain is real and recurring.

**This partly reopens a recorded decision.** `overview.md` delegates cost
splitting to KhunThong. The proposed line is: the app *calculates* each
share and copies it out; the QR code, payment tracking and slip checking stay
with KhunThong. The owner decides whether that line holds.

Calculation methods to consider:
- Court fee split equally.
- Shuttles split equally.
- Shuttles split by games played. This needs shuttles per match or an
  estimate, since today's count is per session.

Effort M. It pairs with C10 (saved default prices).

### P1

#### - [ ] C4. Players check the queue on their own phone

The display route is public but built for a TV across the hall. Many halls
have no screen. Proposed:
- A phone layout for the display route.
- "Find my name", showing "you're up next" or "about N games until you're on".
- A QR code on the dashboard linking to it.

PlayMatch sells this as "เช็คคิวผ่านมือถือ" (check the queue on your phone).
Racket Social and ShuttleFlow have shared session links or QR codes.

Effort S–M.

#### - [ ] C5. Fixed pairs (คู่ประจำ) and "never pair these two"

Couples, or a coach with a beginner, who always play as a pair. The other
direction is two players who should not be partners. T-BAD has fixed pairs.

This is a hard constraint on the engine, so it has to go through the
exact-versus-local search reasoning in `overview.md`. It narrows the space the
search explores, and must not make a round unsolvable.

Effort M.

#### - [ ] C6. Public group leaderboard with seasons

Group-wide ranking, with a minimum number of games before a player appears
and a periodic reset so newcomers can climb. T-BAD resets on 1 Jan and 1 Jul
with a 5-game minimum. ShuttleFlow runs 45-day seasons. PlayMatch has an MMR
leaderboard.

The data already exists: the host-only roster page ranks by rating and win
rate. This is a public, read-only view of it, and a natural paid-tier
feature.

Effort S.

#### - [ ] C7. Co-host and faster sync

The host usually plays too, so someone else needs to run the dashboard while
the host is on court. Ownership is currently one owner per group, and the
30 s polling means two phones show different courts.

Needs:
- A per-group co-host role on top of `OwnershipGuard`.
- Shorter polling or server-sent events while a session is live.

ShuttleFlow has owner and admin roles with live sync.

Effort M.

#### - [ ] C8. Billing gates and self-service host sign-up

Only after the P0 items and a pricing check against the table above. Nothing
exists yet: no plan fields and no register route. Hosts are created by hand
in `/admin` today, which is fine for the first handful of customers.

Effort M.

### P2

#### - [ ] C9. Voice call-out

"คอร์ท 2: A, B พบ C, D" read aloud when a match is confirmed, using the
browser's own speech (Web Speech API; most phones have a Thai voice).
T-BAD has it. It is cheap and players notice it.

Effort S.

#### - [ ] C10. Saved group defaults

The group's usual venue, court count, court fee and shuttle price, filled in
for each new session. Needed by C3.

Effort S.

#### - [ ] C11. Warning when roster = 4 × courts

The cheap option already written up in B13: a dashboard hint that nobody is
resting, so the same four will keep sharing a court.

Effort S.

#### - [ ] C12. Survive bad Wi-Fi in the hall

- A service worker for the app shell, so the app loads even when the hall's
  Wi-Fi is bad.
- Retry for mutations that fail on a flaky connection.

Full offline use is *not* proposed: the engine runs on the server
deliberately, so that court fills are serialized (`overview.md` "Why the
engines run on the server"). Racket Social and T-BAD are offline-first because
they run on a single device.

Effort M.

#### - [ ] C13. Tap-to-register sign-up link

A link players tap to put their own name down, replacing the paste. It
is already named in `overview.md` as the lower-risk fallback if pasting ever
becomes a real pain. Only worth building if hosts actually complain; the
LINE list is how these groups already work.

Effort M.

### P3 — skip unless the target customer changes

- **Club-business features:** shuttle stock and low-stock alerts, wallet or
  credit, coupons, birthday reminders (PlayMatch, BC COURT). These serve a
  venue running a business, not a friend group.
- **Court booking, find-a-group marketplace, coach booking** (T-BAD). A
  different product.
- **Tournament brackets.**
- **Mixed-gender balancing.** No demand signal found in this review.
- **Any LINE bot.** Still rejected; see `overview.md`.

## Suggested order

1. Check pricing against the competitor table (a decision, not code).
2. C2, then C1, then C3.
3. C4, C6, C9: cheap, and players can see them.
4. C5, C7.
5. C8 (billing) last.

---

## Carried forward from the 2026-09-05 backlog

Neither item is scheduled work. Both are conditions to keep in mind.

### B13. A roster of exactly 4 × courts locks players into fixed fours

When the roster is exactly four per court, the steady state frees one court
at a time, holding only the four who just walked off. The same fours persist
all night: with 12 players on 3 courts, each partners 3 of the other 11. One
spare player takes that to 7–10. It is not a scoring fault, and no weighting
fixes it. The measurements, and why reshuffle cannot help, are in the archived
backlog's B13 entry. Current workarounds:
- Drag a player to another court.
- Set one court to singles.
- Drop a court.

C11 is the cheap way to make this visible.

### B14. Adding a player mid-session must credit them like a re-activation

A player inserted on zero games while everyone else is on five wins every
rotation draw until they catch up. Any feature that changes how players enter
a session — C2 above, and C13 if it ever feeds a running session — must set
`gamesOffset` the same way `SessionsService.setRosterActive` does. Re-read A15
in the archived backlog before touching this, because its reasoning depends on
the within-session spread staying near one game.

---

## Sources

- T-BAD: [ระบบจัดก๊วน](https://tbadapp.com/th/clubs/manage), [home](https://tbadapp.com/th)
- PlayMatch: [features](https://www.playmatch.pro/), [packages](https://www.playmatch.pro/packages)
- [BC COURT](https://www.badcrazy.net/)
- [จัดก๊วนแบด (Google Play)](https://play.google.com/store/apps/details?id=cal.badminton.nu.badmintoncalculator&hl=en_US)
- [Pantip: สูตรคำนวณค่าใช้จ่ายหลังตีแบด](https://pantip.com/topic/41907022/desktop)
- [Racket Social](https://racketsocial.app/)
- [ShuttleFlow](https://shuttleflow.ph/)
- [Shuttl](https://shuttl.app/)
- [Qcourt (App Store)](https://apps.apple.com/ph/app/qcourt/id6757377299)
- [Queue Master](https://queuemaster.site/)
- [PaQueueKa](https://www.paqueueka.info/)
- [Ladderly](https://ladderly.online/)
