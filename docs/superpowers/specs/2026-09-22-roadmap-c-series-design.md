# Roadmap C1–C14 — design

Status: Design approved by the owner 2026-09-22. C14's measurement half, C2,
C1 and C3 are built (2026-09-22/24); see the roadmap doc for per-item status.
Everything else in this spec is still unbuilt.
Roadmap: `docs/2026-09-21-feature-review-and-roadmap.md`.

**C3 amendments, owner 2026-09-24** (this spec's §C3 below is superseded
where it disagrees) — see `docs/superpowers/plans/2026-09-24-c3-per-person-bill.md`
for the full implementation plan and its "Deliberate deviations from the
spec" list:
- A walk-in (C2) pays a flat surcharge (`walkInFeeSatang`, default 20฿) that
  is handed back as an equal discount to every billed player, so the total
  collected is unchanged — a group discount, not host profit
  (`engines/bill.ts`'s `distributeCapped`).
- Mutations are `POST`, not `PUT`: `POST /sessions/:code/bill-config` and
  `POST /sessions/:code/roster/:playerId/walk-in`, matching every other
  sessions route (`sessions.controller.ts` mutates via `POST` throughout).
- `computeBill(input: BillInput)` takes one object (`{ config, matches,
  walkInIds, shuttleCount, shuttlePriceSatang }`), not six positional
  arguments.
- `BillConfig.overrides` is `{ playerId, amountSatang }[]`, not a
  `Record<playerId, amount>` — class-validator can validate an array of DTOs,
  not record values.
- The dashboard walk-in badge described under C3's UI below was **cut**:
  `GET /sessions/:code` is `@Public` and feeds the venue display, and
  walk-in status is billing data, so it stays on the host-only bill page
  instead.
- The bill routes, and the roster walk-in mark, are editable **after** the
  session ends (unlike almost every other session mutation, but like
  shuttle details) — billing normally happens once the night is over.
- LINE copy text is plain Thai strings, not `$localize` — always Thai
  regardless of the host's own UI locale (owner decision), since money going
  into a group chat is not the place to localize.

**C1 amendments, owner 2026-09-23** (this spec's §C1 below is superseded
where it disagrees):
- Level scale: kept as Thai letters (BG…B, no A), because the target is
  groups other than the owner's own, who need the letters as a working
  standard. Each level ships with a plain-language definition, shown the
  moment a level is tapped — see `engines/levels.ts` and
  `web/src/app/shared/level-picker`. There is no single official Thai
  standard; the definitions are grounded in the most-cited public sources
  (jhudbadweb.com, guanminton.com, junjao.com, badwebthailand.com) but are
  this app's own working standard, corrected over time by Elo. (A
  yes/no "ช่วยเลือก" helper and a separate "?" full-definitions list
  shipped with C1 first, then were both removed in the C1a follow-up
  below as redundant once tapping a level already shows its meaning.)
- A level is host-only: never in a `@Public` response. Read separately via
  `GET /sessions/:code/levels`, not folded into the session poll.
- Tagging an existing group happens on the player roster page: an inline
  chip per row, saved immediately (its own route,
  `PUT /groups/:code/players/:playerId/level`), plus a "ยังไม่ระบุระดับ"
  filter — not through the general edit-player dialog, which overwrites
  every optional field on save.
- Band scoring key order: `groupRepeat` → `bandBreaks` → partner/opponent
  (variety) or the weighted score (balanced) — not first, to keep
  `groupRepeat`'s existing precedence.
- **The band is a fourth pairing mode (`level`), not a toggle** (owner
  decision 2026-09-23, after C1 first shipped with a separate
  `Session.levelBand` boolean beside the mode toggle). `SESSION_MODES` is
  now `['variety', 'balanced', 'level', 'custom']`, mutually exclusive —
  `level` spreads partners/opponents exactly like `variety` but with the
  ±1 band dominant. `balanced` and `custom` never combine with it: a
  same-level group gets little from balance-by-rating on top, and a
  `custom`-mode host already sees the level badge while placing people by
  hand. `completeCourt`'s band/levels parameters (added for `custom`) were
  reverted along with this — `custom` can no longer reach `level` mode.

