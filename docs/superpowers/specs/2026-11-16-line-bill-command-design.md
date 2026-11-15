# `/bill` in the LINE group: the bot replies with the bill card and @mentions

**Date:** 2026-11-16 · **Status:** implemented and tested on `feat/line-bill-command`; owner-run real-LINE check pending

## Why

Hosts on roster-only groups share the payment card into the group themselves (LIFF share picker), so the bot
never pushes into the group (a group push costs one quota message per member). The picker cannot send LINE's
mention message (`textV2`), and a Flex card cannot hold a mention, so nobody who still owes gets tagged.

A bot **reply** costs no quota. Anyone typing `/bill` (or `/บิล`) in a linked LINE group makes the bot reply with
the latest bill card plus a `textV2` message that @mentions the linked players who still owe.

## Owner decisions (2026-11-16)

- The command starts with `/`, so it is separate from ordinary chat. The whole message must be the command
  (trimmed, case-insensitive): `bill`, `/bill now` and "ขอ /bill หน่อย" do nothing.
- Once the host has **confirmed** the bill, the command sends the card even if the host has not shared it.
- It works in roster-only groups. A reply is free and only answers a request, so the reason for roster-only
  still holds. The existing flow (summary + payment cards to the host DM, ส่งเข้ากลุ่ม) is unchanged.

## Behaviour

State is the group's latest **ended** session.

| State | Reply |
|---|---|
| LINE group not linked, plan below Host, LINE not configured | nothing |
| Same LINE group asked in the last 60s | nothing (in-memory cooldown; set only when a reply was sent) |
| No ended session | `ยังไม่มีบิล` |
| Collection closed | awards card; `ปิดรับเงินรอบนี้แล้ว` if nobody is rankable |
| Not confirmed, or bill not ready | `รอเจ้าของก๊วนยืนยันบิล` |
| Confirmed, edited since | `บิลมีการแก้ไข รอเจ้าของก๊วนยืนยันใหม่` |
| Nothing due | `รอบนี้ไม่มียอดต้องจ่าย` |
| Everyone paid | `จ่ายครบแล้ว 🎉` |
| Someone owes | the member card (paid people left off, as on a push) + a mention message |

Mentioned: billed people who still owe (no payment, not the เจ้าของบัญชี), with no slip waiting for review, with
a LINE account linked in this group that LINE still reports as a member of the LINE group. Up to 20; more are
counted as `และอีก N คน`. Nobody taggable means the card alone.

## How it works

- `LineGroupCommands` (`server/src/line/line-group-commands.ts`) is a one-method bridge: `SessionsModule`
  imports `LineModule`, so the webhook cannot inject `PaymentCardService`. The service registers its handler in
  `onModuleInit`; with none registered `/bill` is silent.
- `LineWebhookService` matches `BILL_COMMAND` before roster capture (so it is never stored as a roster), applies
  the cooldown and sends the messages with `replyMessages`.
- `PaymentCardService.groupBillReply` builds the answer under the session lock from the same `view`,
  `memberCardInput` and `awardsInput` a bot send uses. It stores nothing: `lastSentAt` and the 5s busy guard are
  not touched, because it is not a host send.
- `billMentionMessage` (`server/src/line/payment-card.ts`) builds the `textV2` message.

## Not done

- Mentions in the host-shared card: LIFF `shareTargetPicker` does not list `textV2`.
- A DM `/bill`: only group messages are answered.

## Done when

- [x] Automated coverage: command matching, cooldown, silence, every row of the table, mention exclusions.
- [x] `docs/overview.md` and the roster-only spec amended.
- [ ] **Owner-run real-LINE check** in a roster-only test group: waiting text before confirm; card + tags after
  (tagged phones notify); a second `/bill` inside a minute is silent; awards card after closing; the bot's
  message count in LINE OA Manager does not move.
