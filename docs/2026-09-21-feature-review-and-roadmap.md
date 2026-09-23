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

## Strengths against competitors

A second, wider pass on 2026-09-21 covered about twenty products:

- **Thai:** T-BAD, PlayMatch, BC COURT, Qcourt (Thai developer, English-only
  UI), Bad-Web Plus (a find-a-group directory, not a session tool), BotBad (a
  hobby LINE bot) and จัดก๊วนแบด (a cost calculator).
- **International:** Racket Social, Kiki-match, ShuttleFlow, PaQueueKa, Shuttl,
  Queue Master, Matcherfy, Ladderly, Doubles Team Maker, BPQ (open source),
  Reclub, GroupSlam and Badminton Match Manager.

Same caveat as above: this is what each product advertises. Two of them could
do more than their pages say, and are worth a hands-on test before any claim
goes into a pitch: PlayMatch (its "Weight ผู้เล่นให้มีความ Balance" is not
explained) and Kiki-match (its weights include partner and opponent variety).

### Where JubBad is stronger

| JubBad | Closest thing any competitor advertises |
|---|---|
| **Partner and opponent variety counted across every session the group has played** | Racket Social varies partners "across the session", using simulated annealing within one session. PaQueueKa and Doubles Team Maker avoid *back-to-back* repeats. BC COURT has a duplicate-pair check ("เช็คคู่ซ้ำ"), scope not stated. Kiki-match weighs variety from its history, but it lives in one browser, and whether it spans days is not stated. T-BAD's modes are longest wait, same level, ±1 level or random, with no partner variety at all. |
| **Pairing search quality**: exact for up to eight players on court; repeats counted, not yes/no; partner repeats ranked strictly above opponent repeats | Most say "smart random" (PlayMatch "สุ่มคู่อัจฉริยะ", T-BAD "สุ่มจับคู่"). Kiki-match has adjustable weights (0–100). |
| **Reads the full LINE message**: date, time, venue, court count, waitlist (สำรอง) and notes, with nothing silently dropped | T-BAD reads names only, and deletes "ข้อความอื่น" (other text). Queue Master and BPQ take a pasted list of names. Everyone else adds players one at a time or has them self-register. |
| **Thai nickname matching against known players**, so a player's history follows them from week to week | Not advertised by anyone |
| **Undo per court**, several steps back | Not advertised by anyone |
| **Fairness for late arrivals and rests**: wait counted from when the player arrived; games credited when they return | Racket Social says it "handles" late arrivals. T-BAD has a rest/return status. Nobody describes crediting games. |
| **Singles and doubles mixed per court**, in the same session | T-BAD and Qcourt support both formats; mixing them per court is not stated. Kiki-match is doubles only. |
| **History stored on the server**: survives a lost phone, and shared recap links read from it | T-BAD ("ข้อมูลก๊วนเก็บอยู่ในเครื่อง", data kept on the device), Kiki-match, Racket Social and Qcourt keep data on one device. |
| **No player accounts, no bot** | PaQueueKa, Reclub and Matcherfy have player accounts. BotBad sits in the group chat and listens. |

The first row is the one to lead with. No competitor's public material claims
history-weighted variety across sessions. It also answers the most common
complaint in a casual group: "I always play with the same person".

### Where JubBad is weaker

| Gap | Who has it | Roadmap item |
|---|---|---|
| Skill levels (BG to A+) | T-BAD, Qcourt, BC COURT, PaQueueKa, ShuttleFlow, BPQ, Kiki-match | C1 |
| Cost split / bill | PlayMatch (with PromptPay), BC COURT, Qcourt, ShuttleFlow, BotBad | C3 |
| Players join or check the queue on their own phone | Queue Master (QR), PaQueueKa, Shuttl, ShuttleFlow, Matcherfy (push alerts) | C4 |
| Real-time sync across devices | ShuttleFlow, PaQueueKa, BPQ (websocket) | C7 |
| Works offline | T-BAD, Racket Social, Qcourt, Kiki-match | C12 (app shell only) |
| Leaderboard with seasons | T-BAD, PaQueueKa, ShuttleFlow, PlayMatch | C6 |
| Fixed pairs | T-BAD, Qcourt ("group mode") | C5 |
| Price | T-BAD, Kiki-match, Racket Social and Qcourt are free; PlayMatch claims 550+ groups | C8 |

