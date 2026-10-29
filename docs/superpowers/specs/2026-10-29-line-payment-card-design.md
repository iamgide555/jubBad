# LINE payment card (ใบเก็บเงิน) — design

Status: **draft 2026-10-29; owner answered the open questions the same day, awaiting final
approval to plan.** Builds on the bill
(`docs/overview.md` "Bill (C3)"), the summary card and the host share card
(`docs/superpowers/specs/2026-10-28-line-host-share-card-design.md`, live). Items marked
**(my call)** were decided by the writer, not the owner.

## Intent and why

The bill already works out what each player owes, but it leaves the app as copied text. Money asks
are the part of the night hosts repeat by hand: type the amounts into LINE, then type or paste a
bank account. Two real cases make it worse:

- Someone other than the host paid the court or shuttles, so the group must pay **that person**,
  not the host. Today the text cannot say so.
- The text carries no account at all; players scroll back for it.

The new **payment card** is a second LINE card, separate from the summary card: one line per
person with the amount, the account to pay into, and a button that copies the account number. The
host confirms the amounts and the account first, then sends it.

Why a separate card, not an extension of the summary card (owner agreed 2026-10-29):
- The summary is a recap that never changes after it goes out and keeps its exactly-once send. A
  payment request changes when the bill is corrected (ไม่มา, early checkout, a fixed shuttle count),
  so it must be resendable.
- Hosts often finish the bill after ending the session; the two cards do not share a moment.
- The summary card mirrors the **public** summary page. Amounts and a bank account must not.
- Group-linked and host-share summary behaviour stays byte-identical.

## Goals

1. After a bill is ready, the host can confirm amounts and an account, then send a payment card to
   the LINE group: in place right after จบรอบ (a sheet on the same page), from the summary-page
   banner, or from the bill screen at any time.
2. The account is configured once per group (group settings) and can be overridden per night, so a
   different collector is a few taps, not a new setup.
3. The card has a button that copies the account number (see "Copy button" for the fallback).
4. Both LINE paths work: bot in the group (bot posts it) and host-share (host sends it from their
   own account through the share picker).
5. Nothing about the summary card, the bill maths, or groups without LINE changes.

## Non-goals

- Collecting money, QR, tracking who paid, slip checks. All stay with ขุนทอง (decision table in
  `docs/overview.md`). The card shows amounts and an account; nothing more.
- Storing bank details per player, or mapping LINE accounts to players. The collector types the
  account (owner decision 2026-10-29), tonight or once as the group default.
- Netting the collector's own share to zero **(my call)**. The existing per-player override and
  ไม่คิดเงิน already do that, and the owner did not ask for automation.
- A DM of the payment card to the host. The host is at the bill screen when they send it, so no
  extra push is spent **(my call)**.
- English text on the card. Money going into a group chat is Thai, as the copied bill text is.
- Showing the margin (collected vs actual cost). Host-only, as today.

## Anti-goals

- Amounts or an account number readable by anyone who only knows a session code.
- Ending a session slowed, blocked or failed by this feature.
- A card sent with amounts the host did not see and confirm.
- A second summary card, or the summary card changed in any way.
- A group with no LINE link, or a lapsed plan, getting any card.

## Behaviour

### Account (group settings)

- New "บัญชีรับเงิน" panel in group settings, owner-only, reachable **without** a LINE link: bank
  name, account number, account name. All optional; clearing all three removes the default.
- **Bank name is a searchable dropdown** over a default list of banks supplied by the owner (owner
  decision 2026-10-29). Search matches Thai and short English names (typing "กส" or "kbank" both
  find กสิกรไทย). The list is a constant in the web app, used only to fill the field. The host can
  also type a bank that is not in the list (owner decision): the field accepts free text
  (≤ 40 chars), so a wallet, a credit union or any other bank is never blocked. What is stored
  and shown on the card is the display name as plain text, never a code, so a later change to the
  list cannot change a saved account. The same field appears in the nightly override in the
  payment panel.
- The default list, in this order (Thai name, search alias):
  กรุงไทย (KTB), กรุงเทพ (BBL), กสิกร (KBANK), ธนชาต (TTB), ไทยพาณิชย์ (SCB),
  ซีไอเอ็มบี (CIMBT), ยูโอบี (UOB), กรุงศรี (BAY), ออมสิน (GSB), แลนด์แอนด์เฮ้าส์ (LHBANK),
  ทิสโก้ (TISCO), PromptPay. Names are the owner's, verbatim, except ซีไอเอ็มบี: the owner wrote
  "ซีไอเอ็บบี", which looks like a typo for CIMB **(my call, owner to confirm)**.
