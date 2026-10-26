# LINE bot session summary card — design

Status: **approved 2026-10-27; built on `feat/line-summary-card`, real-LINE check pending.** Builds on LINE bot phase 1
(`docs/archive/specs/2026-10-26-line-bot-roster-design.md`). Separate from the weekly auto-post
(`docs/superpowers/specs/2026-10-26-line-bot-weekly-post-design.md`), and smaller: no scheduler.
Items marked **(my call)** were decided by the writer, not the owner.

## Intent and why

Every finished night has a public summary page (`/s/:code/summary`, gated only by knowing the
session code). Today its link lives only in a LINE Announce. Most members don't know the page
exists, and those who do lose the link once the old message scrolls away or is removed.

The bot already sits in linked LINE groups. When the host ends the night, the bot posts a
**card** in the group, a LINE Flex Message, not a plain text message, with the night's basic
numbers and a button that opens the summary page.

## Goals

1. Ending a session on a linked group can post a summary card to that LINE group.
2. The card shows the night's totals; the button opens the full summary page.
3. The host decides per night, with a per-group default.
4. A card that did not go out can be sent once later; a card is never posted twice for one
   session.

## Non-goals

- Per-player results, standings or money on the card. The page has those.
- Posting anything else on end (bill, ratings, next week's template).
- An English card. The LINE group is Thai **(my call)**.

## Anti-goals

- Ending a session is slowed, blocked or fails because LINE is slow or down.
- The same card posted twice in the group.
- A card posted for a group that is unlinked, or whose owner's plan has lapsed.
- The bot silently runs up a LINE bill.

## Owner decisions

- **Card content: night totals only.** Group name, date, venue, player count, game count, and
  one button, "ดูสรุป", that opens `/s/:code/summary`.
- **Trigger: a checkbox in the จบก๊วน confirm dialog**, "ส่งสรุปเข้ากลุ่ม LINE". Whether it
  starts ticked is a switch in the group's LINE settings.
- **Resend: once.** The owner's view of the summary page shows "ส่งสรุปเข้ากลุ่ม LINE" until a
  card has gone out for that session; after that the button is gone.

## Behaviour

### When the checkbox shows

Only when all of these hold; otherwise the dialog is unchanged:

- the group is linked to a LINE group and the bot is configured;
- the group owner's plan is Host or higher (same gate as phase 1, read at request time);
- at least one game finished in the session **(my call: an empty night has nothing to
  summarize)**.

It starts ticked or unticked from the group's setting (default ticked **(my call)**).

### Ending with the box ticked

- The session ends exactly as today, first, inside the session lock. The send happens after
  the lock is released, so ending never waits on LINE **(my call)**.
- The server posts one push message to the linked LINE group. Every LINE call keeps phase 1's
  3-second timeout.
- The dialog result tells the host what happened: sent; not sent because the monthly LINE
  quota is used up; or not sent (LINE unreachable or another error). In the not-sent cases
  the resend button stays available on the summary page.

### Exactly once

A send first claims the session (a claim time, set only while nothing was sent and no fresh claim
exists), then pushes. "Sent" is recorded only after LINE accepted the push. A failed push releases the
claim; a claim older than 30 seconds counts as abandoned (the process may have died), so a missed
card is never stuck as "sent". Two taps, or the end dialog racing the resend button, cannot post
twice: the second gets "busy" or "already sent". Every push carries a LINE retry key derived from the
session code, so a timeout whose answer was lost can be retried without a duplicate card (LINE
answers 409 to a repeat, which counts as sent). **(added after the final review)**

### Resend from the summary page

- Shown only to the group owner (the page already tells the owner apart from other viewers),
  only while the same gates as the checkbox hold, and only while no card has been sent for
  the session.
- Pressing it does the same send and reports the same outcomes. Once a card has gone out,
  the button is gone.

### Setting

The LINE section of group settings (shown once linked, as in phase 1) gets a switch:
"ส่งสรุปเข้ากลุ่มเมื่อจบก๊วน" — the default for the end-dialog checkbox. Paused (plan lapsed)
groups don't show it, matching phase 1's paused state.

### The card

- A Flex Message bubble: a header with the group name, rows for date (the stored yyyy-mm-dd date
  written as a Thai date, other date text as written; if there is none, the end date, Asia/Bangkok),
  venue (omitted when the session has none), number of players, number of games, and one URI
  button "ดูสรุป" to the summary page.
- Alt text (shown in notifications and the chat list): `สรุปก๊วน <ชื่อกลุ่ม> <วันที่>`.
- Thai only, built on the server.

## Constraints

- **Push quota.** A push to a group counts once per member against the shared bot's monthly
  quota (see the weekly-post spec for figures). About 86 messages a month for a 20-member
  group playing weekly; the free plan has 300. On the free plan LINE refuses pushes past the
  limit, so the host sees the quota message and nothing is billed. On a paid plan with overage
  pushes would bill instead; the weekly-post spec's quota guard covers that before any
  plan change. The summary card and the weekly post share one quota.
- **The button needs the public site address.** The server does not know it today. A new
  environment value holds it (https only); without it the feature is off, as the bot is off
  without its LINE values **(my call)**.
- Plan gating is read at request time, never stored per feature.
- Thai primary, English second for host-facing strings (dialog, setting, button, outcomes).
- The summary page's public payload must not gain owner-only fields.

## Data (shape, not final)

- Group: the default for the checkbox (boolean, default on).
- Session: when the summary card was sent (nullable time).

## Testing expectations

Pure card building is unit tested. Server specs cover each gate, exactly-once under two
concurrent sends, claim release on failure, the quota outcome, ending still succeeding when the
send fails, the resend refusing after a send, and owner-only access (404 for others, as
elsewhere). A real-LINE check on a test group before wider use, as for phase 1. The card's look
is checked in LINE's Flex Message Simulator.

## Left to the builder

Exact schema and migration, the env value's name, the endpoint shapes for the resend and for
the owner-only send state, the Flex JSON layout and colours, and the copy for outcomes.
