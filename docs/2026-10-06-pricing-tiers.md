# Pricing tiers: feature map (draft, not implemented)

Status: **decided 2026-10-06, nothing built.** No `plan` field, no gating code, no
billing integration exists yet. Per the commercial plan, billing stays manual
PromptPay until 2-3 hosts are paying, so this doc is the spec a future gating
change reads from.

## Principle

- **Free = run tonight fairly.** Pairing, fair play, a basic bill, the recap.
- **Paid (Host, 249฿/mo) = run a bigger ก๊วน, or earn from it.** Power tools for hosts
  who run the group as a business or at scale.
- Free is never gated on the core loop, and public links never lapse.

## Tier map

| Area | Free | Host (249฿/mo) |
|---|---|---|
| Night running | Roster paste, fuzzy-match, manual add, walk-in, courts propose/confirm/finish/undo, auto-confirm, wait timers, rest player, one-tap fill | Lineup queue (G, `QueuedMatch`) |
| Matchmaking | สลับคู่ (variety), เลือกเอง (custom), per-court singles/doubles, court labels | สูสี (balanced), ระดับ (level), per-court mode inside เลือกเอง, custom level ladder (F), player rules (`PlayerRule`), cross-session history |
| Money | Fair pay, per-game, buffet, rounding, remove/add person, shuttle total count and price, copy to LINE | Host fee, walk-in fee, ไม่มา, คิดเต็มต่อคน, numbered shuttles, per-match shuttle log, per-player shuttle breakdown, early checkout |
| Results | Record winner; correct a finished game's winner or score | |
| Public | Venue display, session recap link | Group dashboard `/d/:token` |
| History and stats | Session archive capped at 30 days | Full archive, player stat cards, rating and win rate, host roster page, export |
| Platform | Login, PWA, delete group, 1 group | ก๊วนใหญ่ 749฿/mo: up to 5 groups and 5 managers |

Annual: pay 10, get 12.

## Decisions and their reasons (2026-10-06)

- **Bill extras are paid.** Host fee, walk-in fee, ไม่มา and คิดเต็มต่อคน answer "how do I
  collect and earn", not "how do I split cost". The owner uses host fee and walk-in
  himself and the pilot host charges similar extras. Fair pay, rounding, remove/add,
  per-game and buffet stay free: many hosts already charge flat, and gating those
  would make the bill unusable for them.
- **Correct winner/score is free.** It fixes a tap mistake courtside; a free host with
  wrong stats and no fix would blame the app, not the tier. Never needed at a real
  night yet, kept free because mistakes happen.
- **Lineup queue (G) is paid.** Asked for by the owner after a big-roster night. It
  matters at 4+ courts with a long waiting list, which is the paying customer. A
  small group with 1-2 courts is covered by auto-propose.
- **Archive capped at 30 days, data kept.** The cap is a time-triggered upgrade
  reason with no feature to click. Rows are hidden, never deleted, and return on
  upgrade. The public recap link stays free and live after a lapse.

## Rules that must hold when this is built

- **Non-payment drops to free, derived from `planRenewsAt` lapsing.** Never a stored
  flag; `disabledAt` stays reserved for abuse. Data is never deleted.
- **Public routes never lapse:** `/s/:code/display` and the session recap keep
  working, because the recap shared into LINE is the growth loop.
- **Elo keeps recording on free.** Only the rating UI and the modes that read it are
  gated, so a new subscriber has real history on day one.
- **`shuttleToolsEnabled` is the natural single switch** for the numbered-shuttle
  items (D and E); it is already off by default.
- **Gating is derived at read time,** not stored per feature, matching the
  recompute-never-store rule used for ratings, wait times and bills.

## Open risks

- **Pilot host usage is unverified.** Confirm he uses the paid items nightly,
  especially the bill extras and the queue, before treating them as the hook.
- **Group dashboard has no real-night evidence yet.** It is the newest feature and
  sits in paid as a "host shows players the value" tool. Move it to free if it does
  not land with the pilot host.
- **Nothing here is validated by a paying customer.** Per the commercial plan, the
  pilot host's answer at the end of his free period decides final pricing; this map
  is the opening position.

## Related

- Pilot terms and founding-host pricing: memory `project-jubbad-commercial`.
- Bill behaviour referenced above: "Bill (C3)" in `docs/overview.md`.
