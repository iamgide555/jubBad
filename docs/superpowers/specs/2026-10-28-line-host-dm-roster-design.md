# LINE host link: roster capture by direct message — design

Status: **built on branch `feat/line-host-dm` (2026-10-28), all automated tests passing; the real-LINE check by the owner is still pending, so not deployed.** Checks still to do on a real phone: link by DM from the settings code; forward a roster from a group that has another bot; one-group auto-store; two-group Quick Reply tap; a stranger's DM; unlink. Written from a brainstorming conversation.
Items marked **(my call)** were decided by the writer, not the owner.

## Revision after the first real-phone test (2026-10-28, owner)

The owner linked their LINE with only "ทดสอบ A" and was still asked "which group" because the
link was per account and offered every group they own. Two changes, which **override the
per-account wording below wherever they differ**:

1. **Per-group opt-in.** `Group.lineDmEnabled` (default off). The bot offers only the groups
   switched on, and asks only when two or more are on; one is stored with no question; none gets
   a reply saying where to switch one on. The account link stays per user. The link code
   remembers the group whose page asked for it (`LineUserLinkCode.groupCode`), so linking also
   switches that group on. `latest()` passes for a linked owner only when the group's switch is
   on. Switching off deletes that group's DM-captured rows; unlinking the account switches every
   group off and deletes them. The routes are now group-scoped (`/groups/:code/line/host`, `.../code`,
   PUT enable, DELETE unlink), so the OwnershipGuard exemption described below was **reverted** and
   the guard is unchanged from main.
2. **One LINE page, two cards.** The settings section is titled "LINE" with a "กลุ่ม LINE" card and
   a "แชตส่วนตัวกับบอท" card, each with an on/off tag, instead of the group block with a separate
   "ผูกบัญชี LINE ของฉัน" section under it. The group-settings row for LINE reads "connected" when
   either way is on.

## Intent and why

The roster bot (`2026-10-26-line-bot-roster-design.md`, deployed) lives in the host's LINE
group. LINE allows **one Official Account per group chat** (documented in LINE's group-chat
docs; confirmed live 2026-10-27: a second bot leaves at once). Most real ก๊วน already have
ขุนทอง (the payment bot), so JubBad's bot cannot join them. Those hosts still copy the
roster by hand every week, and the owner runs sessions from an iPad that is not logged into
their personal LINE.

A direct message (1:1) with the bot has no such limit. Goal: the host links their own LINE
account to JubBad once, then forwards or pastes the roster to the bot in a DM from their
phone; start pre-fills it exactly as the group bot does today.

## Goals

1. A host links their LINE account to their JubBad user once (single-use code, same style as
   the group link), from the LINE settings in the web app.
2. A roster-shaped message DM'd to the bot is stored for one of the host's groups and
   pre-fills start, like a captured group message.
3. Host owns one group: the roster goes there with no question. Host owns two or more: the
   bot asks which group with Quick Reply buttons, every time (owner decision).
4. Works for groups that already have another bot, with no change to those groups.
5. The group link stays as the optional extra for groups with no other bot.

## Non-goals

- A summary card or any push for host-only groups. Owner decided 2026-10-28: the card is not
  forwardable (unconfirmed, assumed), a share-button gives the same copy-paste the web app
  already offers. Summary card stays group-link only.
- Any change to what the bot reads in groups.
- An unofficial LINE client or a personal-account webhook (ban risk; owner: zero ban risk
  matters most).
- Roster edits, sign-up or cancel via the bot. Phase 2 weekly post.
- A "remember my last group" default (owner: ask only when more than one group).

## Anti-goals

- Anyone but the account owner can link or send rosters to a host's groups.
- Non-roster DM text is stored.
- A pending roster ends up in the wrong group, or sits forever.
- Start is blocked or slowed because LINE or the webhook is down.
- Quota spend: every reply the bot sends must be a reply message (free), never a push.

## Constraints

- Paid plan (Host+), derived at read time from the chosen group's owner, like the group bot.
  A lapse stops capture; the link stays (same rule as the group link).
- Reuse `isRosterMessage` / `parseLineRosterMessage`; fuzzy match still never auto-links.
- The webhook already verifies the signature and never logs message text or codes.
- Replies use `replyToken` (free). Quick Reply allows at most 13 buttons; postback data is
  capped at 300 characters, so a roster cannot ride in it.

