# Host feedback E: early checkout with reusable shuttles

## Intent and scope

A player leaving before the night ends needs a final amount that the host
can quote and collect immediately. The amount must not later change when
a physical shuttle is reused, another game finishes, the host edits prices,
or a game log is corrected. The host previews and explicitly confirms
settlement; the app then prevents the player from playing again in this
session and excludes them from the final "still due" rows. As in the
existing bill, the app calculates and copies Thai text for LINE but does
not handle payments, QR codes, or receipt verification.

Only sessions created with D's snapshotted `shuttleToolsEnabled = true`
offer checkout. A group's later switch-off does not invalidate earlier
advanced sessions. F's level ladder is independent. This design assumes
D's numbered, reusable shuttle identities, known/unknown match use logs,
and owner-only bill. `perShuttle` is also **advanced-session-only** on
the final bill; ordinary sessions keep exactly the original three
models. A physical shuttle reused in two games costs money only once.

## Pricing choices and required facts

An early checkout chooses **one of three** models for that player, regardless
of the eventual whole-session bill model: `perGame`, `perShuttle`, or
`buffet`. `fair` is not available mid-session. Add `perShuttle` as the
**fourth** whole-session bill model alongside `fair`, `perGame`, and
`buffet`. Add one non-negative session `startingFeeSatang` to
`Session.billConfig` (default 0, carried from the previous session like
the other rates); use the existing `Session.shuttlePriceSatang` for the
per-physical-shuttle price. For `perShuttle`, the base amount is the
starting fee plus that person's share of distinct identities in their
finished games. Do not charge per appearance as though reuse opened
another shuttle.

The new model charges **recorded game use only**, not warm-up, lost, or
other physical-count discrepancies. `Session.shuttleCount` stays a
separate host cost/margin input and does not scale `perShuttle` player
charges, unlike D's fair/by-games physical reconciliation. Missing
physical count does not block a per-shuttle quote or final copy; the
host's actual cost/margin remains unknown until it is entered. A
recorded empty game is valid; an unknown log in a player's finished game blocks
that player's per-shuttle checkout. An unknown finished game blocks
copying a whole-session `perShuttle` bill until corrected; no physical
count may invent its use. A missing shuttle price blocks either bill
when shuttle use is priced, while **0** is a valid price. With no finished
games, a per-shuttle checkout may still charge the starting fee; the
whole-session model includes billed no-shows only when the host adds
them, following existing C3 behavior.

`perGame` checkout uses the current per-game rate, entry fee, cap, and
actual finished-game count. `buffet` uses the configured flat price and
its existing shuttles-included toggle; if excluded, add the player's
recorded shuttle share and require known use/price. All three early
models honor the existing applicable host fee, walk-in fee/discount,
per-person override, and configured rounding. A missing field required
for the chosen calculation blocks confirmation and sharing; a
legitimate zero does not. Copy explains that person's model,
finished-game count where relevant, fees and amount in Thai, regardless
of the host's UI locale.

When a group disables advanced tools, an ordinary **new** session may
not select or inherit `perShuttle` from an earlier advanced session.
Look back for the most recent usable non-`perShuttle` config, or use the
ordinary default `fair` config if there is none; do not change older
advanced sessions or delete their saved configs. Ordinary bill screens
show only their original three models. Re-enabling advanced tools on
the group affects only subsequent sessions.

## Preview, settlement, and player lifecycle

The host opens checkout on the advanced dashboard for any roster player
not already checked out, including someone who has played zero games.
A player in a pending match must first be manually removed or
reshuffled; a player in an active match must finish or receive "no
result" before checkout. Do not edit visible pending teams under the
host's hand. The preview computes an itemized amount using finished
matches and current rates, but **does not** disable the player, count
anything as settled, or reserve an amount. Copying preview text has no
side effects and labels the amount as a preview, not as already paid.

Confirming the preview saves a checkout ledger entry with session/player
IDs, selected model, frozen integer-satang total, component breakdown,
rate and game/shuttle-use snapshot, settlement time, and an idempotency
key. It atomically sets the roster entry inactive and records the
settlement under the existing session lock. The server recomputes the
preview inside the commit transaction; if any effective pricing, player,
game/use, walk-in, or earlier-settlement input differs, return
`CHECKOUT_STALE` without disabling or charging the player. A repeated
request with the same key returns its prior outcome, never a second
ledger entry. Two different attempts for an already checked-out
player return `PLAYER_CHECKED_OUT`. A failed write leaves both ledger
and roster unchanged. This is a host acknowledgment that the quoted
amount has been collected or committed for collection; the app cannot
verify an external payment.

An active checkout prevents re-enabling the player through the normal
roster rest toggle, selecting them for a pending court, adding them
again as a walk-in, or confirming an earlier pending proposal. Do not
reuse `SessionRoster.active` alone to infer settled state: temporary
rest and final checkout differ. Explicit **Undo checkout**, requiring
host confirmation and allowed only before session end, marks the ledger
entry undone, removes its credit, restores the player's availability
using the normal rotation-credit rule, and warns that any real-world
refund/recollection is manual. An undone entry remains in owner export
as an audit trail; later checkout of that player gets a new key and
entry. No ordinary rest toggle can undo settlement. A corrected game,
rate, physical count, or later reuse never changes a settled entry.

## Sharing physical-shuttle cost without rebilling leavers

