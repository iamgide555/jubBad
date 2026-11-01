# Receiving-account owner manages payments from LINE

Status: built (2026-11-01). Branch: `feat/collector-line-access`.

## Why

The person who receives tonight's money is often not the host. It is a regular member who has no JubBad login,
only LINE. Today they can open **ดูสถานะการจ่าย** from the payment card, but that page is read-only: to check a
slip or tick someone who paid in cash, they have to ask the host to do it in JubBad. The host wants the person
holding the bank account (the one who can check their bank app) to do that work themselves, from LINE.

## What it is

The host names, per receiving account, which player owns it. When that player opens **ดูสถานะการจ่าย** from
the LINE card and LINE confirms their identity, they get the host's **สถานะการชำระเงิน** screen for that bill
(the same `SlipReview` component the host uses) instead of the read-only list. Everyone else keeps the read-only
list exactly as today.

The owner is called the **collector** below (in Thai UI: เจ้าของบัญชี / ผู้รับเงิน).

## Goals

1. Host picks the collector in **group settings → บัญชีรับเงิน**, from players who have a linked LINE account,
   each shown with the LINE name and picture. Picking, changing or clearing asks for confirmation first.
2. On the payment card, **แก้บัญชีคืนนี้** offers the same picker (same confirmation) for a collector for that
   bill only. The next bill goes back to the saved collector.
3. The collector, from LINE, can:
   - see waiting slips with their images, review the amount, pick who a slip covers, confirm or skip it;
   - acknowledge duplicate slips;
   - tick and untick people, including the slip-paid guard shipped on 2026-11-01 (tapping a slip-paid row opens
     the slip; undo is a deliberate button; view-only once closed);
   - close collection, under exactly the host's rule (the button appears only when every payable row is paid and
     nothing is waiting), with the same confirmation naming the image deletion.
4. The host's own screens and powers are unchanged.

## Non-goals

- No JubBad login, password or account for the collector.
- No access to group settings, other bills, other groups, the court dashboard, or the bill configuration.
- Collector cannot link or unlink LINE accounts. In `SlipReview` that means: the **คนส่งคือ** sender picker on a
  waiting slip is not shown (resolve sends `senderPlayerId: null`), and the **บัญชี LINE ที่ผูกแล้ว** list is not
  shown. (Owner decision.)
- Collector cannot use **อัปเดตชื่อที่ตั้งไว้** from a receiver-mismatch slip: it rewrites the group's saved account.
- No notification to the collector when slips arrive (they open the card when they want).

## Anti-goals (would be a failure even if it works)

- A player who wrongly self-claimed someone else's name on the pay page gains payment powers. The collector is
  picked explicitly by the host and shown with the LINE picture so the host can see it is really them.
- Anyone other than the current collector of that bill reaching a write route or a slip image.
- The read-only status projection changing shape for ordinary players (its key set is pinned by a test).
- One stray tap reassigning the collector (hence the confirmations).

## Decisions made with the owner

- Identification is by LINE identity only, because the collector is often not someone with a JubBad login.
- Collector may close collection, same flow and rule as the host.
- Picker lists only players with a linked LINE account, each with LINE name and picture; players without one are
  hidden.
- Tonight's account override can carry its own collector (option B), and choosing it needs a confirmation.
- Only the host links or unlinks LINE accounts.

## How it works

### Who counts as the collector of a bill

- The group stores a collector **player id** in a new nullable column (for example `Group.payCollectorPlayerId`,
  a relation to `Player` with `onDelete: SetNull`, one migration). *My call, not inside the `payAccount` JSON:*
  two existing writers re-serialize that JSON from the three account fields alone (`GroupsService.setPayAccount`
  and `SlipPaymentsService.updateSavedReceiverName`), so a collector stored there would be silently dropped by
  "update saved name" or an account edit.
- Saving the collector checks, server side, that the player belongs to the group and has a linked LINE account at
  that moment. Clearing the saved account (all three fields blank) also clears the collector. Changing only the
  account fields keeps the collector (my call; the picker is right there if it should change too).
- The confirmed payment card (`PaymentCardState`) gains an optional **night collector** player id, set on confirm
  only when the host typed a different account tonight (it may be none).
- Which collector a bill has: if the card's confirmed account is the same as the group's saved account, the
  group's **current** saved collector, read live; otherwise the card's night collector. "Same" compares the bank
  and the account number's digits only (spaces and dashes ignored), not the name: "update saved name" from a slip
  changes only the name, and must not cut the collector off.
- At request time the collector's LINE user id is resolved **live** from `PlayerLineAccount` (group + player).
  So the host unlinking that player's LINE, or the LINE group being unlinked (which purges links), ends access
  immediately without touching the card.
- The request is a collector request only when all hold: the card token is the current confirmed token, the plan
  gate passes (same `gate()` as the pay page), LINE verifies the access token, and the verified user id equals the
  live LINE user id of the card's collector player. Anything else answers like every other pay-page failure
  (bare 404, counted by the existing throttle), so the routes do not reveal that a collector exists.

*My call:* for bills paid into the saved account, the collector follows group settings live, so if the host
picked the wrong person, fixing it in settings takes effect at once. Reconfirming the card is not needed, which
matters because reconfirming rotates the card token and breaks the links already in the LINE chat. A night
account's collector stays with that bill, since nobody else's bank app can check it. If the group's saved account
changes after a card was confirmed, that card's account no longer matches, so it falls back to its night
collector (usually none): the new account's owner never gets a bill paid into someone else's account.