## Design

### Data

- `User.lineUserId String? @unique`, `User.lineLinkedAt DateTime?`.
- Host link code: single-use, 10 minute expiry, SHA-256 hash only, one live code per user
  (a new code voids the old). Either a new `LineUserLinkCode` table or `LineLinkCode` with a
  nullable `userId` and a nullable `groupId` (**my call**: separate table, so the existing
  group-code cascade and tests stay untouched).
- `LinePendingRoster`: `userId` (unique, so one pending per host), `text`, `lineMessageId`,
  `postedAt`, `createdAt`. A newer DM replaces it. Expires after 10 minutes (**my call**).
- Captured DM rosters go into the existing `LineRosterMessage`: `groupId` is the chosen
  JubBad group, `lineMessageId` is the DM message id, `senderName` is null (**my call**: no
  name lookup needed for the host's own message).

### Webhook

`dispatch()` currently returns for anything that is not a group source. Add a branch for
`source.type === 'user'`:

- `/link <code>` in a DM: redeem a host code, bind `source.userId` to the code's user.
  Throttle by LINE user id (reuse `LoginThrottle`). One generic failure line, like the group
  flow. A LINE user already linked to another JubBad user, or a JubBad user already linked,
  refuses the same generic way.
- Text from an unlinked LINE user: one reply telling them to link first. Stores nothing.
- Text from a linked host that is not roster-shaped: reply that it does not look like a
  roster. Stores nothing.
- Roster-shaped text from a linked host:
  - zero groups owned or plan below Host: reply with the reason, store nothing.
  - one group: store as a `LineRosterMessage` for it, reply with a one-line confirmation
    that names the group.
  - two or more: upsert `LinePendingRoster`, reply with Quick Reply buttons (one postback
    button per group, label = group name, data = pending id + group code).
- `postback` event: validate that the pending row exists, is unexpired, belongs to this LINE
  user, and the group is owned by that user and still paid. Then move it to
  `LineRosterMessage`, delete the pending row, reply with a confirmation.
- `follow`: optional greeting that explains linking (**my call**). `unfollow`: delete the
  user's pending roster; keep the link.
- Message edit and unsend in a DM are ignored (**my call**; a DM forward is a deliberate act).

### Gates (existing code that assumes a LINE group)

- `LineRosterService.latest()` returns null unless the group has `lineGroupId`; change to
  "group has `lineGroupId`, or the group's owner has `lineUserId`". Newest row wins across
  both sources.
- `LineLinkService.status()` gains the host link state. The per-group status the web reads
  stays; add a user-level one (or fold both into one response, builder's choice).
- `purge` / per-group limits (20 messages, 30 days) apply unchanged to DM-captured rows.
- `unlink` of the host link deletes `lineUserId` and any pending roster. It does **not**
  delete already-captured rows (they age out), and is always allowed on any plan.
- The summary card, `LineSummaryService.state()` and push stay keyed to `lineGroupId`.

### Client

`LineClient.reply()` sends text only. Add a reply that accepts message objects (Quick
Reply). All calls keep the existing short timeout and never throw.

### Web

The LINE settings section shows two options: link a LINE group (today) or link me. "Link me"
shows the code, the bot's add-friend link, linked/unlinked state, and unlink. The link is
per user, so linking from any group's section links the account (**my call**; there is no
user-level settings page today and adding one is out of scope). Start's pre-fill banner is
unchanged; when the roster came by DM its sender line says it came by direct message
(**my call**, since `senderName` is null).

## Docs to update when built

`docs/overview.md` LINE bot rows (the "no bot" and "no passive listener" rows already carry
2026-10-26 annotations; add the DM path and the one-bot-per-group reason), and flip anything
tracked in this spec's own plan.

## Left to the builder

- Table shape for the host code (see above), response shape of the status endpoint.
- Exact Thai wording of every reply, in the style of `line-webhook.service.ts`.
- Behaviour when the host owns more than 13 groups (Quick Reply limit): the plan must decide
  a fallback, for example the 13 most recently used, or a text reply asking for the group
  name. No such host exists today.

## Verification that needs a real phone

Unit tests cover everything above except LINE itself. Before calling it done, on a real
LINE account: link by DM, forward a roster from a group that has another bot, one-group
auto-store, a two-group Quick Reply tap, a stranger's DM, and unlink.
