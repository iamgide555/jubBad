# LINE bot weekly auto-post (phase 2) — design

Status: **not built.** Phase 1 (roster capture, linking, start pre-fill) is built and
deployed: see `docs/archive/specs/2026-10-26-line-bot-roster-design.md`. The LINE push-quota
check is done (below); the owner decided to build this when it is wanted, not speculatively.
Items marked **(my call)** were decided by the writer, not the owner.

## Intent and why

Today one person has to post the first (empty) roster template in the LINE group every
week. The bot already sits in the group and holds the roster messages, so it can post the
template itself. Only the date and time change week to week; the rest of the text is the
same.

## Builds on phase 1

Read the phase 1 spec first. This feature relies on:

- the linked LINE group (`Group.lineGroupId`) and the bot's presence in it;
- stored roster messages (`LineRosterMessage`), which the skip rule below reads;
- the plan gate (Host tier and up); posting must stop when the plan lapses or the group is
  unlinked;
- `Session.endedAt` as the end of the last game night.

Phase 1 stores only messages it receives. For the bot's own template post, do not assume
LINE's webhook returns the bot's own messages (the docs don't say). The bot stores its own
post itself when it sends it, using the message ID from the push response, flagged
bot-posted. The unique message ID makes it harmless if the webhook also delivers it.

## Behaviour

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
- **Push quota (checked 2026-10-26):** LINE push messages count against the Official
  Account plan's monthly quota; replies are free. A group push counts once per member
  (LINE's own pricing docs: a push to a 5-person chat counts as 5). Thailand plans, per
  third-party sources and **not confirmed against LINE's own pricing page**, ex-VAT:
  Free ฿0 / 300 messages, Basic ฿1,280 / 15,000 (extra ฿0.10), Pro ฿1,780 / 35,000 (extra
  ฿0.06). One source hints at a pricing change in November 2026; unconfirmed. Re-check the
  official page before relying on these.
  - **Cost per group:** one weekly post is about 4.3 posts a month, so about 86 messages
    for a 20-member group (20 is an assumption, scales linearly with members). The free
    300 covers about 3 such groups. Basic covers about 170 groups, roughly ฿7.5 per group
    per month.
  - **Owner decision (2026-10-26):** the free 300 is enough for now, since only the owner
    knows the feature exists. Build phase 2 when it is wanted, not speculatively. Revisit
    the plan and the paid-tier pricing before hosts beyond the owner get it.
  - **Build with a quota guard:** the API has endpoints for this month's limit and usage
    (`quota`, `quota/consumption`). Before a scheduled post, skip it and tell the host in
    settings if it would exceed the remaining quota, rather than running up the owner's
    bill silently.
  - **Free fallback considered:** replies are free, so a `/ใหม่` command that makes the bot
    reply with the template costs no quota, but someone must type it each week, so it only
    half-solves the chore.
- **Open question for phase 2:** does any ก๊วน run two nights a week from one LINE group?
  The design assumes one play day per LINE group; a second night would break "newest
  roster" and the skip rule.

## Data (shape, not final)

- Group gains the auto-post settings: on/off, template text, play day, play time, post
  moment.
- A bot-posted flag on `LineRosterMessage` (phase 1 stores human messages only).
- A record of the date last posted, so the same date is never posted twice.

## Left to the builder

Exact schema and migration, the scheduler mechanics, how the quota guard reads LINE's
`quota` and `quota/consumption`, copy for the settings and the post, and the Thai/English
strings.
