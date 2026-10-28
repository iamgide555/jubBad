# LINE host share card (DM + LIFF) — design

Status: **draft 2026-10-28, awaiting owner approval.** Builds on the summary card
(`docs/archive/specs/2026-10-27-line-bot-summary-card-design.md`) and the host DM link
(`docs/archive/specs/2026-10-28-line-host-dm-roster-design.md`). Items marked **(my call)** were
decided by the writer, not the owner.

## Intent and why

At จบรอบ the bot posts a summary card straight into the group, but only when the bot sits in that
group. LINE allows one bot per group, and most real groups already have ขุนทอง, so those hosts
(linked by DM only) get no card at all.

Instead of the bot posting, the **host posts the card themselves**. The bot DMs the host the
finished card with a "ส่งเข้ากลุ่ม" button; the button opens a small LIFF page inside LINE, where
the host picks the group and LINE sends the card as a message from the host's own account. The
group sees the same card as the bot version, from the host.

Why not the simpler ways (all tried or rejected by the owner):
- Plain-text share: same copy-paste as before (rejected 2026-10-27).
- Host forwards the bot's DM card to the group: LINE does not let a bot's Flex card be forwarded;
  the owner tried it 2026-10-28 and it does not work.

## Goals

1. A group with the host's LINE linked by DM, and no bot in the group, gets a card DMed to the host
   at จบรอบ, with a button that sends the card to a group of the host's choosing.
2. The card the group sees looks the same as the bot's card: header, date, venue, players, games,
   "ดูสรุป".
3. The host can also open the same share page from the summary page, so a lost DM or an iPad is not
   a dead end.
4. Group-linked sessions (bot in the group) behave exactly as today.

## Non-goals

- Automatic posting into a group the bot is not in. Impossible; the host always taps.
- The weekly auto-post. Still needs the bot in the group.
- Sharing anything but the summary card (roster, bill, ratings).
- Offering the share page to groups that already get the bot's group card **(my call: the bot
  already posts there)**.
- English text on the card. The LINE group is Thai, as before.

## Anti-goals

- Ending a session slowed, blocked or failed because LINE is slow or down.
- The same DM card pushed twice for one session.
- The share page leaking anything the public summary page does not already show.
- Requiring a JubBad login on the host's phone to share the card.
- A DM or share for a lapsed plan or an unlinked host.

## Owner decisions (2026-10-28)

- DM the host a **card** (not plain text), with a "ส่งเข้ากลุ่ม" button under "ดูสรุป".
- The button opens a LIFF page; sending uses LIFF's share picker so the card goes out as the host.
- **One push per night is acceptable** for the DM. This reverses the earlier "no push to the host
  DM" decision in the host-DM spec, for this one card only.
- Group-linked behavior stays as it is.

## Behaviour

### Which target a session has

For an ended session with at least one finished game and the owner on Host plan or higher:

| Group state | Target | At จบรอบ |
|---|---|---|
| linked to a LINE group (`lineGroupId`) | `group` | bot posts into the group, unchanged |
| not group-linked, `lineDmEnabled` on, owner has `lineUserId` | `host` | bot DMs the owner the share card |
| neither | none | no checkbox, no DM |

A group that is both linked and DM-enabled is `group` **(my call: one card, one place)**. The
state endpoint reports the target so the web can word the checkbox.

### Ending with the box ticked (target `host`)

- Same checkbox in the จบรอบ dialog, same group default switch (`lineSummaryDefault`, default
  ticked). Wording for `host`: "ส่งการ์ดสรุปให้ฉันทาง LINE" (en: "DM me the summary card").
- The session ends first, inside the lock; the push happens after it is released, exactly as for
  the group card. 3-second LINE timeout. Ending never waits on LINE beyond that.
- The push goes to the owner's `lineUserId`. Outcomes are the existing set: sent, quota, failed,
  already-sent, busy, unavailable. A host who blocked or unfriended the bot reads as `failed`
  **(my call)**; the copy for `failed` in `host` mode hints at "เพิ่มบอทเป็นเพื่อนอีกครั้ง".

### Exactly once

Reuse the existing claim, `lineSummarySentAt`, retry key and 30-second stale-claim rules unchanged
**(my call: a session has one target, so one "delivered" marker is enough; no migration)**. The
retry key is derived from the session code, so it cannot collide with the group push for the same
session because a session has only one target at a time.

If the group's target changes after a send (linked or unlinked later), the old marker still reads
"sent" and no second card goes out.

### The DM card

The existing `summaryCard` plus one extra footer button, "ส่งเข้ากลุ่ม", style secondary, a URI
action to `https://liff.line.me/<LINE_LIFF_ID>/<sessionCode>`. "ดูสรุป" stays first.
Alt text: `สรุปก๊วน <ชื่อกลุ่ม> <วันที่>` (same as today) **(my call)**.