**C1a, owner review of C1, 2026-09-23** — a level can now be set or edited
mid-session (not only in roster review), setting one resets the player's
Elo to the level's seed at that moment rather than adding it on top of
whatever they earned unlevelled, and the dashboard gained a toggle player
panel (level, tonight's record, rating as a difference from the seed).
Full design: `docs/archive/specs/2026-09-23-c1-level-followup-design.md`.
See `docs/overview.md`'s "Ratings" section for the reasoning.

**C3 amendment, owner request, 2026-09-24 (D7)** — a walk-in / late-registrant
surcharge, folded into §C3 below rather than kept separate since it changes
the per-person math in all three models. This spec's §C3 already reflects the
amendment (not superseded text, unlike C1's).

**Goal:** Settle how every open roadmap item (C1–C14) works before any of them
is built: data, API, engine, UI, edge cases and tests. Each item then gets its
own implementation plan and its own branch, built one at a time in the order
below. `main` keeps running live sessions throughout.

## Decisions log (owner, 2026-09-22)

| # | Item | Decision |
|---|---|---|
| D1 | C3 | The app calculates each share and copies it out as LINE text, with an optional host-fee line. QR, collecting money and payment tracking stay with KhunThong. |
| D2 | C3 | Three charging models: หารตามจริง (fair pay), คิดต่อเกม (per game), บุฟเฟ่ต์ (buffet). |
| D3 | C3 | Per game means each player pays the rate for each game they played. Singles cost the same as doubles. |
| D4 | C1 | The ±1 level band is soft-dominant and ships with C1. Originally a per-session toggle; folded into a fourth pairing mode (`level`) 2026-09-23 — see the amendment above. |
| D5 | C7 | The co-host gets a session-scoped link now. Group-member accounts come later, with C8's ก๊วนใหญ่ tier. |
| D6 | C8 | Design the mechanism now. Tier gates wait until pricing is re-checked against competitors. |
| D7 | C3 | Added 2026-09-24. A walk-in (C2) pays a flat surcharge on top of their own bill line, redistributed as an equal discount to every billed, non-overridden player (walk-ins included) — a group discount, not host profit, so the total collected is unchanged. |

Anything marked "default" below was proposed, not asked. The owner saw it in
review and did not object, but it is the first thing to revisit if an item's
plan turns up a reason to.

## Grounding facts (checked in code)

- Ratings are recomputed on every read and never stored: `engines/elo.ts`
  `computeRatingTracks`, called by `SessionsService.loadRatings` and by
  `GroupsService.listPlayersManage` / `playerStats`.
- The engine's lexicographic comparator is `compareArrangements` in
  `engines/pairing.ts`, and sit-out selection is `selectSittingOut`.
  Randomness is injected (a `random` parameter), so seeded simulations are
  possible.
- The walk-in credit logic to reuse is `SessionsService.setRosterActiveExclusively`.
- The manual-add search to reuse is `searchCandidates` in
  `web/src/app/core/roster-review.ts`.
- `SessionsService.getSummary` already builds per-player match lists with the
  partner named.
- `GET /sessions/:code` and `GET /sessions/:code/summary` are `@Public`. The
  display reads the former.
- The dashboard and the display both poll every 30 s
  (`session-dashboard.ts`, `session-display.ts`).
- `Session` has `shuttleCount` and `shuttlePriceSatang`. There is no
  court-fee field, and `Group` has only `name`.
- Money parsing (string → satang, float-safe) is in
  `web/src/app/core/shuttle-money.ts`.
- All session writes serialize in-process through `session-lock.ts` (single
  container).
- No simulation harness is committed. B13's ten-night numbers were ad hoc, so
  C14 builds one.

---

## Build order

1. C14 measurement. It shapes the pitch and touches engines only.
2. C2 walk-in → C1 levels → C3 bill (with C10 defaults).
3. C14 display line, C4 phone queue, C6 leaderboard, C9 voice, C11 warning.
4. C5 fixed pairs, C7 co-host and sync.
5. C12 bad Wi-Fi.
6. C8 billing, after the pricing re-check.
7. C13 only if hosts complain.

---

## C14. Measure partner variety and show it

**Measure** (engines only, no schema change)
- `engines/variety-sim.ts` is a pure harness. `engines/variety-sim.test.ts`
  holds the assertions and prints a table.
- Scenario (default):
  - A 16-player group; each night 12–14 of them attend at random.
  - 3 doubles courts and 8 matches per court per night. Match durations are
    random between 12 and 18 min, so courts finish out of step.
  - 12 nights, seeded `random`.
- Three pickers run on identical attendance:
  - **engine**: the real `generateRound`, with history carried across nights,
    exactly as the server does.
  - **random**: rotation-fair selection (the same `selectSittingOut`), then
    random splits.
  - **no back-to-back**: random, but rejects a partner who was also the
    player's partner in their last match. This is the rule PaQueueKa and
    Doubles Team Maker advertise.
- Metrics at nights 4, 8 and 12:
  - mean distinct partners per player;
  - the pair-repeat spread: max − min partner count across pairs that both
    attended at least half the nights;
  - the share of possible partners never met.
- Assertions:
  - The engine beats both baselines on distinct partners and on spread.
  - Margins are set just under the first measured values, so a regression
    fails the test. This is the same role `pairing-quality.test.ts` plays for
    search quality.

**Show**
- Summary API: each player row gains `distinctPartners`. It counts tonight's
  doubles partners only, and a repeated partner counts once.
- Summary UI: a per-player line, "คืนนี้ได้คู่ไม่ซ้ำ N คน".
- Player stat card (`GroupsService.playerStats`) gains
  `partnersLast30Days: { distinct, groupSize }`.
  - `groupSize` = the other players in the group with at least one match in
    the last 30 days.
  - Line: "30 วันนี้ได้เล่นคู่กับ N จาก M คนในก๊วน".

**Tests:** the sim assertions; a summary spec (singles excluded, repeats
counted once); a stats spec (30-day window boundary).

## C2. Add a walk-in to a running session

**API:** `POST /sessions/:code/roster`, body `{ playerId } | { name }`
(exactly one). Owner-guarded, and run under `lock.run`.
- `playerId` must belong to the session's group; otherwise 404.
- `name` creates a `Player` (aliases `[]`, optional `level` per C1).
- Refusals:
  - `SESSION_ENDED` (409).
  - `ROSTER_DUPLICATE` (409). This includes a rested player: the UI sends the
    host to the existing "เปิด" toggle instead.

**Credit (B14)**
- Extract the offset math from `setRosterActiveExclusively` into one helper,
  `rotationCredit(history, activeOthers, own, currentOffset)`. Both paths use
  it.
- A walk-in gets `gamesOffset = highest active count`, `activatedAt = now`,
  `active = true`.
- Among players level on games, the shortest wait sits (the existing rule),
  so the walk-in joins at the back of the queue.

**Edge cases**
- A player on tonight's waitlist may be added. The waitlist row stays as a
  record.
- Pending proposals are never rewritten, the same as the rest rule.

**UI**
- A "+ เพิ่มคน" button in the dashboard roster panel opens a bottom sheet with
  a search field, reusing `searchCandidates`.
  - Results list existing players who aren't on the roster, then
    "เพิ่มเป็นคนใหม่ 'X'".
  - A fuzzy result only suggests. It never auto-merges.
- A new player can be given a level chip (C1).

**Tests**
- The walk-in's offset equals the highest active count, and they don't win
  the next draw.
- 409 on an ended session and on a duplicate; 404 for another group's player.
- setRosterActive behaves the same after the extraction.

## C1. Skill level (ระดับมือ)

**Data:** `Player.level String?`, one of BG / N / S / P- / P / P+ / C / B.
Null means unknown. The list and an index lookup live in `engines/levels.ts`.

**Elo seeding**
- Seed = 900 + 100 × level index: BG 900, N 1000, S 1100, P- 1200, P 1300,
  P+ 1400, C 1500, B 1600. Unknown = 1200 (`STARTING_RATING`). Default.
- `computeRatings(matches, seeds?)` and `computeRatingTracks(matches, seeds?)`
  start each player's rating at their seed before replaying.
- Every caller passes seeds built from `Player.level`: `loadRatings`,
  `listPlayersManage`, `playerStats`, and C6.
- **A level change reseeds the whole history automatically**, because ratings
  are replayed. The seed matters less as results pile up. There is no
  separate "reseed?" decision to make.
- **One level seeds both tracks.** A level is a human judgement about the
  person, not a rating from the other track, so this is not the cross-track
  pollution that `overview.md` rules out.

**±1 band (D4: soft-dominant) — a fourth pairing mode, `level`** (amended
2026-09-23; originally a `Session.levelBand` toggle beside the mode — see
this doc's top amendment note)
- `SESSION_MODES = ['variety', 'balanced', 'level', 'custom']`. Mutually
  exclusive: `level` never combines with `balanced` or `custom`.
- **Selection** (who plays) changes only in `level` mode:
  - The anchor is the first player in the normal rotation queue (games, then
    wait).
  - The court fills from waiting players within ±1 level of the anchor, in
    queue order. An unknown level fits any band.
  - If there aren't enough, it fills from the rest of the queue in order. That
    court is a violation.
  - With several idle courts, it repeats per court.
  - Fairness bound: the neediest player is always the anchor, so a player
    with a rare level waits at most until they reach the front of the queue.
- **Search** (how the chosen players group and split): `compareArrangements`
  gains a key, the number of courts that break the band, right after
  `groupRepeat`.
  - `level` mode: groupRepeat → band → partner repeats → opponent repeats
    (same lexicographic tail as variety).
  - `balanced` and `custom` auto-pair never see the band — they cannot be
    in `level` mode at the same time.
- It never leaves a court empty and can never make a round unsolvable.

Without the selection change the band would rarely hold. Once one court frees
at a time, the four players rotation picks go on together whatever their
levels, and the search can only rearrange those four.

**UI**
- A level chip picker (8 chips plus "ไม่ระบุ") appears in:
  - roster review, for new players and existing players with no level;
  - the player roster page (`UpdatePlayerDto.level`);
  - the C2 walk-in sheet.
- A small badge beside each name in the dashboard roster.
- A fourth segment, "ตามระดับ", in the existing mode toggle (not a separate
  control) — between "สูสี" and "เลือกเอง". Its own mode-hint line explains
  the ±1 band and that the queue may skip ahead.

**Tests**
- elo: seeds are applied, and a level change shifts the replay.
- pairing:
  - 4 N + 4 P+ on 2 courts → never mixed;
  - 3 P+ + 5 N on 2 courts → exactly one court breaks the band;
  - a rare-level player plays within one queue cycle.
- `pairing-quality.test.ts`: the exhaustive enumerator includes the band key.

## C3. Per-person bill, copied as text (D1–D3, D7)

**Research.** Nobody publishes their formula, PlayMatch included (it only says
"3 รูปแบบคำนวณ"). What could be found shows two families of charging:
- **Cost-based:** split what was actually spent.
- **Price-based:** the host sets a rate, keeps any surplus and absorbs any
  loss.

Sources are listed at the end of this document. The three models:

1. **หารตามจริง (fair pay)**, cost-based.
   - Inputs: total court fee, plus shuttle count × price (existing fields).
   - Two toggles, each หารเท่า / ตามเกม: one for ค่าคอร์ท, one for ค่าลูก.
   - Shuttles "ตามเกม": each match's shuttle cost = total ÷ matches, split
     among that match's players.
   - Court "ตามเกม": games stand in for time present. This answers the Pantip
     complaint about people arriving and leaving at different hours, without
     recording when anyone left.
2. **คิดต่อเกม (per game)**, price-based.
   - Rate per player per game played (D3). Optional entry fee (ค่าเข้า) and
     optional cap per person.
   - amount = min(entry + games × rate, cap).
3. **บุฟเฟ่ต์ (buffet)**, price-based.
   - Flat per person. Toggle รวมลูก / ลูกแยก; ลูกแยก adds each person's fair
     shuttle share, by games played.

**Common to all three**
- Games = confirmed and finished matches. A no-result match counts. An undone
  match never existed.
- **Who's billed:** players with at least one game.
  - The host can **add** someone, such as a no-show who still owes. They pay
    the equal, entry or buffet part.
  - The host can **remove** someone (host, coach, guest). In fair pay, a
    removed person's share is spread equally over the billed people, so the
    cost is still covered.
- A per-person **override** amount, for discounts or latecomers. Final — an
  overridden person is excluded from the walk-in pool and discount below.
- **Host fee** (D1): optional +X ฿ per person, in any model.
- **Walk-in surcharge** (D7, added 2026-09-24 — see this doc's top amendment
  note): a player marked as a walk-in (C2) pays a flat fee on top of their
  own line, which is then handed back as an equal discount to every billed,
  non-overridden player — the walk-ins themselves included — capped so
  nobody's amount goes negative (`distributeCapped` in `engines/bill.ts`).
  The total collected is the same as with no walk-in at all, for any
  rounding step — it is a group discount, not a way for the host to profit
  from a walk-in. To keep that exact, each share is rounded first and the
  fee (rounded up to a whole rounding step) and discount move only in whole
  steps. A dashboard badge marking a roster row as a
  walk-in was considered and **cut**: `GET /sessions/:code` is `@Public` and
  feeds the venue display, and walk-in status is billing data, so it lives
  only on the host-only bill page instead, set via its own route
  (`POST /sessions/:code/roster/:playerId/walk-in`).
- **Rounding:** up to 1 / 5 / 10 ฿ per person.
- **Margin**, host only and never in the LINE text: amount collected vs
  actual cost (court + shuttles). Hidden when cost inputs are missing. Net of
  the walk-in fee, since it nets to zero across the group.

**Walk-in mark**
- `SessionRoster.walkIn Boolean @default(false)` — a fact about this player
  tonight, same reasoning as `active`.
- Auto-set `true` when a player is added via C2's walk-in flow
  (`addWalkInExclusively`, `SessionsService`, `server/src/sessions/
  sessions.service.ts:2013`). Players present in the original LINE paste
  (roster or สำรอง) start `false`.
- The host can toggle it for anyone from the bill screen (a chip per row),
  `POST /sessions/:code/roster/:playerId/walk-in`, owner-only, under
  `lock.run`, 404 if the player isn't on the roster. Works after the session
  ends, since billing happens then.

**Math:** pure `engines/bill.ts`, integer satang throughout.
- `computeBill(input: BillInput) → BillResult`, where `BillInput` is
  `{ config, matches, walkInIds, shuttleCount, shuttlePriceSatang }` —
  one object, not five positional arguments (amended 2026-09-24, see this
  doc's top amendment note).
- Equal shares use the largest-remainder method, so they sum to the cost
  exactly before rounding. The walk-in discount uses the same method.
- A missing shuttle count in fair pay gives a shuttle part of 0 and a warning,
  "ยังไม่ได้ใส่จำนวนลูก".
- `walkInIds` entries not in the billed set (e.g. removed) are ignored.
  Negative `walkInFeeSatang` throws (engines fail loudly, per `overview.md`).
- Row gains `walkInFeeSatang` and `walkInDiscountSatang` alongside the
  existing amount, so the UI/text can show "(walk-in)" and the discount is
  auditable. Invariant: Σ final amounts is identical with and without any
  walk-ins marked (same total either way).

**Data:** `Session.billConfig String?` (JSON). It holds inputs only: model,
rates, toggles, `courtFeeSatang`, host fee, walk-in fee (D7), rounding, and
the added and removed ids and a per-person `overrides: { playerId,
amountSatang }[]` (an array, not a `playerId → amount` map — class-validator
can validate an array of DTOs but not record values; amended 2026-09-24). The
bill itself is always recomputed, the same rule as ratings. Which roster rows
are walk-ins (D7) is separate: `SessionRoster.walkIn Boolean`, set via its own
route rather than folded into `billConfig`.

**API:** `GET /sessions/:code/bill` (computed) and
`POST /sessions/:code/bill-config` (class-validator DTO) — `POST`, not `PUT`,
matching every other sessions mutation (amended 2026-09-24). Plus
`POST /sessions/:code/roster/:playerId/walk-in` (D7) to mark or clear a
roster row as a walk-in. All three are owner-only, with no `@Public()`; a
co-host is refused (C7). Unlike almost every other session mutation, they
stay reachable **after** the session has ended, since billing normally
happens once the night is over.

**UI:** a "คิดเงิน" button on the summary, visible to the host only.
- Model tabs → inputs (prefilled from the previous session, per C10) → a
  per-person table with add, remove and override → the margin →
  "คัดลอกข้อความ".
- The copied LINE text is always Thai, regardless of the host's own UI
  locale (owner decision, 2026-09-24) — plain strings, not run through
  `$localize`. Every on-screen label around it still follows the app's
  normal Thai-source/English-target i18n.
- Text template, fair pay example:

```
💰 ค่าก๊วน อ. 22 ก.ย. — <venue>
ค่าคอร์ท 1,440฿ หารเท่า 12 คน
ค่าลูก 18 ลูก × 85฿ ตามจำนวนเกม
ค่าจัดก๊วน 10฿/คน (รวมในยอดแล้ว)
Walk-in +20฿/คน × 1 คน (หารคืนทุกคน)
ปอม  9 เกม  225฿
ตี๋    6 เกม  190฿
บอย  5 เกม  210฿ (walk-in)
…
รวม 2,980฿
```

- Per game header: "เกมละ 50฿ (+ค่าเข้า 80฿, สูงสุด 300฿)". Buffet header:
  "บุฟเฟ่ต์ 180฿/คน (รวมลูก)". Walk-in header line only when fee > 0 and at
  least one billed walk-in.

**Tests:** `engines/bill.test.ts`, covering:
- each model and toggle;
- rounding;
- sum equals cost;
- add, remove and override;
- a missing shuttle count;
- singles at the same rate as doubles;
- walk-in: the worked example above exact (200฿/4/1 walk-in → 45,45,45,65);
  total unchanged with vs without walk-ins marked, in every model; overridden
  or removed players excluded from the pool and discount; fee 0 or no
  walk-ins is a no-op; คิดต่อเกม cap applies before the discount/fee step;
  odd-satang split by largest remainder; negative fee throws.

Plus an API spec for owner-only access, config validation, and the walk-in
route (auto-set on C2 add, toggle, 404 off-roster, works post-session-end).

## C10. Saved group defaults

- **Derived, with no settings screen** (default). Prefill comes from the
  group's most recent session: venue, court count, shuttle price, and the C3
  `billConfig` without its per-person adds, removes or overrides.
  **The `billConfig` slice of this prefill shipped with C3 itself** (bill
  page prefills from the previous session's config via
  `withoutPerPerson`/`bill-config.ts`); venue, court count and shuttle price
  prefill are the part of C10 still open.
- Values parsed from the LINE message take precedence over the defaults.
- No schema change beyond C3's.
- Explicit `Group` default fields get added only if derived defaults prove
  annoying.
- **Tests:** prefill picks the latest session, and parsed values win.

## C4. Players check the queue on their own phone

**API**
- The public session payload gains `queue: { playerId, name, position }[]`.
- It uses the same order as the engine's sit-out rule (effective games, then
  wait via `engines/waiting.ts`), computed on the server.
- Names only, no contact data.

**Display route**
- A responsive phone layout: a "my status" card at the top, then active
  courts, then the queue.
- **หาชื่อฉัน**: tapping a name sets `?p=<playerId>` (router query param,
  `replaceUrl`). It can be bookmarked, and needs no localStorage.
- Status states:
  - On court: "อยู่คอร์ท 2".
  - Within the next free court's seats: "คิวถัดไป".
  - Otherwise: "อีกประมาณ N เกม", where N = floor(position ÷ 4).
  - Rested: "พักอยู่".
- The estimate is honest because selection follows queue order. With C1's
  band on it is less exact, which is why it says ประมาณ.

**QR:** a dashboard button, "QR ให้ผู้เล่น", opens a modal with the display
URL as a QR code. Adds the `qrcode` npm dependency, rendered client-side.

**Freshness:** the 30 s poll until C7 lands, instant after.

**Tests:** queue order equals `selectSittingOut` order (server spec); a
display spec for each `?p=` state and the phone breakpoint.

## C6. Public group leaderboard with seasons

**Route and API**
- `/s/:sessionCode/leaderboard`, reached from links already shared in LINE.
  This keeps the group code out of public links, in line with
  `OwnershipGuard`'s 404 posture.
- API: `GET /sessions/:code/leaderboard?season=current|2026H1…`, `@Public`.

**Seasons** (default): calendar halves, 1 Jan – 30 Jun and 1 Jul – 31 Dec, in
Asia/Bangkok time. This matches T-BAD.

**Computation**
- The group's matches inside the season, replayed with
  `computeRatingTracks(matches, levelSeeds)`.
- A player needs at least 5 games in a track that season to appear.

**Output**
- Rank, name, games, wins and win rate. The Elo number is not shown (default):
  a rank causes fewer arguments than a number.
- A doubles tab, plus a singles tab if anyone qualifies.
- A season picker for the current and the previous season.

**Links:** from the summary page and the display.

**Gating:** none now. C8 may gate it later.

**Tests:** season boundary in Bangkok time, the minimum-games filter, seeds
applied, and another group's data never leaks.

## C9. Voice call-out

- `web/src/app/core/announcer.service.ts` wraps `speechSynthesis` with a `th`
  voice, rate 0.95.
  - With no `speechSynthesis` or no Thai voice, the toggle is hidden. An
    English voice reading Thai text is unintelligible.
- Text: "คอร์ท 2: ปอม กับ ตี๋ พบ เบส กับ เกียร์". Singles: "คอร์ท 3: ปอม พบ เบส".
- **Dashboard:** a 🔊 toggle. It speaks after this device's own successful
  confirm.
- **Display:** a 🔊 toggle. It speaks pairings that became active since the
  last refresh. The first load is silent, and several announcements play one
  after another.
- The toggle lives in component state, off by default. The tap that turns it
  on also unlocks audio on browsers that require a gesture. It is not
  persisted, which keeps the no-localStorage rule.
- **Tests:** the text builder, and the display's newly-active diff.

## C11. Warning when roster = 4 × courts

- The session payload gains `fixedFoursRisk`. It is true when all of these
  hold:
  - the active roster count equals the sum of court capacities (4 per doubles
    court, 2 per singles court);
  - the count is above 0;
  - there are at least 2 courts.
- **Dashboard:** a dismissible banner, "ผู้เล่นพอดีคอร์ท ไม่มีคนพัก —
  จะวนอยู่กลุ่มเดิมทั้งคืน". Actions:
  - "ลดเหลือ N−1 คอร์ท", which calls setCourtCount;
  - a tip to set one court to singles;
  - a tip to drag a player to another court.
- Dismissal is component state. The banner returns when the condition goes
  false and then true again.
- **Tests:** flag cases (mixed formats, rested players excluded, a single
  court → false).

## C5. Fixed pairs (คู่ประจำ) and "never pair these two"

**Data**
- `PlayerLink { id, groupId, playerAId, playerBId, kind: 'together'|'apart',
  createdAt }`.
- Ids are stored ordered (A < B), unique on (groupId, A, B).
- A player can be in at most one `together` link.

**Scope:** links are group-level and apply only when both players are active
tonight. If one of a together pair rests, the other plays normally.

**API:** `GET/POST/DELETE /groups/:code/links`, owner-guarded. Edited from the
player roster page.

**Selection**
- A together pair is one unit in the queue. Its priority is taken from the
  member with more effective games, so a pair can't jump ahead on the needier
  member's place.
- A unit takes 2 seats and is only offered to doubles courts.
- If only 1 seat is left, the unit is skipped for that court and keeps its
  place in the queue.

**Search**
- `compareArrangements` key order: band (C1) → link violations → partner
  repeats → opponent repeats.
- A link violation is a together pair on different teams, or an apart pair on
  the same team. Apart players may still face each other as opponents.
- A together pair is left out of the partner-repeat term, since its count is
  the same in every arrangement.
- Local-search swaps move a unit as a unit.

**Host overrides:** a manual swap or drag may break a link, because the host
is in charge. The court panel then shows "แยกคู่ประจำ". Custom mode's manual
seating ignores links; its auto-pair honours them.

**Tests**
- The exhaustive enumerator includes the link key.
- Rotation fairness for units.
- A singles court never gets a unit.
- The one-seat-left skip.
- An apart pair is never placed as partners when an alternative exists.

## C7. Co-host (D5) and faster sync

**Co-host link**
- Data: `SessionCohostToken { id, sessionId, tokenHash, createdAt,
  revokedAt? }`. The token is stored as a SHA-256 hash, like `PasswordReset`.
  A session has one live token; making a new one revokes the old one.
- Flow:
  1. The host taps "ให้คนอื่นช่วยคุม" and gets `/s/:code/cohost#<token>` to send
     by DM, not to the group.
  2. That page posts the token to `POST /sessions/:code/cohost/claim`.
  3. The server sets a signed cookie scoped to that session.
- `CohostGuard` allows a request if the caller is the owner, an admin, or
  holds a valid co-host cookie for *this* session. The token stops working
  once `session.endedAt` is set or it is revoked.
- **Co-host allowed:** propose, confirm, finish, undo, swap, seats, autopair,
  fill, roster active, deprioritize, walk-in (C2), court count, format, mode
  (including `level`, C1).
- **Co-host refused:** end session, shuttle details, bill (C3), export,
  delete, player contact data, links (C5).
- Host UI: a share button, "ยกเลิกลิงก์" to revoke, and whether a co-host has
  claimed the link.

**Sync**
- `SessionEventsService` holds a `Map<sessionCode, Subject<{ version }>>`.
  - Every locked mutation bumps it after commit. This goes through one wrapper
    around `lock.run`, so no mutation can forget.
- `@Sse(':code/events')` is `@Public`. The payload is only a version number;
  data is still fetched through the existing GET.
- A heartbeat comment every 25 s keeps the connection alive through the
  Cloudflare idle timeout.
- nginx: `proxy_buffering off` for the events path.
- Web: `LiveSessionService` opens an `EventSource` and refreshes on each
  message, debounced by 300 ms. The 30 s poll stays as a fallback.
- It is in-process, the same single-container constraint as
  `session-lock.ts`.

**Tests**
- Guard matrix: owner, admin, co-host, revoked co-host, ended session, and a
  co-host of a different session.
- An event is emitted after each mutation.
- The web service refreshes on an event.

## C12. Survive bad Wi-Fi in the hall

**Service worker:** `@angular/service-worker` with `ngsw-config.json`.
- The app shell (index, js, css) is prefetched; images and fonts are lazy.
- No `dataGroups`, so the API is always network-only.
- `navigationUrls` excludes `/api`.

**Updates**
- On `SwUpdate` VERSION_READY, a banner shows "มีเวอร์ชันใหม่ แตะเพื่อโหลด"
  and a tap reloads. This stops a stale shell running after a deploy.
- It checks every 10 min and whenever the page becomes visible again.
- nginx sends no-cache headers for `index.html` and `ngsw.json`.

**Retry**
- An interceptor retries status 0, 502, 503 and 504, up to 3 times, backing
  off 1, 2 and 4 s.
- **Only requests marked safe to retry** (an `HttpContext` token). The C12
  plan checks each one against the server code before marking it; the list
  below is the expected result, not yet verified:
  - GETs;
  - revision-guarded mutations (confirm, finish, swap, seats, autopair);
  - the idempotency-keyed session create;
  - propose and fill (a busy court returns 409);
  - shuttle details and bill config (plain overwrites).
- **Not retried:** `deprioritize-waiting`. It isn't idempotent: a second run
  credits the same players again.
- A 409 after a retry triggers a refresh and a toast, "อาจบันทึกไปแล้ว —
  เช็กหน้าจออีกครั้ง".

**Offline banner:** driven by `navigator.onLine` and the online/offline
events: "ออฟไลน์ — รอสัญญาณ".

**Full offline use is not proposed.** The engine stays on the server, per
`overview.md` "Why the engines run on the server".

**Tests:** the interceptor (retry set, backoff, the 409 path, the no-retry
list); `ng build` emits `ngsw.json`.

## C8. Billing gates and self-service sign-up (D6)

**Plan data**
- `User.plan` ('free' | 'host' | 'club', default 'free') and
  `User.planRenewsAt DateTime?`.
- One helper, `effectivePlan(user, now)`, returns `plan` while
  `planRenewsAt > now` and 'free' after. It is derived, never a stored flag,
  and a lapse never deletes data.

**Admin:** the console gains a plan column and "set plan + renew date", used
after a manual PromptPay payment.

**Sign-up**
- `POST /auth/register` (email and password) creates a host on the free plan.
  It reuses `password.ts`, `login-throttle.ts` and the existing session
  cookie.
- A Thai `/register` page, linked from the login page.

**Gate hook:** a `@RequiresPlan('host')` decorator and guard, **applied to
nothing yet**. Which features sit behind which tier is filled in after the
pricing re-check.

**Always free:** public links (display, summary, leaderboard, player card).

**Tests:** the `effectivePlan` lapse boundary, register (duplicate email,
throttle), the admin plan update, and the guard on a dummy route.

## C13. Tap-to-register sign-up link (sketch, not scheduled)

**Build only if hosts complain about pasting.**

- Data: `SignupSheet { id, groupId, tokenHash, title, date?, closedAt? }` and
  `SignupEntry { sheetId, name, createdAt, removedAt? }`.
- Public `/join/:token` shows the names so far and a "ใส่ชื่อ" field. Only the
  host can remove a name.
- Host: "นำเข้ารายชื่อ" feeds the names into the existing roster review as if
  they were pasted. Fuzzy matching is unchanged.
- Any mid-session feed must go through C2's walk-in path (B14 credit).

---

## Cross-item consistency

- The B14 credit helper `rotationCredit` is shared by setRosterActive, C2 and
  C13.
- Level seeds (C1) feed balanced mode, the roster page, the player card and C6.
- The `compareArrangements` key order is fixed: band (C1) → links (C5) →
  partner → opponent.
- C3's `billConfig` feeds C10's defaults.
- C2's `addWalkInExclusively` sets `SessionRoster.walkIn` (D7); C3 reads it as
  the default mark, then the host can override per person from the bill.
- The co-host (C7) never reaches money or contact data.
- C7's SSE makes C4's phones and C9's display announcements instant. Both
  work without it.
- C8 gates nothing until pricing is decided. Public links are never gated.

## `overview.md` updates owed when items ship

`overview.md` describes built behaviour, so these land with the item, not now.
The KhunThong decision row and the out-of-scope list were already updated with
this spec, because they record a decision rather than behaviour.

- C1: the Ratings section gains level seeding (one level seeds both tracks,
  and why that is not cross-track pollution). The sit-out paragraph gains the
  band-on selection rule.
- C2: the roster review paragraph loses "no way to add a player to a running
  session".
- C3: the end-session paragraph loses "Nothing is calculated from them yet".
  Note the walk-in surcharge is redistributed as a discount, not host profit.
- C5: the Pairing section gains links in the key order and pair units in
  selection.
- C7: the display paragraph's "refreshes every 30 seconds" becomes SSE with a
  poll fallback. The decision table gains the co-host link.
- C12: "Current state" loses "no service worker".

## Sources (C3 research)

- [Pantip: สูตรคำนวณค่าใช้จ่ายหลังตีแบด](https://pantip.com/topic/41907022/desktop)
- [BadmintonHouse: ก๊วนบุฟเฟต์คืออะไร](https://www.facebook.com/badmintonhousebangkok/posts/547642766634443/)
- [FB group post: บุฟเฟ่ต์ 180/คน รวมค่าลูก](https://www.facebook.com/groups/484337425727705/posts/2272792943548802/)
- [PlayMatch](https://www.playmatch.pro/)
- [jame191036/badminton-match PR #1 (hourly court fee, equal split)](https://github.com/jame191036/badminton-match/pull/1)
- [GuanMinton finance guide](https://guanminton.com/guide/finance)
- [Lemon8: มือใหม่ตีก๊วนแบด](https://www.lemon8-app.com/@palmapa/7470463855307522576?region=us)
- [Lemon8: ค่าใช้จ่ายในการตีแบต](https://www.lemon8-app.com/@duangdaothsa/7470170629673599508?region=us)
