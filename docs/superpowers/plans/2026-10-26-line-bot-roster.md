# LINE Bot Roster Capture (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shared JubBad LINE bot joins a host's LINE group, keeps only roster messages, and pre-fills the roster box on `/g/:groupCode/start` with the newest one, so the host never has to log in to LINE on the iPad to copy it.

**Also in this plan (owner request, 2026-10-26):** on the roster review step (after อ่านรายชื่อ, before ยืนยันรายชื่อ), the host can rename or remove **any** name, not only names added by hand. This is independent of the bot and works for a manual paste too (Task 8).

**Architecture:**
- **Engines.** The pure rules live in a new dependency-free engine file: is-this-a-roster, staleness and purge.
- **Server.** A new NestJS `line` module holds a signed, idempotent webhook, a link-code service and a roster-capture service, with three new Prisma models/fields. It calls LINE's REST API with `fetch`, with no SDK.
- **Web.** The web gets a `line` settings section and a pre-fill on roster entry.
- **Fallback.** Every failure falls back to today's manual paste.

**Tech Stack:** NestJS + Prisma + SQLite (vitest, `fileParallelism: false`), Angular standalone + signals (`ng test`), `engines/` pure TypeScript (`node:test`), LINE Messaging API (webhook + reply + group/member summary).

**Status (2026-10-26):** Tasks 1 to 9 built and verified on branch `feat/line-bot-roster`; the only open boxes are the owner's real-LINE check (Task 9 step 4) and archiving this plan after that. Rulings made during the build are in the PR description and `docs/overview.md`'s LINE bot section.

**Spec:** `docs/superpowers/specs/2026-10-26-line-bot-roster-design.md`. This plan covers spec sections 1 (Linking), 2 (Capture) and 3 (Start). Section 4 (Phase 2, weekly auto-post) is **out of scope**: the spec makes the LINE push-quota check a precondition for it. It gets its own plan once that is answered.

## Decisions this plan makes (spec marked these "left to the builder" or "my call")

1. **What counts as a roster:** `parseLineRosterMessage(text)` finds **at least 3 numbered lines** (roster plus waitlist slots, filled or empty) **and** the header has a date, a venue or a time slot. The header rule keeps a numbered rules post or announcement from becoming "the newest roster". Anything else is dropped unstored. A group whose template has no header at all gets no capture and falls back to manual paste (the real-LINE check in Task 9 shows if that happens).
2. **Retention:** per group, keep the **newest 20** roster messages and **nothing older than 30 days**. Purge runs on every capture, plus a 6-hourly sweep for idle groups.
3. **Link code:**
   - 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, valid 10 minutes, single use.
   - Stored only as a SHA-256 hex hash, and never logged.
   - A new code voids the group's earlier unused codes.
   - Accepted as `/link <code>` in any case, with surrounding spaces ignored.
4. **Wrong or expired codes:**
   - The bot replies with one generic Thai line: `รหัสไม่ถูกต้องหรือหมดอายุ ตรวจรหัสได้ที่ JubBad > ตั้งค่ากลุ่ม > กลุ่ม LINE`. It never says whether the code was wrong, expired, or the LINE group was already linked. Owner decision 2026-10-26: feedback beats silence, and replies are free on LINE.
   - A throttled sender gets no reply.
   - Attempts are throttled per LINE group **and sender** with the existing `LoginThrottle` (key `line:<lineGroupId>:<senderUserId or anon>`, 10 per 15 minutes), so one member's bad guesses cannot lock the host out of linking.
