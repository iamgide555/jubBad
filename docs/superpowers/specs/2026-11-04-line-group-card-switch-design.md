# LINE group "roster only" switch — design

**Date:** 2026-11-04 · **Status:** implemented and tested; owner-run real-LINE check pending

## Why

The JubBad bot runs on LINE's free plan. A bot push into a LINE group counts once **per member**
against the monthly quota, so one summary card plus one payment card into a ~40-member group costs
~80 messages a night. A push to the host's own DM costs 1, and when the host forwards it with the
"ส่งเข้ากลุ่ม" button (LIFF share picker) it goes out from the host's own account and costs the bot
nothing.

Today a group linked to **both** a LINE group and the host DM can't use the cheap route:
`LineSummaryService.resolve()` (`server/src/line/line-summary.service.ts`) always picks `group`
when `lineGroupId` is set ("group wins when both apply", `docs/overview.md`, host share card
section). The owner wants a per-group way to keep the bot quiet in the LINE group.

This reverses "group wins when both apply" — owner decision 2026-11-04.

## What changes for the host

A new checkbox on the **LINE group card** (group settings → LINE), shown when the group is linked
to a LINE group and the plan is paid:

> **ใช้บอทอ่านรายชื่ออย่างเดียว**
> บอทจะไม่ส่งสรุปผลการแข่งหรือการจ่ายเงินเข้ากลุ่ม ถ้าเปิดแชตส่วนตัวไว้ บอทจะส่งให้คุณแทน แล้วกดส่งเข้ากลุ่มเองได้

- **Off (default):** exactly today's behavior — bot pushes the summary and payment cards into the
  group.
- **On:** the bot only reads rosters in that LINE group and never pushes anything into it.
  - If the JubBad group is also linked to the host's LINE account (`lineDmEnabled` on, owner's
    LINE account linked, `LINE_LIFF_ID` set), both cards go to the host's DM with the
    "ส่งเข้ากลุ่ม" button — the existing `host` target, unchanged.
  - If the DM route is **not** set up: **no card at all** (owner decision). No end-of-session
    checkbox, no payment send button — same as a group with no LINE link today.
- One checkbox covers both cards, and any future bot post into the group must respect it too.

What the bot still does in a roster-only group: reads rosters (silent) and replies to `/link`
(needed to link at all; replies use the reply API, which costs no quota). Nothing else.

## How it works

### Data

`Group.lineGroupRosterOnly Boolean @default(false)` — new column, one migration. Default `false`
keeps every existing group byte-identical.

### Routing — the only rule change

In `resolve()`:

```
group target  ⇐  lineGroupId !== null  AND  NOT lineGroupRosterOnly
host target   ⇐  (otherwise) lineDmEnabled AND owner.lineUserId AND liffId     (unchanged)
none          ⇐  otherwise
```

Everything downstream already keys off `resolve()`/`destination()`, so it follows with no change:
the payment card panel's `target`, `send` vs `sendToHost`, the end-of-session dialog label
("ส่งการ์ดสรุปเข้ากลุ่ม LINE" vs "ส่งการ์ดสรุปให้ฉันทาง LINE"), the summary page, and both public
LIFF share-card endpoints (which require `target === 'host'`). Plan gating and the finished-game
requirement stay as they are. `resolve()` and `PaymentCardService.send`/`sendToHost` are the only
group-push paths today (`line.push` call sites); a future group post must go through the same rule.

### Settings UI

- **Group card** (`group-settings-detail.html`, linked + paid branch): add the checkbox above the
  existing "ส่งสรุปเข้ากลุ่ม LINE เมื่อจบรอบ" switch. When roster-only is **on**, hide that
  summary-default switch (there's no group card to default).
- **DM card** (`line-host-link-panel`): its "ส่งการ์ดสรุปให้ฉันทาง LINE เมื่อจบรอบ" switch is
  shown only when `summaryAvailable`, which today requires `!botLinked`. Change to
  `!botLinked || lineGroupRosterOnly`, so it appears once roster-only is on.
- Both switches still write the same `lineSummaryDefault` field (one default; only one target is
  ever active).

### API

`GET /groups/:code/line` (`LineLinkService.status`) adds `rosterOnly: boolean`.
`PATCH /groups/:code/line` accepts `rosterOnly?: boolean` alongside `summaryDefault?: boolean`
(DTO: both optional, at least one present). Setting `rosterOnly` requires a paid plan and a linked
LINE group (`LINE_NOT_LINKED` otherwise), same guard style as `setSummaryDefault`. Owner-only via
the existing `OwnershipGuard`.

## Edge cases (decided)

- **Unlink / re-link:** the checkbox is per JubBad group and survives unlink and re-link.
  *(Claude's call; owner may override.)*
- **Flipped mid-night:** routing is re-read at send time, as today. Summary card is still
  at-most-once per session (`lineSummarySentAt`); if it already went to the group, flipping does
  not send a second copy. Payment card: group and DM sends keep their separate markers and retry
  keys, so a flip just changes which button the panel shows.
- **On and DM not set up:** host sees no card controls. The hint text tells them the DM route.
- **Plan lapse:** unchanged — no paid plan, no card on either route.

## Non-goals

- Choosing the route per send (owner chose a per-group setting).
- Separate switches for summary vs payment card.
- Any change to roster reading, `/link`, or bot replies in the group.
- Showing quota usage or warning about quota.

## Anti-goals

- Any host-facing text that mentions the bot's quota or saving it (owner decision 2026-11-04). The
  quota is the owner's reason for the switch, not something hosts are told.

## Done when

- [x] **Automated coverage:** engines untouched; server + web tests cover: group target with roster-only off (today),
  roster-only on → host target when DM ready, roster-only on → none when DM not ready, PATCH guard,
  status field, both settings panels show/hide the right switches.
- [x] **Documentation:** `docs/overview.md` host share card section updated: "group wins when both apply" replaced by the
  new rule, with this spec linked.
- [ ] **Owner-run real-LINE check** on the server: one group linked both ways, roster-only on, end a session → card
  lands in host DM, share into group works; roster-only off → card lands in group.