- Validation **(my call)**: bank ≤ 40 chars, name ≤ 80, number 6-20 characters of digits, spaces
  and dashes (PromptPay phone 10 digits, national id 13 fit). The copied text is the number with
  spaces and dashes removed.
- Stored as one nullable JSON column `Group.payAccount`. Never in any public read: not the group
  dashboard feed, share page, summary page, display feed or export of other groups.

### Bill screen: the send panel

- A "ใบเก็บเงิน" panel on the existing bill screen (`/s/:code/bill`, owner-only). It shows only
  when the group's LINE target is `group` or `host` (the summary card's rule: LINE linked, plan
  host or higher, not paused). Otherwise it is absent, no hint.
- The panel is the confirm step. It shows exactly what the card will say: the per-person amounts
  (people still due), the total, and the account fields prefilled from the group default. The host
  can overwrite the three fields for tonight; tonight's value is stored on the session
  (`Session.paymentCard` JSON: account override, `confirmedAt`, `lastSentAt`, share token).
- **Send is disabled while an amount is undefined**, with the existing reason shown. The rule is the
  same as the existing copy-text button's gating in `session-bill`; the builder reads that code and
  reuses it, it does not invent a second list. Warnings that only inform the host (excess credit,
  uncovered cost, unreturned surcharge) show but do not block.
- Settled early-checkout people are not rows; the card says "จ่ายแล้ว N คน" in its footer **(my
  call)**.
- No account entered anywhere: the panel still previews amounts but Send stays disabled with a
  pointer to group settings.
- Bot target (`group`): "ส่งเข้ากลุ่ม" posts the card into the linked LINE group via the bot. The
  panel then shows "ส่งแล้ว <time>" and the button reads "ส่งอีกครั้ง"; a resend asks to confirm.
- Host target (`host`): "ส่งเข้ากลุ่ม" is a link to `https://liff.line.me/<LINE_LIFF_ID>/pay/<code>/<token>`
  (opens in the LINE app; outside it LINE asks for its own login first, as the summary share does).
  The server cannot see a share-picker send, so no "sent" state is shown for this target.
- Every confirm (re)generates the share token, so an older link stops working. Editing the bill
  after confirming shows "ยอดเปลี่ยน, ยืนยันใหม่" and the link/post is disabled until the host
  confirms again.

### At จบรอบ

Owner decision 2026-10-29: the confirm step opens in place right after ending (option B), with a
banner on the summary page as the fallback (option A). The first draft navigated to the bill
screen from the end dialog; rejected because a tick that only navigates reads like the summary
tick that sends, and the jump breaks the end-confirm-send flow.

- Next to the summary tick, a second tick, "ส่งใบเก็บเงินด้วย", shown when the same target rule
  holds. It is checked by default when the group has a default account **(my call)**. Its label
  promises a send step, not a send: nothing goes out until the host presses Send in the panel.
- After the end succeeds, the app lands on the session summary page, as it does today (the
  dashboard is closed once a session ends), and opens the **same payment panel** (one shared
  component, also embedded in the bill screen) as a bottom sheet there. The host does not go to a
  second screen. The sheet is the confirm step above: amounts, account, Send.
- Not ready (court fee, shuttle count or price missing, undefined amounts): the sheet says
  exactly which input is missing and offers a button to the bill settings. It never offers Send
  for an undefined amount, and the sheet never blocks or delays the end itself.
- Closing the sheet sends nothing and loses nothing: an unconfirmed account edit is kept in the
  web app's memory (a root service keyed by session code, no browser storage) for as long as the
  app stays open, and is lost on a reload; a confirmed override is stored on the session **(my
  call: the server saves an override only at confirm, and a save-without-confirm route is not
  worth it for a rare per-night edit)**.
- **Banner fallback.** On the owner's session summary page, for an ended session with the
  `group` or `host` target and a payment card not yet confirmed, confirmed and edited since, or (bot
  target only, where a send is observable) confirmed but not yet posted, a
  banner "ส่งใบเก็บเงินเข้ากลุ่ม" opens the same panel (or links to the bill screen, builder's
  call). This covers "I'll do it later", a closed sheet, and a host who did not tick.