### Server routes

New `@Public` routes beside the pay-page routes, same viewer verification, token check and throttle as
`SlipPayController`, plus the collector check. Suggested shape, under `/sessions/:code/slip-pay/manage`:

- `GET` panel: what `SlipReview` needs (paid rows with imageId, waiting, duplicates, collection state) plus the
  bill rows it takes as input (playerId, name, amount, absent) and the account name. `links` is returned empty.
  Player ids and slip senders' LINE names reach the collector here; they never reach the public read-only route.
- `GET` image by id: the private slip image, same headers as the host route.
- `POST` tick / untick, waiting resolve (sender forced to null) / dismiss, duplicate dismiss, close (including the
  "delete images again" retry after a failed purge, which is the same call).

Each write calls the existing `SlipPaymentsService` method under the existing session lock, so every rule the host
is held to (closed collection, amount review, already paid, close readiness) holds for the collector unchanged.
Not exposed: update-name, set-link.

The status read (`GET :code/slip-pay/status`) stays as is. The LIFF page learns whether the viewer is the collector
from a small separate answer (for example the manage panel answering 200 vs 404, or a `role` read), never by adding
a field to the read-only projection.

### Web

- **LIFF status page** (`pages/payment-status`): after LINE login, if the viewer is the bill's collector, render
  `SlipReview` with a one-line header "คุณจัดการการชำระเงินบิลนี้"; otherwise the current read-only list.
- **SlipReview** gets its data through an injectable API (today `SlipHostService`). The LIFF page provides a
  collector implementation that sends the LINE access token header and the card token. New inputs hide the sender
  picker, the linked-accounts list and update-name for the collector.
- **Slip images**: `<img src>` cannot carry the LINE token header. Either fetch the image with the header and show
  it as an object URL, or have the panel return short-lived signed image URLs. Builder's choice; the image must
  never be reachable with the card token alone.
- **Group settings → บัญชีรับเงิน** (`pay-account-panel`): a "เจ้าของบัญชี" picker under the account fields:
  players with a linked LINE account, each with LINE picture and name and the player name; an option for nobody.
  Changing it opens a confirmation, e.g. "ให้ บูม (LINE: Boom) จัดการการชำระเงินใน LINE ได้?".
- **Picker data**: the existing host route `GET /groups/:code/line/accounts` already lists the group's LINE accounts
  with name, picture and linked player; the picker shows only the linked ones, labelled by player name.
- **Payment card → แก้บัญชีคืนนี้** (`payment-panel`): the same picker and confirmation under tonight's fields;
  the chosen collector is sent with Confirm (`ConfirmPaymentCardDto` gains an optional collector player id, checked
  the same way as the group's). When the fields match the group's saved account, the saved collector applies and
  no picker is shown.
- **Host side** shows who manages the bill, e.g. a line on the payment panel and in สถานะการชำระเงิน
  "ผู้รับเงินจัดการใน LINE: บูม", so the host is never surprised that someone else ticked people. That needs the
  resolved collector (player name, LINE name) on the host's payment panel read.

### What the host sees of collector actions

(Owner decision.) A collector's tick is stored with its own source, `source: 'collector'` (a new value in the
existing string column, no migration; `getPaid` today maps every non-`slip` value to `host`, and `PaidRow.source`
/ `SlipPaidRow.source` must widen to include it), and shows its own chip **ผู้รับเงินติ๊ก** on the host's and the collector's
screen. The host's ticks stay **โฮสต์ติ๊ก**. The payment panel line "ผู้รับเงินจัดการใน LINE: บูม" says who *can*
manage; the chip says who *did*, per row, since host and collector can both tick the same bill. A host tick on
a collector-ticked row stays as it is (tick never overwrites a mark, as today). The read-only projection is
unchanged: it still only says paid or not.

## Known limits

- The **ดูสถานะการจ่าย** button is only on cards generated since 2026-10-31, and only when the LINE Login channel is
  configured (both the bot card and the host-share card carry it then). An older card in the chat gives no way in;
  send a new card.
- The bill must still be on its current confirmed token: reconfirming the card rotates the token, so the collector
  needs the newly sent card, exactly like every player.
- Closing collection deletes the slip images (owner-accepted 2026-10-31); after close the collector, like the host,
  sees the slip dialog without a picture.

## Constraints

- Thai-primary with English locale; new strings hand-added to both `messages.xlf` and `messages.en.xlf` (running
  extraction reorders the whole file).
- 44px tap targets; confirmations use the existing `sheet-dialog` pattern; no browser `alert/confirm`.
- Slip and LIFF routes keep the uniform-404 and throttle stance (see "Abuse limits" in `docs/overview.md`).
- `docs/overview.md` must be updated: the slip-images paragraph says only the owning host can fetch images; that
  becomes "the owning host or the bill's collector". Add a short "Collector access" section with the why.
- Server tests: `fileParallelism: false` as always.

## Left to the builder

- Column name and the migration for the group collector (shape decided above).
- Route paths and the exact panel JSON.
- Image delivery mechanism (header fetch vs signed URL).
- How `SlipReview` swaps its API (DI token, abstract class, or input).
- Tests: at minimum, a non-collector LINE user, a stale token, a lapsed plan, an unlinked collector, and a closed
  collection are each refused on every manage route; the read-only projection's key set is unchanged; the collector
  cannot reach set-link or update-name; resolve ignores any sender sent by the collector.
