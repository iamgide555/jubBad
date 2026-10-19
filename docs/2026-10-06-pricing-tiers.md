# Pricing tiers: feature map (built, dormant)

Status: **decided 2026-10-06, revised 2026-10-19, built behind admin-set plans,
dormant until a host is set to free.** There is no billing integration; per the
commercial plan, billing stays manual PromptPay until 2-3 hosts are paying. How
the gating works is in `docs/overview.md` ("Plans"); this doc is the feature map.

## Principle

- **Free = run tonight with fair rotation and variety.** Pairing, equal games, no
  repeat partners, a basic bill, the recap.
- **Paid (Host, 249฿/mo) = run a bigger ก๊วน, or earn from it.** Power tools for hosts
  who run the group as a business or at scale.
- Free is never gated on the core loop, and public links never lapse.

## Tier map

| Area | Free | Host (249฿/mo) |
|---|---|---|
| Night running | Roster paste, fuzzy-match, manual add, walk-in, courts propose/confirm/finish/undo, auto-confirm, wait timers, rest player, one-tap fill | Lineup queue (G, `QueuedMatch`) |
| Matchmaking | สลับคู่ (variety), เลือกเอง (custom), per-court singles/doubles, court labels | สูสี (balanced), ระดับ (level), per-court mode inside เลือกเอง, มือล่าง/มือบน court targets, custom level ladder (F), player rules (`PlayerRule`), cross-session history |
| Money | Fair pay, per-game, buffet, rounding, remove/add person, shuttle total count and price, copy to LINE | Host fee, walk-in fee, ไม่มา, ตามลูกแบด (bill model, with its คิดเต็มต่อคน switch), numbered shuttles, per-match shuttle log, per-player shuttle breakdown, early checkout |
| Results | Record winner; correct a finished game's winner or score | |
| Public | Venue display, session recap link (permanent, never expires) | Group dashboard `/d/:token` |
| History and stats | In-app archive, stat history and export limited to the last 30 days | Full archive, player stat cards, rating and win rate, host roster page, export |
| Platform | Login, PWA, delete group, shared venue field, 1 group | Up to 3 groups. ก๊วนใหญ่ 499฿/mo: up to 10 groups and 5 managers |

Annual: pay 10, get 12.

## Decisions and their reasons (2026-10-06)

- **Bill extras are paid.** Host fee, walk-in fee, ไม่มา and ตามลูกแบด (including its
  คิดเต็มต่อคน switch) answer "how do I collect and earn", not "how do I split cost".
  The owner uses host fee and walk-in himself and the pilot host charges similar
  extras. Fair pay, rounding, remove/add, per-game and buffet stay free: many hosts
  already charge flat, and gating those would make the bill unusable for them.
- **ตามลูกแบด is paid as a whole model,** not only its คิดเต็มต่อคน switch. It prices
  people from the numbered-shuttle log, so it rides with the numbered-shuttle items
  and the `shuttleToolsEnabled` switch. Free keeps the plain shuttle total count and
  price, which fair pay, per-game and buffet can still use.
- **Correct winner/score is free.** It fixes a tap mistake courtside; a free host with
  wrong stats and no fix would blame the app, not the tier. Never needed at a real
  night yet, kept free because mistakes happen.
- **Lineup queue (G) is paid.** Asked for by the owner after a big-roster night. It
  matters at 4+ courts with a long waiting list, which is the paying customer. A
  small group with 1-2 courts is covered by auto-propose.
- **Archive capped at 30 days, data kept.** The cap is a time-triggered upgrade
  reason with no feature to click. Rows are hidden, never deleted, and return on
  upgrade. The public recap link stays free and live after a lapse.

### Revisions (2026-10-19)

- **สูสี stays paid; free does not get a level-less สูสี.** Considered: free สูสี with
  level editing paid, so everyone starts at 1200 and ratings build from play.
  Simulated (real `generateRound` and `computeRatings`, 30 seeded runs, 8 nights,
  14 regulars on 3 courts): free-style สูสี repeats partners in 5% of games on night
  1 rising to 17% by night 8 (สลับคู่: 0%), while the true skill gap per game barely
  improves for the first 3 nights (69 to 60, and 46 only by night 8). Seeded levels
  (paid) cut the gap to about 27 from night one, about 60% better than variety. So
  free would pay the repeat-partner cost for almost no balance, and paid is where
  สูสี earns it. Evidence in `docs/2026-09-25-engine-evidence-gaps.md` (G9). The
  simulation is crude (10 rounds a night, simultaneous rounds, bell-shaped true
  skill); the direction is clear, the exact percentages are not.
- **Court targets (มือล่าง/มือบน) are paid,** with ระดับ, whose level data they need.
- **Shared venues are free,** no gate: a search field on roster entry, no new data
  shown to anyone.
- **Recap URL is permanent and free.** Its audience is players opening a LINE link
  weeks later, and a dead link damages the growth loop for no upgrade pressure. The
  30-day cap hides only the host's in-app views: group-home session list, stat
  history and cross-session aggregates, export.
- **Group limits: free 1, Host 3, ก๊วนใหญ่ 10 groups and 5 managers.** The owner runs
  2 groups, so Host must allow at least 2; a cap of 1 would force 499฿ for a second
  night of the same business. ก๊วนใหญ่ is about delegating to other managers.

## Rules that must hold when this is built

- **Non-payment drops to free, derived from `planRenewsAt` lapsing.** Never a stored
  flag; `disabledAt` stays reserved for abuse. Data is never deleted.
- **Public routes never lapse:** `/s/:code/display` and the session recap keep
  working, because the recap shared into LINE is the growth loop.
- **Elo keeps recording on free,** and replays the *full* match history, including
  rows hidden by the 30-day archive cap. Only the rating UI and the modes that read
  it are gated, so a new subscriber has real history on day one and ratings never
  reset monthly.
- **`shuttleToolsEnabled` is the natural single switch** for the numbered-shuttle
  items (D and E); it is already off by default.
- **Gating is derived at read time,** not stored per feature, matching the
  recompute-never-store rule used for ratings, wait times and bills.

## Open risks

- **Pilot host usage is unverified.** Confirm he uses the paid items nightly,
  especially the bill extras and the queue, before treating them as the hook. Ask
  how many nights a week he runs, and whether he charges host fee, walk-in fee or
  ไม่มา.
- **Pilot host runs more than 3 groups and earns his living from them,** so he lands
  on ก๊วนใหญ่ (10 groups) and price sensitivity is low. Offer ก๊วนใหญ่ 499฿ (the public
  price, and the top of the founding scale, so the two agree) with the free pilot
  period and a locked price as the founding perk. 499฿ is an opening position set
  2026-10-19, replacing 749฿, which was a 3x step with no validation; his reaction
  decides the final number. His answers on nightly use
  of the paid items still matter, but for what to build next, not for whether he can pay.
- **Group dashboard has no real-night evidence yet.** It is the newest feature and
  sits in paid as a "host shows players the value" tool. Move it to free if it does
  not land with the pilot host.
- **Nothing here is validated by a paying customer.** Per the commercial plan, the
  pilot host's answer at the end of his free period decides final pricing; this map
  is the opening position.

## Related

- Pilot terms and founding-host pricing: memory `project-jubbad-commercial`.
- Bill behaviour referenced above: "Bill (C3)" in `docs/overview.md`.
