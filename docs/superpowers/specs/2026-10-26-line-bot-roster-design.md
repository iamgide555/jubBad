# LINE bot roster capture and weekly auto-post — design

Status: **phase 1 built on branch `feat/line-bot-roster` (2026-10-26), not merged or deployed; phase 2 (weekly auto-post) pending the push-quota check.** Written from a brainstorming
conversation. Items marked **(my call)** were decided by the writer, not the owner.

## Intent and why

A ก๊วน signs up in a LINE group: someone posts the roster template, and each person who
wants to play copies the newest message, adds their name and sends it. The newest roster
message is therefore the most complete list.

Today the host must open that LINE group, copy the latest roster and paste it into JubBad's
roster-entry screen. The owner runs sessions from an iPad where their personal LINE is not
logged in, so every game night means logging in and out of LINE just to copy one message.
A second chore: one person has to post the first (empty) template every week.

Goal: a LINE bot sits in the group, remembers the newest roster message, and "start" pastes
it automatically. Phase 2: the bot also posts the weekly template itself.

## Goals

1. A bot added to a LINE group captures roster messages as they are posted.
2. Tapping start on a linked JubBad group pre-fills the roster box with the newest
   captured roster, exactly as if the host had pasted it.
3. Linking is explicit, per group, 1:1 (one JubBad group ↔ one LINE group), and does not
   expose any group list to anyone.
4. Every unlinked or failed case falls back to today's manual paste with no regression.
5. Phase 2: the bot posts the weekly template on a schedule so nobody has to.

## Non-goals

- Signing up, cancelling or editing the roster from inside JubBad or via bot commands.
  People keep using the copy-and-add-name habit in LINE.