- Ending the session is unaffected if the tick is on and the bill is not ready.

### The card

One Flex bubble (a carousel is not allowed in the share picker), Thai only:
- Header: "ยอดค่าเล่น", group name, date, venue.
- One row per person still due: name, amount in baht (whole baht at the bill's rounding step).
- Total line. Footer: "จ่ายแล้ว N คน" when any.
- Account block: "โอนให้ <account name>", bank, number.
- Button "คัดลอกเลขบัญชี".
- No "ดูสรุป", no link into the app, no margin, no host-only data.

Size: the builder confirms a 40-row bubble stays under LINE's Flex limits; no truncation is
expected for real groups.

### Copy button — spike first

LINE has a `clipboard` action (`clipboardText`, since Feb 2024). It is **not verified** inside a card
sent through `liff.shareTargetPicker`, which restricts some message features, nor on older LINE
versions. Task 0 of the plan is a throwaway test card, sent once by the bot to the owner's DM and
once through the share picker from the owner's phone, to answer: does the button copy, and does
the card render. Decision table, fixed now so the spike does not reopen the design:
- Works both ways: button as specified.
- Works from the bot only: the bot path keeps the button; the host-share path adds a second
  **text** message with the number (the picker accepts several messages, and a text message can be
  long-pressed to copy).
- Works neither way: both paths print the number large in the card and send the text message too.

## Public surface and privacy

- Owner-only (no `@Public`): payment panel read (`GET /sessions/:code/payment-card`), confirm
  (`POST …/payment-card/confirm`), bot send (`POST …/payment-card/send`, body carries a client
  `sendId`; the LINE retry key derives from `code + sendId`, so a network retry is a no-op but a
  deliberate resend goes out), and the group default account in group settings.
- One new **public** read for the LIFF page: `GET /api/sessions/:code/payment-share-card?token=…`.
  The token is an unguessable 128-bit random string held in `Session.paymentCard`, checked in
  constant time. **Every** failure (no session, no confirm, wrong or stale token, target not
  `host`) answers the same 404. It returns the card, the LIFF id and nothing else. It is the same
  bearer-link pattern as the group dashboard's `/d/:token`.
- The bill's "money never reaches the display or a co-host" rule holds: no amount or account is
  added to any existing public read; a spec asserts it.
- `auth.boundary.spec.ts` gets the same exact-path skip the summary share endpoint has.

## Data

One migration, two nullable columns, no backfill: `Group.payAccount`, `Session.paymentCard`.
Both JSON strings parsed in one server helper that tolerates anything malformed as "absent", the
way `billConfig` parsing does, so a bad stored value can never break a bill read or an end-session.

## Edge cases the builder must cover

- Group target changes after a confirm (bot removed, host unlinks): the panel re-reads the target;
  a stored token for a non-`host` target no longer serves.
- Plan lapses between confirm and send: send is refused, panel hidden; no card.
- Two tabs confirm at once: last confirm wins; the earlier token is dead.
- Account cleared in settings after tonight's override exists: the override still stands for
  tonight.
- Name with characters Flex or LINE reject, very long names: truncated in the card, never an error.
- A removed (ไม่คิดเงิน) player is not a row; an absent (ไม่มา) player is, with their court share.
- Zero people due: panel says there is nothing to collect, no card.

## Unverified until a real LINE group is used

- Clipboard action inside a picker-sent card (the spike above).
- Whether a group push counts as one message against the monthly quota or as one per member. The
  summary card already pushes to groups; this adds one push per session for bot-linked groups.

## Docs and housekeeping

- `docs/overview.md`: new bullet under the LINE section and a line in the Bill section, with this
  spec's decisions; the decision-table row on payment tracking gets a one-line note that the card
  shows an account but still tracks nothing.
- `docs/line-liff-setup.md`: add the payment-card checks to the real-LINE checklist.
- i18n: th source plus English for the group settings panel, the bill panel and the end-session
  tick, hand-spliced into both xlf files as before.

## Owner answers (2026-10-29)

- The collector's own share is not netted automatically (use ไม่คิดเงิน or an override): OK.
- Everyone in the group sees everyone's amount on the card, as in the copied text today: OK.
- At จบรอบ: confirm in place (bottom sheet), summary-page banner as the fallback: decided above.