5. **The bot's reply:** Thai only, because it is spoken into a Thai LINE group: `เชื่อมกลุ่มนี้กับก๊วน «{name}» ใน JubBad แล้ว บอทจะจำเฉพาะข้อความรายชื่อ พร้อมชื่อคนที่ส่งและเวลา ไม่เก็บแชตอื่น`. It says what is stored, including who posted it.
6. **Configuration:** env vars `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN` and `LINE_BOT_ADD_URL` (the bot's https add-friend link). If the secret or token is unset, the feature reports `configured: false` and the webhook answers 503.
7. **Plan gating** (Host and up, read at call time):
   - Creating a code needs a paid plan.
   - Capture and the latest-roster lookup are skipped on a free or lapsed plan.
   - Unlinking and status are always allowed.
8. **Stale:** the newest roster is stale when it is older than the group's last `Session.endedAt`. When no session has ever ended, it is stale when older than 7 days.
9. **Sender display time:** shown in Asia/Bangkok. "18:42" if posted today in Bangkok, otherwise short weekday, day and month plus time.
10. **Edited messages:** LINE sends an event when a user edits a message (the docs summary names it `messageEdited`; the message ID stays the same). The stored text is replaced by the edited text and `postedAt` is kept. If the edited text is no longer a roster the row is deleted; if it became one and was never stored it is captured. Confirm the exact event type string on a real event in Task 9 step 4.
11. **Unlink also removes the bot.** Unlinking from settings, or deleting the group, asks the bot to leave the LINE group (best effort; a LINE failure never blocks the unlink). Re-linking means inviting the bot again. Without this the bot keeps receiving every message in a chat it no longer serves.
12. **Sender names are cached** in memory for 24 hours per LINE group and user, and every LINE API call times out after 3 seconds, so a batch of events cannot hold the webhook open. Members on LINE for PC have no `source.userId`; their messages are stored with both sender fields null.

## Global Constraints

- `engines/` stays dependency-free and is tested with `node --experimental-strip-types --test`.
- No new npm dependencies on either side. Use the global `fetch` and `node:crypto`.
- Server specs keep `fileParallelism: false`.
- Every new host-facing string uses `$localize`/`i18n` with an `@@id`, a Thai source, and an English target in `web/src/locale/messages.en.xlf`. Re-run `npx ng extract-i18n --output-path src/locale` in `web/`. In Thai copy, write "แพ็ก⁠เกจ" (U+2060 inside).
- Owner routes live under `/groups/:code/...` so `OwnershipGuard` covers them: an owner mismatch is 404, never 403.
- Never store or log chat that is not a roster, and never log a link code or message text.
- Start is never blocked. If the lookup fails or is slow, the screen behaves exactly like today.
- Keep 44px tap targets.

## Review Focus

1. **The host already has a restored draft, or has started typing, when the latest-roster answer arrives.** The answer must never overwrite their text. Test owner: Task 7.
2. **LINE redelivers an older message after a newer one** (a retry, or an out-of-order batch). The "newest" is decided by LINE's event timestamp, not arrival order, and a duplicate message ID stores once. Test owner: Task 4.
3. **The host types the code loosely** (`/link ab12cd `, or `/LINK AB12CD`). It still links. Test owner: Task 4.
4. **The group's owner is on free or has lapsed while the group stays linked.**
   - Capture is dropped.
   - The latest-roster answer is `null`, and start shows the manual paste.
   - Creating a code is refused with `PLAN_REQUIRED`.
   - Unlinking still works.

   Test owner: Tasks 3, 4 and 5.
5. **Someone adds a name in LINE after the host has already pre-filled or edited the list** (or a draft from earlier in the same app session is restored). The host sees an offer to use the newer list and can undo it. Their own edits are never replaced silently. Test owner: Task 7.
6. **The host renames a row to a name that is already on the list, or to an existing player another row already claimed.** It must not create a duplicate player or seat the same person twice. It is refused with the same messages manual add uses. Test owner: Task 8.
7. **LINE won't give the sender's name** (the profile lookup 404s, or the member has left). The message is stored with a null name and shown as "ไม่ทราบชื่อ" / "unknown". Test owners: Task 4 (storage) and Task 7 (display).
8. **A member edits their roster message after sending it.** The stored text follows the edit, and an edit that stops being a roster removes the row. Test owner: Task 4.
9. **A numbered post that is not a roster** (rules, an announcement) arrives after the real roster. It is not stored, so it never replaces the real roster. Test owner: Task 1.

---

### Task 1: Engines: roster recognition, staleness, purge

**Files:**
- Create: `engines/line-roster.ts`, `engines/line-roster.test.ts`

**Interfaces:**
- Produces:
  - `MIN_ROSTER_LINES = 3`
  - `isRosterMessage(text: string): boolean`
  - `STALE_WITHOUT_SESSION_MS = 7 * 24 * 60 * 60 * 1000`
  - `rosterStaleness(postedAt: Date, lastEndedAt: Date | null, now: Date): 'fresh' | 'stale'`
  - `MAX_KEPT_MESSAGES = 20`
  - `MAX_KEPT_DAYS = 30`
  - `messagesToPurge(rows: { id: string; postedAt: Date }[], now: Date): string[]`. Returns the ids to delete: everything beyond the newest 20 by `postedAt`, plus anything older than 30 days.

- [x] **Step 1: Write failing tests in `engines/line-roster.test.ts`**
  - `isRosterMessage`:
    - A real-shaped roster (a header line with a date or time, `1. ตั้ม`, `2. มด`, `3.`) is true.
    - The empty weekly template with numbered blank lines `1.` to `20.` is true.
    - `ไปไหมคืนนี้`, `1. ok`, and two numbered lines are false.
    - A rules post (`กฎก๊วน`, `1. มาตรงเวลา`, `2. ห้ามเสียงดัง`, `3. จ่ายเงินก่อนกลับ`) with no date, venue or time is false.
    - A numbered list with a date line but only two slots is false.
    - An empty string is false.
  - `rosterStaleness`:
    - Posted before `lastEndedAt` gives `'stale'`; posted after gives `'fresh'`.
    - With `lastEndedAt = null`: 6 days 23 hours old is `'fresh'`, 7 days 1 hour is `'stale'`.
  - `messagesToPurge`:
    - 25 rows over 5 days returns the 5 oldest ids.
    - 3 rows, one 31 days old, returns that id.
    - An empty array returns `[]`.
- [x] **Step 2: Run** `node --experimental-strip-types --test engines/line-roster.test.ts`. Expected: FAIL (module not found).
- [x] **Step 3: Implement** with `isRosterMessage` using `const r = parseLineRosterMessage(text)`: true when `r.roster.length + r.waitlist.length >= MIN_ROSTER_LINES` and (`r.header.rawDate !== null || r.header.venue !== null || r.header.timeSlots.length > 0`).
- [x] **Step 4: Run** the same command and then `npm run test:engines`. Expected: PASS, with no other engine test changed.
- [x] **Step 5: Commit** with message `feat(engines): line roster recognition, staleness and purge rules`

### Task 2: Server: schema, LINE config, signature and client

**Files:**
- Modify: `server/prisma/schema.prisma`, plus a new migration `server/prisma/migrations/<ts>_line_bot/migration.sql` (via `npx prisma migrate dev --name line_bot` against a scratch DB, never the owner's `dev.db`)
- Create: `server/src/line/line-config.ts`, `server/src/line/line-signature.ts`, `server/src/line/line-client.ts`, `server/src/line/line.module.ts`
- Modify: `server/src/main.ts` (`NestFactory.create(AppModule, { rawBody: true })`), `server/src/app.module.ts` (import `LineModule`), `server/.env.example`
- Test: `server/src/line/line-signature.spec.ts`, `server/src/line/line-client.spec.ts`, `server/src/groups/` delete-group spec (cascade)

**Interfaces:**
- Schema:
  - `Group` gains `lineGroupId String? @unique`, `lineGroupName String?`, `lineLinkedAt DateTime?` and `lineLeftAt DateTime?`.
  - New `LineLinkCode { id cuid, groupId, codeHash String @unique, expiresAt DateTime, usedAt DateTime?, createdAt }`.
  - New `LineRosterMessage { id cuid, groupId, text String, senderUserId String?, senderName String?, postedAt DateTime, lineMessageId String @unique, botPosted Boolean @default(false), createdAt; @@index([groupId, postedAt]) }`.
  - Both relations to `Group` use `onDelete: Cascade`.
- Produces:
  - `lineConfig(): { secret: string | null; token: string | null; botAddUrl: string | null }`, read from env at call time. `botAddUrl` must be https or it is null.
  - `verifyLineSignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean`. Base64 HMAC-SHA256, compared with `timingSafeEqual`, and false on a length mismatch.
  - Injectable `LineClient`:
    - `reply(replyToken: string, text: string): Promise<void>`
    - `groupName(lineGroupId: string): Promise<string | null>`
    - `memberName(lineGroupId: string, userId: string): Promise<string | null>`. Successful names are cached in memory for 24 hours per `lineGroupId:userId`.
    - `leave(lineGroupId: string): Promise<void>`: `POST /v2/bot/group/{id}/leave`.
    - All four use `https://api.line.me/v2/bot/...` with `Authorization: Bearer <token>` and a 3 second timeout (`AbortSignal.timeout(3000)`). They return null, or do nothing, when the token is unset, the call fails or it times out, and they never throw.

- [x] **Step 1: Write failing tests**
  - Signature:
    - A body signed with secret `s` verifies.
    - A one-byte change fails.
    - An undefined header fails.
    - A wrong-length header fails without throwing.
  - `LineClient` (stub `globalThis.fetch`):
    - `groupName` returns `groupName` from a 200 JSON body.
    - Returns null on 404.
    - Returns null when `LINE_CHANNEL_ACCESS_TOKEN` is unset (and makes no fetch).
    - `reply` posts `{ replyToken, messages: [{ type: 'text', text }] }`.
    - `leave` posts to `/v2/bot/group/{id}/leave`, and does not throw on a 404 or a network error.
    - `memberName` for the same group and user twice makes one fetch (cache).
    - A fetch that never resolves returns null once the 3 second timeout fires.
  - Cascade: deleting a group that has one `LineLinkCode` and one `LineRosterMessage` leaves zero of each.
- [x] **Step 2: Run** `cd server && SESSION_SECRET=test npx vitest run src/line src/groups`. Expected: FAIL.
- [x] **Step 3: Implement.** Add the schema and migration, then the files above. Add `LINE_CHANNEL_SECRET=`, `LINE_CHANNEL_ACCESS_TOKEN=` and `LINE_BOT_ADD_URL=` to `.env.example`, with one comment line each.
- [x] **Step 4: Run** the same command, then the full `SESSION_SECRET=test npx vitest run`. Expected: PASS everywhere. The full run proves `rawBody: true` broke nothing.
- [x] **Step 5: Commit** with message `feat(server): line bot schema, config, signature and client`

### Task 3: Server: link codes, status and unlink (owner routes)

**Files:**
- Create: `server/src/line/line-link.service.ts`, `server/src/line/line.controller.ts`
- Test: `server/src/line/line-link.spec.ts`

**Interfaces:**
- Consumes: `lineConfig`, `LineClient` (Task 2), `PlansService.requireGroupPlan(code, 'host')`.
- Produces `LineLinkService`:
  - `status(groupCode: string): Promise<LineStatus>`, where `LineStatus = { configured: boolean; botAddUrl: string | null; linked: boolean; lineGroupName: string | null; linkedAt: string | null; leftAt: string | null }`
  - `createCode(groupCode: string, now?: Date): Promise<{ code: string; expiresAt: string }>`
  - `redeem(lineGroupId: string, rawCode: string, now?: Date): Promise<{ groupCode: string; groupName: string | null } | null>`
  - `unlink(groupCode: string): Promise<void>`. Clears the four `Group.line*` fields and deletes the group's messages and codes, then asks the bot to leave the LINE group (`LineClient.leave`, best effort; a LINE failure never blocks the unlink).
  - `markLeft(lineGroupId: string, now?: Date): Promise<void>`. Same as unlink for that LINE group, but sets `lineLeftAt = now`.
- Produces routes:
  - `GET /groups/:code/line` returns `LineStatus`.
  - `POST /groups/:code/line/code` returns `{ code, expiresAt }`. Refusals:
    - 503 `{ code: 'LINE_NOT_CONFIGURED' }` when the secret or token is unset.
    - 403 `PLAN_REQUIRED` on free.
    - 409 `{ code: 'LINE_ALREADY_LINKED' }` when already linked.
  - `DELETE /groups/:code/line` returns `{ unlinked: true }`.

- [x] **Step 1: Write failing tests**
  - Code creation:
    - The code is 6 characters from the fixed alphabet, `expiresAt` is now + 10 minutes, and the DB holds only the hash, never the code.
    - Creating a second code makes the first unredeemable.
  - Redeem:
    - A valid code links (sets `lineGroupId` and `lineLinkedAt`, and `lineGroupName` from a faked `LineClient.groupName`) and marks the code used.
    - Redeeming it again returns null.
    - An expired code returns null.
    - `' ab12cd '` style input is normalised (Review Focus 3).
    - Refuses (null) when the LINE group is already linked to another JubBad group, or the JubBad group is already linked.
    - Refuses when the owner's plan is free at redeem time.
  - Status:
    - Reports `configured: false` when the env is unset.
    - Reports `leftAt` after `markLeft`.
    - A successful re-link clears `leftAt`.
  - Owner-route gating:
    - 403 `PLAN_REQUIRED` when free.
    - 409 when already linked.
    - 503 when not configured.
    - An unlink on free succeeds and deletes messages and codes (Review Focus 4).
    - Unlink calls `LineClient.leave` once with the LINE group ID, and still succeeds when `leave` fails.
    - Deleting a linked JubBad group also calls `LineClient.leave`.
    - A later `leave` event for the same LINE group is a no-op (the group is no longer linked).
  - Ownership: another host's `GET /groups/:code/line` answers 404.
- [x] **Step 2: Run** `cd server && SESSION_SECRET=test npx vitest run src/line`. Expected: FAIL.
- [x] **Step 3: Implement.**
  - Hash with `createHash('sha256')`.
  - Generate codes with `randomInt` over the alphabet.
  - Do the redeem check-and-set in one `$transaction` so two redeems cannot both link.
  - Hook the group-delete path in `server/src/groups/` to call the same release logic before the row is deleted.
- [x] **Step 4: Run** the same command plus `src/auth`. Expected: PASS, and the auth boundary walk still holds.
- [x] **Step 5: Commit** with message `feat(server): line link codes, status and unlink`

### Task 4: Server: signed webhook (/link, capture, unsend, leave)

**Files:**
- Create: `server/src/line/line-webhook.controller.ts`, `server/src/line/line-roster.service.ts`, `server/src/line/line-purge.ts` (scheduler, imported only by `AppModule`, the same pattern as `sessions/auto-confirm.ts`)
- Modify: `server/src/auth/auth.boundary.spec.ts`. Add `/line/webhook` to the ownership-walk exceptions, with a comment: it is `@Public`, has no `:code`, and authenticates by LINE signature.
- Test: `server/src/line/line-webhook.spec.ts`, `server/src/line/line-roster.spec.ts`

**Interfaces:**
- Consumes: `verifyLineSignature`, `lineConfig`, `LineClient`, `LineLinkService.redeem/markLeft` (Tasks 2 and 3), `isRosterMessage`, `messagesToPurge` (Task 1), `LoginThrottle` (`server/src/auth/login-throttle.ts`, key `line:<lineGroupId>:<senderUserId or anon>`), `PlansService.planForGroup`.
- Produces `LineRosterService`:
  - `capture(input: { lineGroupId: string; lineMessageId: string; text: string; senderUserId: string | null; postedAt: Date }): Promise<'stored' | 'ignored'>`
  - `unsend(lineMessageId: string): Promise<void>`
  - `edit(input: { lineGroupId: string; lineMessageId: string; text: string; senderUserId: string | null; postedAt: Date }): Promise<'updated' | 'removed' | 'stored' | 'ignored'>`. Replaces the stored text and keeps its `postedAt`; deletes the row if the new text is not a roster; captures it (with the event's `postedAt`) when it was never stored and now is one.
  - `purge(now?: Date): Promise<number>`
- Produces route: `POST /line/webhook`, `@Public()`.
  - 503 when not configured.
  - 401 when the `x-line-signature` header is missing or invalid.
  - Otherwise 200 `{ ok: true }`, even if a single event fails. Each event is caught and logged by type only, never by text.
- Event handling, one by one in order:
  - **Text message from a `group` source:**
    - If it matches `/^\/link\s+([A-Za-z0-9]{6})\s*$/i`, check the throttle (key `line:<lineGroupId>:<senderUserId or anon>`), then call `redeem`.
    - On success, `reply` with decision 5's text and record a throttle success.
    - On failure, record a throttle failure and `reply` with decision 4's failure text. If the sender is already throttled, stay silent.
    - Anything else goes to `capture`.
  - **`unsend`:** call `unsend`.
  - **Edited message** (group source; event type `messageEdited` per the LINE docs summary, verify on a real event): call `edit`.
  - **`leave`:** call `markLeft`.
  - **Anything else** (user or room sources, `join`, stickers, images): ignore.
- `capture`:
  - Ignore when the LINE group is not linked, the owner is not paid now, or `!isRosterMessage(text)`.
  - Otherwise create the row with the sender name from `LineClient.memberName` (null allowed) and `postedAt` from the event timestamp. When the event has no `source.userId` (LINE for PC users), store `senderUserId` and `senderName` both null and skip the lookup.
  - A duplicate `lineMessageId` (P2002) returns `'ignored'`.
  - Then delete `messagesToPurge` ids for that group.
- Scheduler: `LinePurgeScheduler` runs `purge()` every 6 hours (`unref`'d). It also deletes expired or used `LineLinkCode` rows older than a day.

- [x] **Step 1: Write failing tests** (sign bodies with `LINE_CHANNEL_SECRET=test-secret`; fake `LineClient` via `overrideProvider`; build the app with `createNestApplication({ rawBody: true })`)
  - Signature:
    - An unsigned body returns 401.
    - A tampered body returns 401.
    - A correctly signed body with zero events returns 200.
  - `/link`:
    - A valid code links and calls `reply` once.
    - A wrong, expired or refused code gets exactly one reply with the generic failure text, which contains no code and no ID.
    - The 11th wrong attempt from one sender in 15 minutes is ignored silently (no reply) even with the right code (throttled), while a different sender in the same LINE group can still link.
    - Two `/link` events with the same code in one batch link once.
  - Capture:
    - A roster from a linked, paid group is stored with the sender name.
    - The same `message.id` twice is stored once.
    - Ordinary chat is not stored (the row count stays 0).
    - An unlinked LINE group is not stored.
    - A free owner's group is not stored (Review Focus 4).
    - A `memberName` returning null stores `senderName = null` (Review Focus 7).
  - Ordering (Review Focus 2): deliver message B (timestamp t2) and then message A (t1 < t2) in separate requests. The newest by `postedAt` is B.
  - `unsend` removes the stored row. Unsend for an unknown id is a no-op.
  - Edit (Review Focus 8): an edit replaces the stored text and keeps `postedAt`; an edit to text that is not a roster deletes the row; an edit of a never-stored message that is now a roster stores it; an edit in an unlinked group or for a free owner is ignored.
  - A message with no `source.userId` stores null sender fields and makes no `memberName` call.
  - A `memberName` that never resolves does not stop the webhook answering 200 (the LineClient timeout fires).
  - `leave` unlinks, sets `lineLeftAt`, and deletes the group's messages.
  - Purge: after 22 captures only 20 remain, and a row with `postedAt` 31 days ago is gone after `purge()`.
- [x] **Step 2: Run** `cd server && SESSION_SECRET=test npx vitest run src/line src/auth`. Expected: the new tests FAIL. The boundary spec fails until the exception line is added.
- [x] **Step 3: Implement.** Read the raw body via `RawBodyRequest<Request>` (`req.rawBody`).
- [x] **Step 4: Run** `cd server && SESSION_SECRET=test npx vitest run && npm run lint`. Expected: PASS, lint clean.
- [x] **Step 5: Commit** with message `feat(server): signed line webhook with link, capture, unsend and leave`

### Task 5: Server: latest roster for start

**Files:**
- Modify: `server/src/line/line-roster.service.ts`, `server/src/line/line.controller.ts`
- Test: `server/src/line/line-roster.spec.ts`

**Interfaces:**
- Consumes: `rosterStaleness` (Task 1), `PlansService.planForGroup`.
- Produces:
  - `LineRosterService.latest(groupCode: string, now?: Date): Promise<LatestRoster | null>`, where `LatestRoster = { text: string; senderName: string | null; postedAt: string; stale: boolean }`.
  - Route `GET /groups/:code/line/latest-roster` returns `{ roster: LatestRoster | null }`.
  - It is `null` when the group is unlinked, has no message, or the owner is not paid now.
  - `stale` comes from `rosterStaleness(postedAt, newest Session.endedAt of the group or null, now)`.

- [x] **Step 1: Write failing tests**
  - The newest by `postedAt` is returned, not the last inserted.
  - `stale` is true when an ended session's `endedAt` is after `postedAt`, and false when the message is newer.
  - With no sessions, an 8-day-old message is stale.
  - Unlinked returns null.
  - A free owner returns null (Review Focus 4).
  - Another host gets 404 (ownership).
- [x] **Step 2: Run** `cd server && SESSION_SECRET=test npx vitest run src/line`. Expected: FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** the same command. Expected: PASS.
- [x] **Step 5: Commit** with message `feat(server): latest captured roster for start`

### Task 6: Web: the "กลุ่ม LINE" settings section

**Files:**
- Create: `web/src/app/core/line.model.ts`, `web/src/app/core/line.service.ts` (+ spec)
- Modify:
  - `web/src/app/core/settings-sections.ts`. Add `'line'` after `'share'` in both `SETTINGS_SECTIONS` and `DETAIL_SECTIONS`.
  - `web/src/app/pages/group-home/group-home.{ts,html,spec.ts}`. A new row. Not linked on free or lapsed: locked (existing locked-row pattern, opens the upgrade sheet). Linked on free or lapsed: the row shows `group.value.linePaused` and links to the detail page, which offers only the paused notice, an upgrade button and Unlink (owner decision 2026-10-26: locked, paused, Unlink only; the link resumes by itself on renewal).
  - `web/src/app/pages/group-settings-detail/group-settings-detail.{ts,html,css,spec.ts}`. A new `@case ('line')`.
  - The locale files.

**Interfaces:**
- Consumes: the Task 3 routes, `PlanService`, `UpgradeSheetService.open()`, `planErrorMessage`.
- Produces:
  - `LineService`:
    - `status(code): Observable<LineStatus>`
    - `createCode(code): Observable<{ code: string; expiresAt: string }>`
    - `unlink(code): Observable<{ unlinked: true }>`
    - `latestRoster(code): Observable<{ roster: LatestRoster | null }>`
  - The `LineStatus` and `LatestRoster` types, mirroring the server.

Detail page states:

| State | Shows |
|---|---|
| Not configured | One muted line `line.notConfigured`. |
| Not linked | Step 1: a button-link to `botAddUrl`, "เพิ่มบอทเข้ากลุ่ม LINE", with the `line.addBotHint` line under it. Step 2: a button "สร้างรหัสเชื่อม". With a code: the code in large monospace, a copy button, the instruction to type `/link CODE` in the group, and time left. Polls `status` every 5 s until linked or expired, then stops. |
| Linked | The LINE group name (or "กลุ่ม LINE"), the linked date, and **ยกเลิกการเชื่อม** with an inline confirm. |
| `leftAt` set | A notice line above the not-linked state. |
| Free or lapsed, not linked | The plan lock with a hint, and no code button. |
| Free or lapsed, linked | `line.pausedNotice` and an upgrade button, plus **ยกเลิกการเชื่อม** with the inline confirm. No latest-roster details. Renewal resumes the link by itself; messages posted while paused are not recovered. |

Copy:

| id | th | en |
|---|---|---|
| `group.row.line` | กลุ่ม LINE | LINE group |
| `group.row.lineDesc` | บอทจำรายชื่อล่าสุดให้ ไม่ต้องคัดลอกเอง | The bot keeps the latest roster for you |
| `group.value.lineLinked` | เชื่อมแล้ว | Linked |
| `group.value.lineNotLinked` | ยังไม่เชื่อม | Not linked |
| `group.value.linePaused` | หยุดชั่วคราว | Paused |
| `line.pausedNotice` | แพ็ก⁠เกจหมดอายุ บอทหยุดจำรายชื่อชั่วคราว ต่ออายุแล้วจะกลับมาทำงานเอง | Your plan lapsed, so the bot has paused. It resumes by itself when you renew |
| `line.title` | กลุ่ม LINE | LINE group |
| `line.addBot` | เพิ่มบอทเข้ากลุ่ม LINE | Add the bot to your LINE group |
| `line.addBotHint` | กลุ่ม LINE หนึ่งกลุ่มมีบอทได้ตัวเดียว ถ้ามีบอทอื่นอยู่แล้วต้องเอาออกก่อน | A LINE group can hold only one bot. If another bot is already there, remove it first |
| `line.makeCode` | สร้างรหัสเชื่อม | Create a link code |
| `line.typeCode` | พิมพ์ข้อความนี้ในกลุ่ม LINE: | Type this in the LINE group: |
| `line.expiresIn` | หมดอายุใน {minutes} นาที | Expires in {minutes} min |
| `line.linkedTo` | เชื่อมกับ {name} แล้ว | Linked to {name} |
| `line.unlink` | ยกเลิกการเชื่อม | Unlink |
| `line.unlinkConfirm` | ยกเลิกแล้วบอทจะออกจากกลุ่ม LINE และลบรายชื่อที่จำไว้ ถ้าจะเชื่อมใหม่ต้องเชิญบอทอีกครั้ง | The bot leaves the LINE group and forgets the stored rosters. To link again you must invite it again |
| `line.leftNotice` | บอทถูกนำออกจากกลุ่ม LINE เมื่อ {date} เชื่อมใหม่ได้ด้านล่าง | The bot was removed from the LINE group on {date}. You can link again below |
| `line.notConfigured` | ยังไม่ได้ตั้งค่าบอท LINE ของระบบ | The LINE bot is not set up yet |
| `plan.lock.line` | การเชื่อมกลุ่ม LINE ใช้ได้ในแพ็ก⁠เกจโฮสต์ | Linking a LINE group is on the Host plan |

- [x] **Step 1: Write failing tests**
  - `LineService` URLs and methods.
  - Group home:
    - The row shows `เชื่อมแล้ว` with the group name, or `ยังไม่เชื่อม`.
    - On free or lapsed it is a locked button when not linked, and a link showing `เชื่อมแล้ว` replaced by `group.value.linePaused` when linked.
  - Detail page:
    - Each state in the table renders its pieces.
    - `สร้างรหัสเชื่อม` posts and shows the code and instruction.
    - Polling flips to the linked state when `status` answers linked.
    - Polling stops after expiry.
    - Unlink asks, then DELETEs, then shows the not-linked state.
    - A 403 `PLAN_REQUIRED` shows `planErrorMessage`.
    - A 503 shows `line.notConfigured`.
- [x] **Step 2: Run** `cd web && npx ng test --watch=false`. Expected: the new specs FAIL.
- [x] **Step 3: Implement.** Extract i18n and add the English targets.
- [x] **Step 4: Run** `cd web && npx ng test --watch=false && npx ng build`. Expected: PASS, and the build has no missing translations.
- [x] **Step 5: Commit** with message `feat(web): link a LINE group from group settings`

### Task 7: Web: roster entry pre-fills the latest LINE roster

**Files:**
- Modify: `web/src/app/pages/group-entry/group-entry.{ts,html,css,spec.ts}`, `web/src/app/core/line.model.ts`, locale files

**Interfaces:**
- Consumes: `LineService.latestRoster` (Task 6).
- Produces: `formatPostedAt(iso: string, now: Date, locale: string): string` in `line.model.ts`. It uses Asia/Bangkok: `HH:mm` when it is the same Bangkok day as `now`, otherwise short weekday, day, month and time.

Behaviour:
- After the group loads, call `latestRoster` once.
- Fill `rawText` only if all of these still hold when the answer arrives: no draft was restored, `rawText()` is empty, `state() === 'paste'`, and the screen is not paused.
- Never auto-parse: the host still taps อ่านรายชื่อ.
- Show one muted provenance line above the paste box. If `stale`, show one warning line under it.
- Any error, a null roster, or a slow answer leaves today's screen untouched.
- **Editing stays the normal paste flow.** The pre-filled text is ordinary text in the box: the host can edit it, read it, add by hand, change answers, go back with "← แก้ข้อความที่วาง", or clear with undo. The stored LINE message is never changed by host edits.
- **A newer list.** When `rawText()` is non-empty and differs from the newest LINE roster, show one line with a button: `entry.lineNewer` + `entry.lineUseNewer`.
  - When it appears: while in `state() === 'paste'`. This covers a restored draft, or a list already in the box when someone adds a name in LINE.
  - When it is checked: on load, and again each time the host comes back to the paste state, for example via "← แก้ข้อความที่วาง".
  - Tapping the button replaces `rawText` with the newer roster and updates the provenance line. The previous text goes to the existing undo snapshot, so `เลิกทำ` restores it.
  - It never replaces text on its own.

| id | th | en |
|---|---|---|
| `entry.lineFrom` | รายชื่อล่าสุดจาก LINE โดย {name} · {time} | Latest roster from LINE by {name} · {time} |
| `entry.lineUnknown` | ไม่ทราบชื่อ | unknown |
| `entry.lineStale` | รายชื่อนี้เก่ากว่ารอบที่แล้ว ตรวจให้แน่ใจว่าเป็นของรอบนี้ | This list is older than the last round. Check it is for this one |
| `entry.lineNewer` | มีรายชื่อใหม่กว่าใน LINE (โดย {name} · {time}) | There is a newer list in LINE (by {name} · {time}) |
| `entry.lineUseNewer` | ใช้รายชื่อนี้ | Use this list |

- [x] **Step 1: Write failing tests** (`group-entry.spec.ts`, plus `line.model` spec)
  - A fresh screen fills `rawText` with the roster text and shows `entry.lineFrom` with the name and the Bangkok time.
  - `stale: true` adds `entry.lineStale`.
  - A null `senderName` shows `entry.lineUnknown` (Review Focus 7).
  - Not overwritten (Review Focus 1):
    - A restored draft is not overwritten and no provenance line shows.
    - Text the host typed before the answer arrives is not overwritten.
  - `{ roster: null }`, a 500, and a never-answering request all leave the empty paste box and no extra line.
  - No parse request is sent automatically.
  - Edits stay local: after a pre-fill, the host deletes a line and adds a name in the box, then taps อ่านรายชื่อ. The parse request carries the edited text, and no request touches the LINE endpoints.
  - Newer list:
    - With a restored draft whose text differs from the newest LINE roster, `entry.lineNewer` shows and the draft is untouched.
    - Tapping `entry.lineUseNewer` replaces the text.
    - `เลิกทำ` brings the draft back.
  - Newer list after going back: after อ่านรายชื่อ, going back with "← แก้ข้อความที่วาง" re-checks `latestRoster`. A newer message answered there shows `entry.lineNewer`.
  - No offer when the box already holds exactly the newest roster.
  - `formatPostedAt`: same day gives `18:42`; a different day includes the date; the Bangkok day boundary is respected at 23:30 UTC.
- [x] **Step 2: Run** `cd web && npx ng test --watch=false`. Expected: the new specs FAIL.
- [x] **Step 3: Implement.** Extract i18n and add the English targets.
- [x] **Step 4: Run** `cd web && npx ng test --watch=false && npx ng build`. Expected: PASS.
- [x] **Step 5: Commit** with message `feat(web): roster entry pre-fills the latest LINE roster`

### Task 8: Web: rename (searchable) or remove any name on the roster review step

Scope: the review step only, after อ่านรายชื่อ and before ยืนยันรายชื่อ. Nothing changes after the session has started.

**Files:**
- Create: `web/src/app/shared/player-search-field/player-search-field.{ts,html,css,spec.ts}`. This is the manual-add combobox extracted into a shared component.
- Modify: `web/src/app/pages/group-entry/group-entry.{ts,html,css,spec.ts}`, `web/src/app/core/roster-review.ts` (+ spec), locale files

**Interfaces:**
- Consumes (existing, `core/roster-review.ts`): `searchCandidates(query, players, claimedIds)`, `exactPlayerMatch(query, players)`, `literalNewNameDrafts(roster, waitlist)`, `literalKey(name)`. Also the component's `players()`, `claimedIds()`, `manualReviews`, `isSubmitting()`, `minRoster`.
- Produces:
  - `<app-player-search-field>`, the manual-add combobox moved out of `group-entry`, with the same behaviour:
    - ranked candidates while typing
    - a trailing "add as new" option
    - arrow keys, Enter and Escape
    - the `isComposing` guard for Thai IME
    - `aria-activedescendant`
  - Its inputs:
    - `players: Player[]`
    - `claimedIds: ReadonlySet<string>`
    - `initialText = ''`
    - `idPrefix: string` (default `'manual'`)
    - `label: string`
    - `placeholder: string`
    - `disabled = false`
    - `drafts: ReadonlySet<string>` (literal keys of names already drafted as new)
  - Its outputs:
    - `pickExisting: string` (a playerId)
    - `pickNew: string` (a trimmed name)
    - `cancel: void` (Escape with an empty listbox, or blur in rename mode)
  - It renders the same ids and class names manual add renders today, built from `idPrefix`: `${idPrefix}-add-input`, `${idPrefix}-option-${i}`, `.manual-option`, `.manual-option-add`, `.manual-option-name`. So with `idPrefix = 'manual'` the DOM is unchanged.
  - It shows the existing errors itself (`entry.manualAddEmpty`, `entry.manualAddExactExists`, `entry.manualAddDuplicate`, `entry.manualAlreadySelected`).
  - In `GroupEntry`:
    - `removeReview(review: NameReview): void`. Works for any row in `rosterReviews` or `waitlistReviews`; manual rows keep their existing path.
    - `undoRemoveReview(): void`. A single-level undo that puts the row back at its old index in its old list.
    - `lastRemoved: Signal<{ name: string } | null>`
    - `renaming: Signal<NameReview | null>`
    - `startRename(review)` and `cancelRename()`
    - `renameToExisting(review: NameReview, playerId: string): void`
    - `renameToNew(review: NameReview, name: string): void`

Behaviour:
- **Manual add uses the extracted field** with `idPrefix="manual"`. Every existing manual-add spec must pass unchanged. That is the proof the extraction changed nothing.
- **Two new actions on every review row** (roster and waitlist): **แก้ชื่อ** and **นำออก**. They sit in the same place and style as the existing manual-row นำออก, with 44px targets and disabled while submitting. One row can be in rename mode at a time.
- **นำออก** removes the row and shows one line: "นำ {name} ออกแล้ว · เลิกทำ". A second removal replaces the undo target. The existing `minRoster` gate on ยืนยันรายชื่อ still applies.
- **แก้ชื่อ** swaps the row's name for `<app-player-search-field>`, with `idPrefix="rename"`, `initialText` = the row's current name, and focus in the input. While typing, the host sees the same searchable list as manual add.
  - **Candidates come from `searchCandidates`.** `claimedIds` excludes this row's own player, so the row can be re-pointed at the same person or at any unclaimed one.
  - **Picking an existing player** calls `renameToExisting`. The row becomes `{ inputName: <the row's original parsed name>, match: { type: 'exact', playerId }, decision: 'accept' }`, and its level is dropped (existing players keep their stored level). Keeping the parsed name as `inputName` lets the server record it as an alias, exactly as accepting a fuzzy hit does today, so next week's paste of the same text matches on its own.
  - **Picking "add as new"** calls `renameToNew`. The row becomes `{ inputName: name, match: { type: 'new' }, decision: 'accept' }` and keeps a level the host had already picked. The duplicate check excludes this row's own current draft.
  - **A fuzzy similarity is never auto-linked.** It only ever appears as a candidate the host taps (the existing rule).
  - **Escape, tapping outside, or ยกเลิก** leaves the row as it was.
  - The row keeps its position and its list.
- Nothing here talks to the server until ยืนยันรายชื่อ. The confirm payload carries the edited reviews, and the server needs no change (it already takes `inputName` and `match` as sent).

| id | th | en |
|---|---|---|
| `entry.rename` | แก้ชื่อ | Rename |
| `entry.renameLabel` | ค้นหาชื่อผู้เล่น หรือพิมพ์ชื่อใหม่ | Search a player or type a new name |
| `entry.renameCancel` | ยกเลิก | Cancel |
| `entry.removedRow` | นำ {name} ออกแล้ว | Removed {name} |

- [x] **Step 1: Write failing tests**
  - `player-search-field.spec.ts`:
    - Typing shows ranked candidates.
    - Arrow keys and Enter pick a candidate (`pickExisting` emits the id).
    - The trailing option emits `pickNew` with the trimmed text.
    - Enter during IME composition does nothing.
    - With `initialText` set, the input starts with that text and the list is filtered by it.
    - Claimed players are excluded.
    - Ids follow `idPrefix`.
  - `GroupEntry`:
    - **Manual add is unchanged:** every existing manual-add spec passes as-is. Do not edit them.
    - **Remove from the roster:** removing a parsed row drops it, shows `entry.removedRow`, and `เลิกทำ` restores it at the same index.
    - **Remove from the waitlist:** removing a waitlist row works the same way.
    - **Remove below the minimum:** with 4 accepted rows, removing one disables ยืนยันรายชื่อ.
    - **Rename opens a search:** แก้ชื่อ on "ตั้ม 19.00" shows the search field holding "ตั้ม 19.00". Typing "ตั้ม" lists the existing player ตั้ม.
    - **Pick an existing player:** picking ตั้ม turns the row into `exact` on ตั้ม's id, with `inputName` "ตั้ม 19.00" and no level.
    - **Pick add-as-new:** typing "ตั้มใหม่" and picking it gives a `new` row with that name, the picked level kept, and the position kept.
    - **Collisions (Review Focus 6):**
      - A player another row has claimed is not offered.
      - Typing that player's exact name shows the already-selected message and changes nothing.
      - A name already drafted as new on another row shows the duplicate message.
    - **Own player stays offered:** while renaming a row already linked to ตั้ม, ตั้ม is still offered.
    - **Similar names:** a name only similar to a player is offered as a candidate but never linked unless tapped.
    - **Escape:** cancels and leaves the row as it was.
    - **Confirm payload:** after a rename and a removal, ยืนยันรายชื่อ posts `rosterReviews` reflecting both.
- [x] **Step 2: Run** `cd web && npx ng test --watch=false`. Expected: the new specs FAIL, and the existing manual-add specs still PASS (before and after the extraction).
- [x] **Step 3: Implement.** Extract the field first and run the suite (manual-add specs green), then add rename and remove. Extract i18n and add the English targets.
- [x] **Step 4: Run** `cd web && npx ng test --watch=false && npx ng build`. Expected: PASS.
- [x] **Step 5: Commit** with message `feat(web): searchable rename and remove for any name on the roster review`

### Task 9: Docs, full verification, and the owner's real-LINE check

**Files:**
- Modify:
  - `docs/overview.md`: one line in the roster-review description saying any row can now be renamed or removed before confirming (renames follow the manual-add matching rules, and fuzzy hits are only ever suggestions).
  - `docs/overview.md`: a new "LINE bot (phase 1)" section with the decisions list above, the routes, the retention rule, gating, and the fallback guarantee.
  - `CLAUDE.md`: add `line` to the server module list.
  - `docs/2026-10-06-pricing-tiers.md`: add the LINE bot to the Host column.
  - The spec's Status line: "phase 1 built; phase 2 pending the push-quota check".
- Move: this plan to `docs/archive/plans/` when every box is checked.

- [x] **Step 1: Run** `npm test` (repo root) with `SESSION_SECRET=test` set for the server suite, then `cd server && npm run lint`. Expected: everything passes, lint clean.
- [x] **Step 2: Browser check** on an isolated scratch DB and own ports (memory `reference-e2e-browser-setup`), at 390, 820 and 1180.
  - **Settings states:** not configured, not linked with a code, linked, free locked.
  - **Linking from the webhook side:** simulate the webhook with a locally signed `curl`: `/link CODE`, then a roster message.
  - **Roster entry:** the pre-fill with the provenance line, the stale warning, and a restored draft left alone.
  - **Roster review:** at 390, 820 and 1180, rename a row by searching (existing player, add as new, a similar name tapped), remove a row and undo it, check manual add still behaves the same, then confirm and check the session roster matches.
- [x] **Step 3: Write the owner's one-time LINE setup in `dockerDeploy.md`.**
  1. Create the Messaging API channel.
  2. Set the webhook URL to `https://jubbad.wongnok.dev/api/line/webhook` and turn "Use webhook" on.
  3. Turn auto-reply and greeting messages off.
  4. Allow the bot to join groups. A LINE group can hold only one Official Account, so a ก๊วน that already has another bot must remove it first.
  5. Put `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN` and `LINE_BOT_ADD_URL` in the server env.
  6. Run `npm run db:backup` before deploying the migration, then deploy.
  7. Press **Verify** next to the webhook URL in the LINE console. If it fails, check that Cloudflare (Bot Fight Mode or WAF rules) is not blocking LINE's requests to `/api/line/webhook`, and add a skip rule for that path if it is.
- [ ] **Step 4: Owner's real-LINE check** (manual, after deploy, on the owner's own group): link, post a roster, open start, and confirm the pre-fill. Then edit the roster message and confirm start shows the edited text, unsend it and confirm it disappears from start, and unlink and confirm the bot leaves the LINE group. Note the exact event type string LINE sends for an edit and fix Task 4 if it differs from `messageEdited`. Record the result in the spec.
- [ ] **Step 5: Archive this plan,** then commit with message `docs: LINE bot roster capture (phase 1)`

## Out of scope

- Phase 2 (weekly auto-post), until the LINE push-quota question in the spec is answered.
- Bot commands other than `/link`.
- Signing up or cancelling through the bot.
- Reading LINE history from before the bot joined.
- Warning when a newer roster has fewer names (the spec says that is a valid un-register).