Before any checkout, D's fair/by-games path divides effective physical
shuttle cost among distinct identities, then their finished-game uses,
then players. The new `perShuttle` path instead divides **recorded**
distinct-identity cost at the session shuttle price by that same
identity/game/player path, independent of the physical total. At early
checkout, use only games finished so far and the available price,
subtract credits already frozen by earlier checkouts, and allocate the
unsettled shuttle cost across eligible game participants; save the
chosen player's resulting share. Thus sequential leavers cannot each
be billed again for a shuttle already fully covered. A shuttle can
still be reused later on any court. Its later use changes only the
unsettled allocation, not earlier receipts.

The final bill has two clearly separated groups: settled checkout
receipts (read-only, their original model/amount) and amounts **still
due** from participants not checked out. Settled players do not appear
in still-due rows; do not implement that by adding them to the
existing `removedIds`, which would redistribute their full share and
lose their payment. The overall collected total and margin include
settled amounts **once**, plus current still-due amounts. Editing
`BillConfig.removedIds` cannot make a checked-out player billable
again; checkout takes precedence over any old added/removed/override
choice for that player, and a player already excluded from billing must
be restored explicitly before checkout. The copied final LINE text
identifies settled people and separately totals still due and already
settled; the margin remains
host-only.

With a final `fair` bill, credit **all** settled checkout payments,
including ones originally priced per game or buffet, toward the
night's court-plus-shuttle cost. Split only the non-negative remaining
cost among still-due participants using the selected fair court and
shuttle split rules. With final `perShuttle`, still-due participants
each owe their starting fee; credit all settled payments toward the
recorded shuttle cost (at most the cost) before dividing its residual
among still-due players by their recorded game use. With final
`perGame` or `buffet`, still-due players owe their selected fixed-rate
amounts; settled payments contribute to collected totals and margin,
not to those players' rates.

Walk-in surcharges must remain a group transfer, never host profit.
Snapshot any discount already included in an early receipt. For cost
models, a settled surcharge contained in the frozen amount credits
the same outstanding cost once; do not also apply it as a second
discount. For final price-based models, distribute any surcharge not
already returned in frozen discounts among eligible **unsettled**
players, including the walk-in; never change a frozen receipt or
distribute the same surcharge twice. If no eligible player can absorb it,
surface it explicitly and require a host correction/undo rather than
reporting it as profit. Overrides retain the existing rule that an
overridden row bypasses walk-in surcharge and discount.

If later edits reduce the cost below settled credits, never create a
negative still-due bill: show the excess as an explicit
overpayment/refund amount for the host to resolve outside the app.
Likewise, if no one remains eligible to cover a positive residual,
show an uncovered shortfall, not a fictitious collection. Do not
silently relax frozen amounts, block post-checkout shuttle corrections,
or retire shuttles to preserve pricing. Copies identify when a
refund/shortfall requires host action and do not present the
calculation as a fully reconciled bill until handled.

## Server, host UI, and verification

Persist the ledger in a separate `SessionCheckout` table linked to
session and roster player, with an explicit `undoneAt` rather than
deleting a mistaken settlement. Owner-only endpoints preview, confirm,
list, and undo checkouts. The session's existing in-process lock
serializes settlement, undo, shuttle writes, roster changes, and
price/config writes that affect a preview. Confirmation also uses a
DB transaction and compares the effective snapshot, so a concurrent
stale client or a write that bypassed the lock cannot settle an
outdated amount. Bill reads must see a consistent checkout/use/config
snapshot. Owner mismatch returns 404, ordinary sessions return a
stable `CHECKOUT_DISABLED` error, and missing facts return actionable
400/409 codes. No checkout or receipt data appears on public session,
venue display, player profile or summary routes.

The dashboard shows a 44px-or-larger checkout action in the host roster
and a distinct, non-reactivatable checked-out state. A focused dialog
shows the three model choices, itemized preview, copy-one-person text
with clipboard fallback, explicit settlement confirmation, and
actionable missing-data/stale messages. It can point to a pending or
active court that must be cleared first. A separate confirm-to-undo
action warns about real-world money. Owner-only bill UI offers the
fourth final model, starting-fee input, settled receipt section,
still-due section, cost/margin and refund/shortfall warnings. Thai
source strings and English translations preserve one-handed controls;
the copied text stays Thai. Public display remains untouched.

Tests cover rejection of `perShuttle` config and checkout on ordinary
sessions (API as well as hidden UI), basic versus advanced snapshots,
zero games and 0 price, single/multiple reused IDs in singles/doubles,
successive early
checkouts and later reuse; per-game, per-shuttle and buffet checkout
independent of all four final models; cap, host fee, override,
walk-in/rounding neutrality; pending and active refusal; rest-toggle
and duplicate-walk-in guards; idempotent retry and concurrent confirm;
rate/use changes between preview and confirm; undo with rotation
credit; corrected prices/logs after settlement; excess credit,
uncovered cost and no eligible discount recipients; owner/public
boundaries, Thai copy and English labels. Keep engine arithmetic in
integer satang. Export settled and undone receipts, and extend the
group's dependency-ordered hard delete to remove ledger rows before
sessions (including the admin deletion path).

Out of scope: collecting money, QR/slip verification, retroactively
checking out ordinary sessions, changing physical shuttle history to
balance a payment, and changing A/C/F behavior.