`summaryCard` takes an optional share URL: with it, two buttons; without it, the card is
byte-identical to today's, so the group version and the shared version are unchanged.

### The LIFF share page

- Web route `/line-share/:sessionCode`, public (no JubBad login) and outside the admin guard. The
  LIFF app's endpoint URL is `<PUBLIC_APP_URL>/line-share`; LIFF appends the session code.
- On load: `liff.init`; if not logged in, `liff.login()` (this is the iPad / external-browser
  path: LINE Login page, email+password or phone QR, then back). Inside the LINE app there is no
  login step.
- Fetches the card, shows a small preview and one button "เลือกกลุ่มแล้วส่ง". The tap calls
  `liff.shareTargetPicker([card])`. It must be a direct tap (browsers block the picker popup
  otherwise).
- Result: sent → "ส่งแล้ว" with a "ส่งที่อื่นอีก" option (sharing again is free, and no
  exactly-once rule applies to it); picker closed without sending → stay on the page, no error;
  `shareTargetPicker` unavailable → say so and tell the host to open it in the LINE app
  **(my call on the copy)**.
- Thai primary, English second, as everywhere.

### The share card endpoint

`GET /api/sessions/:code/line-share-card`, **public**, returns the card without the share button
plus the LIFF id **(my call: the web then needs no build-time config)**. 404 when the session
does not exist, is not ended, has no finished game, or the feature is off. It exposes only what the
public summary page already shows (group name, date, venue, players, games); a spec asserts no
owner-only field is added.

### The summary page

For the owner, when the target is `host`: a button "ส่งการ์ดเข้ากลุ่ม LINE" that links straight to
the LIFF URL (free and repeatable), shown even after the DM went out. The existing resend button
(DM again) is shown only until the DM was delivered, as for the group card. For `group` target,
nothing changes.

### Setting

The LINE settings switch "ส่งสรุปเข้ากลุ่มเมื่อจบก๊วน" (`lineSummaryDefault`) shows for `host`
groups too (the page gains it on the chat-with-bot card), with host wording. Paused (plan lapsed)
groups do not show it.

## Constraints

- **Push quota.** One DM push per host per night, one message each (a 1-to-1 push counts once,
  not per group member). Shares the 300/month free quota with the group card and the weekly post.
- **New env value** `LINE_LIFF_ID` (name is my call). Absent: the `host` target is off, nothing
  changes for group-linked groups, as the bot is off without its LINE values.
- **LIFF app setup, done by the owner** (the builder writes the steps into the runbook):
  1. A LINE Login channel in the same provider as the bot channel.
  2. A LIFF app on it, endpoint URL `https://jubbad.wongnok.dev/line-share`, size Full, Share
     Target Picker enabled if the console asks for it (to verify during setup).
  3. The LINE Login channel **must be published**; while it is "Developing" only the channel's
     own admins and testers can open the LIFF app, so every other host would be refused
     **(unverified in this session; confirm in the console)**.
  4. `LINE_LIFF_ID` added to `server/.env` on the home server.
- Plan gating at request time, never stored per feature (as before).
- The public card endpoint must not accept or return anything keyed on the owner.
- The LIFF SDK loads only on `/line-share`, not on the host dashboard or the venue display
  **(my call)**.

## Data

No schema change **(my call)**. `lineSummarySentAt` / claim reused; the target is derived from
`lineGroupId`, `lineDmEnabled` and `User.lineUserId` at request time. `docs/overview.md`'s LINE
section needs the new target rule.

## Testing expectations

- Pure: `summaryCard` with and without the share URL (button count, URI shape, size limits,
  group-version output unchanged).
- Server: target selection for each group state; DM goes to `lineUserId` not the group; every gate
  (plan lapsed, no `lineUserId`, DM switch off, no finished game, env missing); exactly-once under
  two concurrent sends; claim release on failure; quota and failed outcomes; ending still
  succeeds when the push fails; the public endpoint's 404s and payload (no owner field); a
  group-linked session still posts to the group and sends no DM.
- Web: the share page with a stubbed `liff` (not logged in → login; picker success, cancel,
  unavailable); the dialog checkbox wording per target; the summary-page link only for `host`.
- Real-LINE check by the owner before deploy: a real DM card; tap on the phone (in-app, no login);
  tap on the iPad (external browser login); send to a group with another bot; confirm the group
  card looks right and "ดูสรุป" opens the summary; confirm a non-admin host can open the LIFF app
  (the published-channel check).
- The Flex layout is checked in LINE's Flex Message Simulator.

## Left to the builder

The env value's name, the card's second-button styling and spacing, endpoint shapes beyond the two
named, the LIFF SDK delivery (npm package vs script tag), how Angular's router and LIFF's
`liff.state` redirect share the same URL, and the copy for outcomes and errors.
