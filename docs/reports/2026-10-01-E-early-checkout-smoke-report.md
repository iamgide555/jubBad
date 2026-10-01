# Host feedback E — early checkout: build + smoke report

Branch `feat/early-checkout-e`, stacked on `feat/shuttles-d` (E needs D's
shuttle identities). Not merged, not deployed. Plan:
`docs/superpowers/plans/2026-09-30-early-checkout.md`, spec:
`docs/superpowers/specs/2026-09-30-early-checkout-design.md`. Written 2026-10-01.

## Bottom line

E works at the API level at 60 players: a leaver can be quoted, settled and
undone; a settled amount never moves when a shuttle is reused or prices change;
two racing settles for one player leave one receipt; and the final bill
conserves money. **I did not run a browser pass** — the dashboard and bill UI
are covered by component tests only (see "Not covered"). Nothing found is left
open that blocks shipping, but two behaviours below deserve your eye.

Suites at the end: engines 330, server 685 (includes the new scale smoke),
web 623, all passing; server `lint` + `build` and web `ng build` clean.

## What was built (8 plan tasks)

| # | Piece | Result |
|---|---|---|
| 1 | Fourth bill model `perShuttle` + `startingFeeSatang`; advanced sessions only; ordinary prefill skips `perShuttle` configs | done |
| 2 | `SessionCheckout` ledger (idempotency key, `undoneAt`), strict record parsers, export, ordered delete | done |
| 3 | Pure checkout engine + read-only preview route with a snapshot hash | done |
| 4 | Atomic settle, undo, shared session lock, rest-toggle guard | done |
| 5 | Final-bill engine reconciles frozen credits (fair / perShuttle / price models) | done |
| 6 | Bill API returns settled list; removed players must be restored before checkout | done |
| 7 | Courtside dialog: quote, copy Thai text, inline price, confirm, undo; settled chip | done |
| 8 | Bill page: fourth model, settled vs still-due, warnings, LINE text; docs | done |

## Smoke test — what I ran and what I found

`server/src/sessions/smoke-e.spec.ts` (kept in the repo, like the A/B/C smoke).
Real API + real SQLite, 60 players, 8 courts, 40 finished games sharing
physical shuttles (16 distinct identities).

| Check | Result |
|---|---|
| 20 sequential leavers rotating perShuttle / perGame / buffet | All 20 settled; each receipt equals its preview; 105 ms total |
| Earlier receipts after more checkouts and 8 new games reusing used shuttles | Every frozen amount unchanged |
| Final bill read (20 receipts, 48 games) | 3 ms; settled rows separate, none in still-due; `collected = settled + stillDue`; no negative row |
| Shuttle conservation | still-due shuttle (79,700) + settled credit (112,300) = recorded cost (16 × 120฿ = 192,000) exactly; excess 0, no warnings |
| 10 leavers confirming at once | 1 lands, 9 `CHECKOUT_STALE`; each then succeeds on a fresh quote → 10 receipts |
| 12 racing keys for one player | exactly 1 receipt, roster inactive |
| Undo | player active again; second checkout under a new key works; undo after end refused |
| Public session + summary reads | no checkout, amount or key anywhere |
| Ordinary 60-player session | preview → 400 `CHECKOUT_DISABLED`; bill has empty settled list |

### Found and fixed during the build (none reached a user)

| # | Found by | What | Fix |
|---|---|---|---|
| E1 | existing dashboard test | My new `shuttleTools` effect read the session resource while it was in its 404 error state and threw | guard on `error()` like the sibling computeds |
| E2 | my own tests | Several expected amounts ignored the default 1-baht rounding (3,750 rounds to 3,800); engine was right | corrected the test figures |
| E3 | design review of spec vs money | Literal "credit all settled payments" would flag a *refund* whenever leavers' starting fees exceed shuttle cost | perShuttle receipts' starting fee is not credited against shuttles; applied identically in the preview and the final bill (ruling in the ledger) |
| E4 | self-review | Preview credited earlier receipts differently from the final bill | one shared rule, with a test |
| E5 | spec reread | Removed-from-bill players could be quoted | `PLAYER_REMOVED_FROM_BILL`, tested |
| E6 | lint | leftover unused variable after the snapshot refactor | removed |

Mutation checks (deliberately breaking a guard to see tests fail): skipping the
stale-hash compare failed 6 tests, dropping the rest-toggle guard 1, dropping
the idempotent replay 2.

## Behaviours worth your eye

1. **Near-simultaneous leavers go stale.** Settling one leaver changes the
   credits every other quote depends on, so a second host tap within the same
   moment gets "ข้อมูลเปลี่ยน… คำนวณใหม่" and must confirm again (the dialog
   re-quotes automatically). Correct by the spec's "earlier settlement" rule,
   but it is one extra tap when two people leave together.
2. **A leaver's quote is based on games so far.** Someone quoted a whole
   shuttle before it is reused later pays more than the people who share it
   afterwards; the later people pay less, and the total shuttle cost is still
   covered exactly once. Their receipt never changes.

## Not covered

- **No real-browser pass for E** (no login available in this unattended run).
  Dialog, chips, bill page and copy are covered by jsdom component tests only;
  worth a 10-minute look on a phone before deploying: tap sizes in the
  dialog, the quote → confirm flow, the settled section on the bill.
- Rounding changed after a receipt was frozen could leave a sub-step walk-in
  remainder shown as `UNRETURNED_SURCHARGE` (rare; blocks copy until rounding
  is restored).
- The final review of the branch is a self-review (no fresh reviewer was
  dispatched).
- Deploying needs a DB backup first: E adds one migration (`session_checkouts`)
  on top of D's two.