- Reading history from before the bot joined (LINE's API does not offer it).
- Storing any chat that is not a roster message.
- Fixing the "two people copy the same old message at once, one name is lost" race. It
  already exists and the owner accepts it. Fewer names than the previous roster is a
  valid un-register, so the bot does **not** warn about it.
- Per-player LINE accounts or login with LINE.

## Anti-goals (a failure even if it technically works)

- The bot stores or exposes ordinary chat.
- A group gets linked to the wrong JubBad group, or a stranger can link a group they
  don't own.
- Start is blocked or slowed because the bot, LINE or the webhook is down.
- A stale roster is pasted silently (last week's list looks identical to this week's).
- The bot spams the group.

## Constraints

- Fuzzy match still never auto-links names (see `docs/overview.md`); captured text goes
  through the same parser and the same host review as a manual paste.
- Entirely a **paid-plan** feature (Host tier and up, `docs/2026-10-06-pricing-tiers.md`).
  Gating is derived at read time from `planRenewsAt`, never stored per feature. Plan
  gating is already on `main` (`User.plan`, `server/src/plans/`, `PlansService`). The
  plan-gating critique recorded that paid effects must also **stop** when the plan lapses.
- One shared JubBad bot (one LINE Official Account / Messaging API channel) serves every
  host's groups. The owner does the one-time LINE-side setup.
- The server needs a public HTTPS webhook (`jubbad.wongnok.dev` already exists), must
  verify LINE's request signature, and must be idempotent against LINE retries.
- Server code is NestJS + Prisma + SQLite, single container, in-process session lock
  (`server/src/sessions/session-lock.ts`). Array fields are JSON strings (SQLite).
- Thai-primary UI with English second locale; new settings strings need both.
- Personal data: sender LINE user ID and display name are stored. Keep to roster messages,
  and purge on a schedule.

## Behaviour

### 1. Linking

- Group settings (host/owner of the group, `OwnershipGuard` as for other settings) →
  **Link LINE group** generates a one-time code. **(my call)** 10-minute expiry, single use,
  short and unambiguous, stored hashed or at least never logged.
- The host invites the bot to the LINE group, then types `/link <code>` in that group.
- On a valid code the server records the LINE group ID against the JubBad group and the bot
  replies with a short confirmation that says what it keeps: roster messages only, with
  who posted them and when, and no other chat (the notice for members' personal data is
  in the chat itself). Settings now show the linked LINE group's name and an
  **Unlink** action.
- Invalid, expired or refused code **(owner decision)**: the bot replies with one generic Thai
  line, `รหัสไม่ถูกต้องหรือหมดอายุ ตรวจรหัสได้ที่ JubBad > ตั้งค่ากลุ่ม > กลุ่ม LINE`. It does
  not say which of wrong, expired or already-linked it was. Replies are free on LINE.
  Attempts are rate-limited per LINE group and sender, so one member's bad guesses cannot
  block the host; a sender who is already throttled gets no reply.
- 1:1 is enforced both ways: a JubBad group has at most one LINE group, and a LINE group
  maps to at most one JubBad group.
- Unlinking stops capture, deletes the group's stored roster messages and asks the bot to
  leave the LINE group so it stops receiving the chat; re-linking means inviting it again
  **(my call)**. Deleting a JubBad group does the same.
- Bot removed from the LINE group (leave event): treat as unlinked, tell the host in
  settings next time they open it **(my call)**.

### 2. Capture

- The bot receives every message in a linked group via webhook, but the server keeps only
  those the roster parser (`engines/parser.ts`, `parseLineRosterMessage`) recognizes as a
  roster. Everything else is dropped without being stored. **(my call)** "Recognized" means at
  least 3 numbered lines **and** a header with a date, venue or time slot, so a numbered
  rules post or announcement never becomes "the newest roster". A group whose template
  has no header gets no capture and uses manual paste; the real-LINE check will show if
  that happens.
- Stored per message: text, sender LINE user ID, sender display name, LINE message
  timestamp, LINE message ID (for idempotency), the JubBad group it belongs to.
- **History kept per group: last ~20 or 30 days, whichever is fewer rows, then purged**
  **(my call, owner only said "store who posted so we can track")**.
- Phase 2 template posts: do not assume LINE's webhook returns the bot's own messages
  (the docs don't say). The bot stores its own post itself when it sends it, using the
  message ID from the push response, flagged as bot-posted. The unique message ID makes
  it harmless if the webhook also delivers it.
- Messages arriving while the plan is lapsed, or while the group is unlinked, are dropped.

### 3. Start

- On `/g/:groupCode/start` for a linked group, the server returns the newest captured
  roster message. The screen pre-fills the roster box with it, so the flow from there is
  identical to a manual paste (parse, fuzzy suggestions the host confirms, venue search).
- The screen shows who posted it and when, small, e.g. "latest list by Nok, 18:42".
  **(my call)** shown in the group's local time.
- **Staleness:** if the newest roster is older than the group's last finished session
  (`Session.endedAt`), or older than a week **(my call)** when there is no session, show a
  visible warning so a past week's list is never pasted silently. The host can still use
  it or paste manually.
- No roster found, group unlinked, plan lapsed, or the lookup fails: show today's empty
  manual paste. Never block start.

### 4. Phase 2 — weekly auto-post

Configured in group settings, shown only once the group is linked.

- **Template text** (free text, host-authored) with `{date}` and `{time}` placeholders.
  Everything else is the same each week.
- **Play day** (weekday) and **play time**. The date is the next play day (the last play
  date + 7 days). The host edits the time in settings whenever the slot changes; the bot
  uses whatever is saved when it posts.
- **Post moment:** **(my call)** a post-time setting, default the morning after the
  previous game night, editable, so sign-ups are open all week.
- **On/off switch** for auto-post.
- **Skip rule (owner decided):** before posting, check the stored roster messages. If any
  human roster message arrived **after the last game night ended**, skip: that list is
  already next week's. The cutoff is the group's last `Session.endedAt`. **(my call)** If
  no session was run that week, fall back to the play time plus a few hours. Sign-ups on
  the play day itself before the game belong to tonight and must not count, so the cutoff
  is never midnight.
- Never post a second template for the same date. Stop posting when the plan lapses or
  the group is unlinked.
- **Open item before building phase 2:** LINE push messages count against the Official
  Account plan's monthly quota, replies do not. Verify how a scheduled push to a group is
  counted (LINE's docs say once per member for a group push; replies are free) and what
  the shared bot's plan allows, including the Thailand free quota, before promising this
  to many hosts; the bill lands on the owner.
- **Open question for phase 2:** does any ก๊วน run two nights a week from one LINE group?
  The design assumes one play day per LINE group; a second night would break "newest
  roster" and the skip rule.

## Data (shape, not final)

- Group gains: linked LINE group ID (unique), linked-at, auto-post settings (phase 2).
- A table of captured roster messages: group, text, sender ID and name, LINE timestamp,
  LINE message ID (unique), bot-posted flag.
- A table of pending link codes: group, code (or hash), expiry, used-at.
- Builder decides exact schema, migration, indexes and the purge job.

## Failure and edge cases to handle

- LINE webhook retries and redelivery (idempotent on message ID).
- Webhook signature invalid → reject. Server down → LINE retries; start still works.
- Two different hosts try to link the same LINE group → refuse the second.
- Messages in a LINE group the bot is in but that is not linked → ignore entirely.
- LINE display name unavailable → store ID only, show "unknown".
- Unsent LINE messages: handle the unsend event by removing the stored message **(my call)**.
- Edited LINE messages: LINE sends an event when a user edits a message (same message ID).
  Replace the stored text and keep its time; if the edit is no longer a roster, delete the
  row **(my call)**. The docs summary names the event `messageEdited`; confirm on a real
  event.
- Members on LINE for PC have no `source.userId`: their messages are stored with a null
  sender, so "who posted this" tracing does not work for them.
- Only one Official Account can be in a LINE group. A ก๊วน that already has another bot
  must remove it before the JubBad bot can join.
- Cloudflare in front of the tunnel could block LINE's webhook calls; setup uses LINE's
  Verify button and, if needed, a Cloudflare skip rule for the webhook path.
- The bot's LINE API calls (sender names, group name) have a short timeout and a name
  cache, so a batch of events cannot hold the webhook open.
- Clock: use LINE's event timestamp, not receive time, for ordering.

## Testing expectations

Per repo convention: server specs run with `fileParallelism: false`; engines stay
dependency-free. Pure logic (is-this-a-roster, staleness, skip rule, date +7) should be
easy to unit test; webhook handling needs signature and idempotency specs. A real-LINE
check on the owner's own group is expected before wider use, per the real-session rule.

## Left to the builder

Exact roster-recognition threshold, schema details, code format, purge mechanics, webhook
module layout, how settings UI is organized, copy for the confirmation reply, and the
Thai/English strings.