### The catch: the strength is invisible on the first night

A host trying apps for one evening cannot see cross-session variety. It only
shows after weeks. Skill levels and a bill are visible in the first minute.
So the strongest feature needs two things: a number that proves it (C14), and
the first-minute gaps closed (C1–C3) so hosts stay long enough to notice it.

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

#### - [x] C1. Skill level per player (ระดับมือ) — done

Design: `docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md`, section C1
(amended 2026-09-23 — see that section's header for what changed).

Tag each player with the level Thai groups already use: BG / N / S / P- / P /
P+ / C / B, each with a plain-language definition and a yes/no "ช่วยเลือก"
helper in the picker — there is no single official standard, so this is the
app's own working definition, corrected over time by Elo. Used for:

- **Seeding the Elo.** A P+ player starts well above an N player instead of
  both starting at 1200. That fixes balanced mode's cold start, which
  `overview.md` used to admit to unconditionally — see its updated "Ratings"
  section.
- **An optional "same level ±1" constraint**, as a fourth pairing mode
  (`level`, alongside variety/balanced/custom — not a separate toggle,
  owner decision 2026-09-23) for groups that split courts by level — see
  `overview.md`'s "Selection" section for the fairness bound and the
  scoring key order.

Every Thai competitor has this: T-BAD's ±1-level mode, BC COURT's
"เช็คระดับมือ", Qcourt's "skill rank" on quick-add. It is the most visible
thing a Thai host will look for.

A level is host-only, never on a `@Public` response. Tagging a whole group
happens on the player roster page (an inline chip per row, saved
immediately, plus a "ยังไม่ระบุระดับ" filter), not through the general
edit-player dialog.

#### - [x] C1a. Set level mid-session, Elo reset on set, live player panel — done

Design: `docs/archive/specs/2026-09-23-c1-level-followup-design.md`.

Owner review of C1 on 2026-09-23: a host usually doesn't know a new
player's level until they've watched them play, so the level has to be
settable **during** the session, not only at roster review. Three changes:

- **Elo "reset on set"**: an unlevelled player sits at neutral 1200, never
  0 (a 0-rated player breaks Elo for their partner/opponents). Setting a
  level, first time or edit, resets that player's rating to the level's
  seed at that moment — only matches confirmed afterwards move it, so a
  level chosen after watching wins doesn't double-count them.
- **Dashboard player panel** (toggle): every roster player with tonight's
  played/won/lost, their level (editable in place), and rating shown as
  the difference from the level's seed (e.g. `P +50`).
- **Level picker**: one row of chips in roster review, ช่วยเลือก helper
  and the "?" definitions list removed — tapping a level already shows
  its definition.

Also fixed en route (found while finishing the implementation): a partial
build had left `Player.levelSetAt` in `schema.prisma` with no migration
(would have failed `prisma migrate deploy`), `finishedMatches()`/
`loadRatings` not selecting `confirmedAt`, which throws once any player
has a level, and `updatePlayer`/`updatePlayerLevel`/roster-review/walk-in
writes not stamping `levelSetAt` at all.

#### - [x] C2. Add a walk-in to a running session — done

Design: `docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md`, section C2.

Someone who is not on the pasted list turns up. A "+ เพิ่มคน" button on the
dashboard opens a search-or-create sheet, reusing the roster review's
search-or-create logic so an existing player keeps their history.
Competitors all support adding on the fly (Qcourt, Queue Master, T-BAD).

**Meets B14** (below): the new roster row gets the same `gamesOffset` credit
as re-activating a player (a shared `rotationCredit` helper, so the two
paths can't drift apart), so the walk-in joins the rotation instead of
winning every draw until they catch up. Someone already on tonight's
roster, including a resting one, is refused as a duplicate — the dialog
points the host at the existing roster chip instead.

C1's level chip on the walk-in sheet landed with C1, once it shipped.

#### - [ ] C3. Per-person bill, copied out as text

Design: `docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md`, section C3.

Court fee plus shuttles, split per player, copied as text for the LINE group.
The collecting stays with KhunThong. This is what every host does after every
session. The session already stores shuttle count and price, so this is half
built. PlayMatch offers three calculation methods. A Pantip thread asking for
exactly this formula (people arriving and leaving at different hours) shows
the pain is real and recurring.

**This partly reopens a recorded decision.** `overview.md` delegated cost
splitting to KhunThong. The owner decided on 2026-09-22 that the line holds:
the app *calculates* each share and copies it out, with an optional host-fee
line; the QR code, payment tracking and slip checking stay with KhunThong.
The spec replaces the list below with three charging models: หารตามจริง
(fair pay), คิดต่อเกม (per game) and บุฟเฟ่ต์ (buffet).

Calculation methods to consider:
- Court fee split equally.
- Shuttles split equally.
- Shuttles split by games played. This needs shuttles per match or an
  estimate, since today's count is per session.

Effort M. It pairs with C10 (saved default prices).

**Amendment (owner, 2026-09-24, D7):** a walk-in / late-registration
surcharge (flat, host-customisable, default 20฿). Redistributed as a
discount to every billed player rather than kept by the host. See the design
doc's C3 section for the mechanics.

### P1

#### - [ ] C4. Players check the queue on their own phone

Design: `docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md`, section C4.

The display route is public but built for a TV across the hall. Many halls
have no screen. Proposed:
- A phone layout for the display route.
- "Find my name", showing "you're up next" or "about N games until you're on".
- A QR code on the dashboard linking to it.

PlayMatch sells this as "เช็คคิวผ่านมือถือ" (check the queue on your phone).
Racket Social and ShuttleFlow have shared session links or QR codes.

Effort S–M.

#### - [ ] C5. Fixed pairs (คู่ประจำ) and "never pair these two"

Design: `docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md`, section C5.

Couples, or a coach with a beginner, who always play as a pair. The other
direction is two players who should not be partners. T-BAD has fixed pairs.

This is a hard constraint on the engine, so it has to go through the
exact-versus-local search reasoning in `overview.md`. It narrows the space the
search explores, and must not make a round unsolvable.

Effort M.

#### - [ ] C6. Public group leaderboard with seasons

Design: `docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md`, section C6.

Group-wide ranking, with a minimum number of games before a player appears
and a periodic reset so newcomers can climb. T-BAD resets on 1 Jan and 1 Jul
with a 5-game minimum. ShuttleFlow runs 45-day seasons. PlayMatch has an MMR
leaderboard.

The data already exists: the host-only roster page ranks by rating and win
rate. This is a public, read-only view of it, and a natural paid-tier
feature.

Effort S.

#### - [ ] C7. Co-host and faster sync

Design: `docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md`, section C7.

The host usually plays too, so someone else needs to run the dashboard while
the host is on court. Ownership is currently one owner per group, and the
30 s polling means two phones show different courts.

Needs:
- A co-host who can run the courts. Decided 2026-09-22: a session-scoped
  link now, which needs no account and dies when the session ends. A
  per-group co-host account comes later, with C8's multi-manager tier.
- Server-sent events while a session is live, with the 30 s poll kept as a
  fallback.

ShuttleFlow has owner and admin roles with live sync.

Effort M.

#### - [ ] C8. Billing gates and self-service host sign-up

Design: `docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md`, section C8.

Only after the P0 items and a pricing check against the table above. Nothing
exists yet: no plan fields and no register route. Hosts are created by hand
in `/admin` today, which is fine for the first handful of customers.

The spec designs the mechanism only (plan fields, derived lapse, manual
activation, self-sign-up). Which features sit behind which tier waits for the
pricing check.

Effort M.

#### - [ ] C14. Measure partner variety and show it

Design: `docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md`, section C14.

This is the one strength no competitor claims (see "Strengths against
competitors"), and nobody can see it on the first night. Two parts:

1. **Measure it. Done** (`engines/variety-sim.ts`, `engines/variety-sim.test.ts`).
   A seeded 12-night, 16-player, 3-court simulation runs the real engine
   against two baselines: random pairing, and "avoid a back-to-back repeat"
   (the rule PaQueueKa and Doubles Team Maker advertise). The engine beats
   both on distinct partners per player and on pair-repeat spread at nights
   4, 8 and 12, and the margins are asserted in a test, guarding against the
   engine quietly losing its edge — the same role
   `engines/pairing-quality.test.ts` plays for search quality. No schema
   change, no server or UI change yet.
2. **Show it.** Not started. Put one line on the session summary and the
   player card, for example "คืนนี้ได้คู่ไม่ซ้ำ N คน" (partnered N different
   people tonight), or "เดือนนี้ได้เล่นกับ N จาก M คนในก๊วน" (played with N of
   the group's M players this month). The summary link is what gets shared
   into LINE, so that line reaches every player, not just the host. Per the
   build order below, this lands after C2, C1 and C3.

Measuring is S and runs in `engines/` with no schema change. Showing it is S
on data the summary already loads.

### P2

#### - [ ] C9. Voice call-out

Design: `docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md`, section C9.

"คอร์ท 2: A, B พบ C, D" read aloud when a match is confirmed, using the
browser's own speech (Web Speech API; most phones have a Thai voice).
T-BAD has it. It is cheap and players notice it.

Effort S.

#### - [ ] C10. Saved group defaults

Design: `docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md`, section C10.

The group's usual venue, court count, court fee and shuttle price, filled in
for each new session. Needed by C3.

Effort S.

#### - [ ] C11. Warning when roster = 4 × courts

Design: `docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md`, section C11.

The cheap option already written up in B13: a dashboard hint that nobody is
resting, so the same four will keep sharing a court.

Effort S.

#### - [ ] C12. Survive bad Wi-Fi in the hall

Design: `docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md`, section C12.

- A service worker for the app shell, so the app loads even when the hall's
  Wi-Fi is bad.
- Retry for mutations that fail on a flaky connection.

Full offline use is *not* proposed: the engine runs on the server
deliberately, so that court fills are serialized (`overview.md` "Why the
engines run on the server"). Racket Social and T-BAD are offline-first because
they run on a single device.

Effort M.

#### - [ ] C13. Tap-to-register sign-up link

Design: `docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md`, section C13.

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

1. Check pricing against the competitor table (a decision, not code), and
   do C14's measurement. Both shape the pitch before any feature work.
2. C2, then C1, then C3.
3. C14's summary line, C4, C6, C9: cheap, and players can see them.
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

Thai:

- T-BAD: [ระบบจัดก๊วน](https://tbadapp.com/th/clubs/manage), [home](https://tbadapp.com/th)
- PlayMatch: [features](https://www.playmatch.pro/), [packages](https://www.playmatch.pro/packages)
- [BC COURT](https://www.badcrazy.net/)
- [Qcourt (App Store)](https://apps.apple.com/ph/app/qcourt/id6757377299)
- [Bad-Web Plus](https://app.badwebthailand.com/group)
- [BotBad (GitHub)](https://github.com/Chawengwit/BotBad)
- [จัดก๊วนแบด (Google Play)](https://play.google.com/store/apps/details?id=cal.badminton.nu.badmintoncalculator&hl=en_US)
- [Pantip: สูตรคำนวณค่าใช้จ่ายหลังตีแบด](https://pantip.com/topic/41907022/desktop)

International:

- [Racket Social](https://racketsocial.app/)
- [Kiki-match](https://kiki-match.com/en)
- [ShuttleFlow](https://shuttleflow.ph/)
- [PaQueueKa](https://www.paqueueka.info/)
- [Shuttl](https://shuttl.app/)
- [Queue Master](https://queuemaster.site/)
- [Matcherfy (App Store)](https://apps.apple.com/ph/app/matcherfy/id6535672675)
- [Ladderly](https://ladderly.online/)
- [Doubles Team Maker (App Store)](https://apps.apple.com/us/app/-/id6745511996)
- [BPQ (GitHub)](https://github.com/rein168/BPQ)
- [Reclub](https://reclub.co/)
- [Badminton Match Manager (Google Play)](https://play.google.com/store/apps/details?id=info.nichiten.badminton_manager&hl=en_US)
- [Top free queueing systems (Facebook post, PH)](https://www.facebook.com/bamtintontimeph/posts/top-free-queueing-management-system-for-badminton1-queue-maestro2-queue-master3-/122213574086258703/)
