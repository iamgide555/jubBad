# LINE host link (roster by DM) Implementation Plan

> **Archived 2026-10-28.** Executed the same day with subagent-driven development (each task reviewed, then a whole-branch review); checkboxes are not ticked retroactively. The owner's first real-phone test replaced the per-account model in Tasks 2-9 with a per-group switch (`Group.lineDmEnabled`, group-scoped routes, two-card settings page); the spec's revision section is the final word, and the OwnershipGuard change in Task 4 was reverted.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host links their own LINE account by DM and sends rosters to the bot in a 1:1 chat, so groups that already have another bot (LINE allows one per group) still get roster pre-fill.

**Architecture:** A new `LineHostService` owns the user-level link (code, redeem, unlink). A new `LineHostRosterService` handles a DM roster (store directly for one group, park in `LinePendingRoster` and ask with Quick Reply for several). `LineWebhookService.dispatch()` gains a `source.type === 'user'` branch plus `postback`, `follow`, `unfollow`. `LineRosterService.latest()` is relaxed so a group whose owner has a host link also pre-fills start. Web gets a `LineHostLinkPanel` in the existing LINE settings section.

**Tech Stack:** NestJS + Prisma + SQLite + vitest (server), Angular standalone + signals + Angular i18n (web), LINE Messaging API.

**Spec:** `docs/superpowers/specs/2026-10-28-line-host-dm-roster-design.md`

## Global Constraints

- Replies only (`replyToken`), never `push`, for everything the host path sends: a reply is free, a push spends quota.
- Quick Reply: at most 13 buttons, label at most 20 characters, postback `data` at most 300 characters. The roster text never rides in `data`.
- Host code: 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, single use, 10 minute expiry, SHA-256 hash stored, never the code. One live code per user (a new code voids the old).
- Pending roster: one per host (`userId` unique), expires after 10 minutes, a newer DM replaces it.
- Only roster-shaped text (`isRosterMessage`) is ever stored. Nothing else from a DM is stored or logged. The webhook never logs message text or codes.
- Paid plan (Host+) is checked on the chosen group's owner at read time (`PlansService.planForGroup`); a lapse stops capture, never removes the link. Unlink is always allowed.
- Summary card, `LineSummaryService` and every push stay keyed to `Group.lineGroupId`. Do not touch them.
- Server specs run with `fileParallelism: false`; do not change that. New specs follow `server/src/line/line-link.spec.ts` (real `PrismaModule`, `LineClient` overridden with a fake, users tagged by `randomUUID()`).
- Thai-primary UI: every user-facing string in web gets an `i18n` id (`@@line.host.*`) and an entry in **both** `web/src/locale/messages.xlf` and `web/src/locale/messages.en.xlf`. Bot replies are Thai only (they speak into a Thai LINE chat), like `linkedText` today.
- Match surrounding code: comment density, naming, `.js` import suffixes on the server.

## Review Focus

- Postback from a different LINE user than the pending row's owner (forged or stale button): must be refused, nothing moved.
- Postback after the pending roster expired, was replaced by a newer DM, or the group was deleted or transferred meanwhile: refused with the "send it again" reply, nothing stored.
- A host who owns a group with a lapsed plan tapping that group's button: refused, nothing stored.
- Host whose group name is longer than 20 characters or empty: the button label is truncated or falls back to the group code, never an LINE API 400.
- Two DMs in a row (or LINE redelivering the same event): one `LineRosterMessage` (unique `lineMessageId` holds), no duplicate reply side effects.
- `/link` with a code belonging to the group-link flow, or a LINE user already linked: generic failure, no leak of which case.

---

### Task 1: Schema and migration

**Files:**
- Modify: `server/prisma/schema.prisma` (User, `LineRosterMessage.direct`, add two models)
- Create: `server/prisma/migrations/20261028000000_line_host_dm/migration.sql` (generate with `npx prisma migrate dev --name line_host_dm --create-only` from `server/`, then review the SQL)
- Test: `server/src/line/line-schema.spec.ts` (extend)

**Interfaces:**
- Produces: `LineRosterMessage.direct Boolean @default(false)` (true for a row captured from a host DM); `User.lineUserId String? @unique`, `User.lineLinkedAt DateTime?`; model `LineUserLinkCode { id, userId, user (onDelete Cascade), codeHash @unique, expiresAt, usedAt?, createdAt, @@index([userId]) }`; model `LinePendingRoster { id, userId @unique (onDelete Cascade), text, lineMessageId, postedAt, createdAt }`. Add the back-relations `User.lineUserLinkCodes` and `User.linePendingRoster`.

- [ ] **Step 1: Write failing schema tests** in `line-schema.spec.ts`, following that file's style: `lineUserId` is unique across two users (second create rejects with `P2002`); `LineRosterMessage.direct` defaults to false; a `LinePendingRoster` for the same `userId` twice rejects with `P2002`; deleting a user cascades its `LineUserLinkCode` and `LinePendingRoster` rows.
- [ ] **Step 2: Run** `cd server && npx vitest run src/line/line-schema.spec.ts` — expect FAIL (unknown fields/models).
- [ ] **Step 3: Edit `schema.prisma`**, generate the migration with `--create-only`, read the SQL (additive only: two columns, a unique index, two tables), then `npx prisma migrate dev` and `npx prisma generate`.
- [ ] **Step 4: Run** the same spec — expect PASS.
- [ ] **Step 5: Commit** `feat(line): schema for host link and pending roster`.

---

### Task 2: LineClient — Quick Reply replies

**Files:**
- Modify: `server/src/line/line-client.ts`
- Test: `server/src/line/line-client.spec.ts` (extend)

**Interfaces:**
- Produces: `LineClient.replyMessages(replyToken: string, messages: unknown[]): Promise<void>` (same timeout, never throws, no-op without a token). Export `groupChoiceMessage(text: string, choices: { label: string; data: string }[]): unknown` from the same file, building one text message whose `quickReply.items` are `{ type: 'action', action: { type: 'postback', label, data, displayText: label } }`, label truncated to 20 characters.

- [ ] **Step 1: Write failing tests** in `line-client.spec.ts` (mirror the existing `reply` tests that stub `fetch`): `replyMessages` POSTs `/message/reply` with the given messages array; `groupChoiceMessage` truncates a 30-character label to 20 characters, keeps `data` untouched, and produces a `postback` action per choice.
- [ ] **Step 2: Run** `npx vitest run src/line/line-client.spec.ts` — expect FAIL.
- [ ] **Step 3: Implement** both in `line-client.ts`. `reply()` keeps its signature and may delegate to `replyMessages`.
- [ ] **Step 4: Run** the spec — expect PASS.
- [ ] **Step 5: Commit** `feat(line): quick reply messages in LineClient`.

---

### Task 3: LineHostService — link code, redeem, status, unlink

**Files:**
- Create: `server/src/line/line-host.service.ts`, `server/src/line/line-code.ts`
- Modify: `server/src/plans/plans.service.ts`, `server/src/line/line-link.service.ts` (import the shared code helpers), `server/src/line/line.module.ts` (provider and export), `server/src/line/line-purge.ts` (call the new purge in `tick()`)
- Test: `server/src/line/line-host.spec.ts` (new)

**Interfaces:**
- Consumes: new `PlansService.planForUser(userId: string, now?: Date): Promise<Plan>` and `PlansService.requireUserPlan(userId: string, required: PaidPlan): Promise<void>` — add both to `server/src/plans/plans.service.ts` (modify it, test in `server/src/plans/plans.service.spec.ts` if one exists, else in `line-host.spec.ts`), mirroring `planForGroup` / `requireGroupPlan` but looking the owner up by user id (a missing user resolves like a missing group does today).
- Produces (all on `LineHostService`):
  - `status(userId: string): Promise<{ configured: boolean; botAddUrl: string | null; linked: boolean; linkedAt: string | null }>`
  - `createCode(userId: string, now?: Date): Promise<{ code: string; expiresAt: string }>` — throws `ServiceUnavailableException({ code: 'LINE_NOT_CONFIGURED' })` without secret/token, `ConflictException({ code: 'LINE_ALREADY_LINKED' })` when already linked, requires a Host+ plan via `PlansService.requireUserPlan(userId, 'host')`. Deletes the user's unused codes then creates one, in one transaction.
  - `redeem(lineUserId: string, rawCode: string, now?: Date): Promise<{ userId: string } | null>` — null for every refusal (bad shape, unknown/used/expired code, lapsed plan, LINE user already linked to someone, user already linked, lost race). Claim-and-bind in one transaction, mirroring `LineLinkService.redeem`.
  - `unlink(userId: string): Promise<void>` — clears `lineUserId`/`lineLinkedAt`, deletes the user's codes and pending roster, any plan.
  - `userForLineUser(lineUserId: string): Promise<{ id: string } | null>`
  - `purgeExpired(now?: Date): Promise<void>` — expired/used codes older than a day, and pending rosters past their 10 minutes.

- [ ] **Step 1: Write failing tests** in `line-host.spec.ts`: `createCode` returns a 6-character code from the alphabet and stores only its SHA-256 hash; a second `createCode` voids the first; `createCode` refuses a `free` user (403) and an already-linked user (409); `redeem` binds `lineUserId` and sets `lineLinkedAt`; `redeem` returns null for wrong code, used code, expired code (`now` past 10 minutes), a code whose owner lapsed to free, a LINE user already linked to a different JubBad user, and a group-link code (hash exists only in `LineLinkCode`); two simultaneous `redeem`s of one code bind exactly once; `unlink` clears the link and deletes pending roster and codes and works for a `free` user; `purgeExpired` removes a pending roster older than 10 minutes and keeps a fresh one.
- [ ] **Step 2: Run** `npx vitest run src/line/line-host.spec.ts` — expect FAIL.
- [ ] **Step 3: Implement** `LineHostService` per the signatures. Copy the alphabet, TTL and hashing helpers from `line-link.service.ts` by extracting them into a small shared file `server/src/line/line-code.ts` (`CODE_ALPHABET`, `CODE_LENGTH`, `CODE_TTL_MS`, `hashCode`, `normalizeCode`, `newCode()`), and make `LineLinkService` import from it (no behavior change; its spec must stay green).
- [ ] **Step 4: Wire** the provider and export in `line.module.ts`, and call `purgeExpired()` in `LinePurgeScheduler.tick()`.
- [ ] **Step 5: Run** `npx vitest run src/line` — expect PASS (host spec and the unchanged link spec).
- [ ] **Step 6: Commit** `feat(line): host link service`.

---

### Task 4: Host link HTTP routes

**Files:**
- Create: `server/src/line/line-host.controller.ts`
- Modify: `server/src/line/line.module.ts` (controller)
- Test: `server/src/line/line-host.spec.ts` (extend with supertest cases, like `line-link.spec.ts` does for `LineController`), `server/src/auth/auth.boundary.spec.ts` (check, see step 3)

**Interfaces:**
- Consumes: `LineHostService` from Task 3; `AuthenticatedRequest` from `../auth/auth.guard.js` (`req.user.id`).
- Produces: authenticated, user-scoped (no `:code`) routes `GET /line/host` → `status`, `POST /line/host/code` → `createCode`, `DELETE /line/host` → `{ unlinked: true }`. Controller path prefix `line/host`; not `@Public`.

- [ ] **Step 1: Write failing tests**: each route returns the service result for the signed-in user; an unauthenticated request is 401; `POST /line/host/code` for a free user is 403; `DELETE` works for a free user.
- [ ] **Step 2: Run** `npx vitest run src/line/line-host.spec.ts` — expect FAIL.
- [ ] **Step 3: Implement** the controller and register it. Run `npx vitest run src/auth/auth.boundary.spec.ts`; if it enumerates routes, add the three new ones as authenticated (not public) exactly as it treats `groups/:code/line`.
- [ ] **Step 4: Run** `npx vitest run src/line src/auth` — expect PASS.
- [ ] **Step 5: Commit** `feat(line): host link routes`.

---

### Task 5: LineHostRosterService — store, ask, choose

**Files:**
- Create: `server/src/line/line-host-roster.service.ts`
- Modify: `server/src/line/line.module.ts`
- Test: `server/src/line/line-host-roster.spec.ts` (new)

**Interfaces:**
- Consumes: `LineHostService.userForLineUser`, `isRosterMessage` from `../../../engines/line-roster.ts`, `planAtLeast`/`PlansService.planForGroup`, `groupChoiceMessage` (Task 2), `LineRosterService.purgeGroup` is private — call `LineRosterService.purge(now)` is global; instead add a public `LineRosterService.purgeFor(groupCode: string, now?: Date): Promise<void>` that the private `purgeGroup` becomes (rename, keep behavior) and use it here.
- Produces:
  - `receive(input: { lineUserId: string; lineMessageId: string; text: string; postedAt: Date }): Promise<HostReply>` where `type HostReply = { kind: 'text'; text: string } | { kind: 'messages'; messages: unknown[] }`. Outcomes: unlinked LINE user → text "link first" (names the web path `JubBad > ตั้งค่ากลุ่ม > กลุ่ม LINE`); not roster-shaped → "does not look like a roster"; owns no group or no owned group is on a Host+ plan → text with the reason; exactly one eligible group → store a `LineRosterMessage` (`groupId` = that group, `senderName` null, `senderUserId` = the LINE user id, `botPosted` false, `direct` true), purge that group, text confirmation naming the group; two or more → upsert `LinePendingRoster` and return `groupChoiceMessage` with one choice per eligible group, `data = pr:<pendingId>:<groupCode>`, label = group name or the code if the name is empty. A duplicate `lineMessageId` (P2002) returns the same confirmation without a second row. More than 13 eligible groups: offer only the 13 most recently created groups (a better pick for more than 13 is out of scope; no such host exists today).
  - `choose(input: { lineUserId: string; data: string; now?: Date }): Promise<{ kind: 'text'; text: string }>` — parses `pr:<pendingId>:<groupCode>`; refuses (one generic "send the roster again" text, nothing stored) when: data malformed, pending row missing/expired/not this user's, group missing, group not owned by the pending row's user, or group not on Host+ now. On success moves the text into `LineRosterMessage` (`postedAt` from the pending row), deletes the pending row, purges the group, confirms with the group name.
  - "Eligible group": groups where `ownerId` is the host's user id and `planForGroup` is at least `host`. The plan is the owner's, so check once per host.

- [ ] **Step 1: Write failing tests** covering each outcome above: unlinked sender; non-roster text (nothing stored); host with zero groups; one group stores directly with `senderName` null; two groups creates a pending row and returns quick-reply messages whose postback data parses back; a second DM replaces the pending row; `choose` stores and deletes pending; `choose` refuses (and stores nothing) for another LINE user's tap, an expired pending row (`now` +11 minutes), a replaced pending id, a deleted group, a group whose owner lapsed to free; redelivering the same `lineMessageId` yields one row; a 25-character group name is truncated in the button label only; 14 eligible groups yields 13 buttons.
- [ ] **Step 2: Run** `npx vitest run src/line/line-host-roster.spec.ts` — expect FAIL.
- [ ] **Step 3: Implement** the service and the `purgeFor` rename; wire into `line.module.ts`.
- [ ] **Step 4: Run** `npx vitest run src/line` — expect PASS (existing roster spec stays green after the rename).
- [ ] **Step 5: Commit** `feat(line): host DM roster capture and group choice`.

---

### Task 6: Webhook — DM, postback, follow, unfollow

**Files:**
- Modify: `server/src/line/line-webhook.service.ts`
- Test: `server/src/line/line-webhook.spec.ts` (extend, using its `post`/`sign` helpers and the fake `LineClient`; add `replyMessages: vi.fn()` to the fake)

**Interfaces:**
- Consumes: `LineHostService.redeem`/`userForLineUser`, `LineHostRosterService.receive`/`choose` (Task 5), `LineClient.reply`/`replyMessages`.
- Produces: `LineEvent` gains `postback?: { data?: string }`; `source.type` may be `'user'`. In `dispatch()` a `user` source routes to a new private `dispatchDirect(event)`; the group path is unchanged byte for byte.

Behavior of `dispatchDirect`:
- `message` text matching the `/link <code>` command (reuse `LINK_COMMAND`): throttle key `line:user:<userId>` with the existing `LoginThrottle`; `LineHostService.redeem`; reply a Thai confirmation on success or `LINK_FAILED_TEXT`-style generic Thai failure (host wording: `รหัสไม่ถูกต้องหรือหมดอายุ ตรวจรหัสได้ที่ JubBad > ตั้งค่ากลุ่ม > กลุ่ม LINE`, same string is fine).
- any other `message` text: `LineHostRosterService.receive`, then reply with its result (`text` → `reply`, `messages` → `replyMessages`).
- `postback`: `LineHostRosterService.choose`, reply text.
- `follow`: reply a short Thai greeting explaining how to link. `unfollow`: delete the user's `LinePendingRoster` (no reply possible), keep the link.
- `messageEdited` and `unsend` from a DM are ignored.
- No `replyToken`: skip the reply silently. Never log text, codes or postback data; a failure is logged by event type only (existing `handleEvent` behavior).

- [ ] **Step 1: Write failing tests** through the HTTP endpoint: DM `/link` with a valid host code links the account and replies; wrong code replies the generic failure and 6th+ bad tries from one user are silently dropped like the group throttle; DM roster from a linked one-group host stores a row and replies; stranger DM replies "link first" and stores nothing; DM from a linked host with two groups replies with quick-reply messages; a `postback` event for that pending id stores the row for the tapped group; a forged postback from another LINE user stores nothing; `follow` replies a greeting; `unfollow` deletes the pending row but keeps `lineUserId`; a DM `unsend` does not delete a stored row; existing group events behave exactly as before (the whole existing spec stays green).
- [ ] **Step 2: Run** `npx vitest run src/line/line-webhook.spec.ts` — expect FAIL on the new cases.
- [ ] **Step 3: Implement** `dispatchDirect` and the `postback`/`follow`/`unfollow` cases per the behavior list.
- [ ] **Step 4: Run** `npx vitest run src/line` — expect PASS.
- [ ] **Step 5: Commit** `feat(line): webhook handles host direct messages`.

---

### Task 7: Pre-fill gate — group owner with a host link

**Files:**
- Modify: `server/src/line/line-roster.service.ts` (`latest()` and the `LatestRoster` interface gain `direct: boolean`)
- Test: `server/src/line/line-roster.spec.ts` (extend)

**Interfaces:**
- Consumes: `Group.owner.lineUserId`.
- Produces: `LineRosterService.latest(groupCode, now?)` returns the newest `LineRosterMessage` for the group when the group has `lineGroupId` **or** its owner has `lineUserId`; still null on a plan below Host, no rows, or neither link. `LatestRoster.direct` is the newest row's `direct` column. `capture()`/`edit()` (group events) stay gated by `lineGroupId` exactly as now.

- [ ] **Step 1: Write failing tests**: a group with no `lineGroupId` whose owner has `lineUserId` and a stored row returns it; same group, owner without `lineUserId` returns null; a lapsed owner returns null; a group with both links returns the newest row across a group-captured row and a DM-captured row; `stale` still follows `rosterStaleness`.
- [ ] **Step 2: Run** `npx vitest run src/line/line-roster.spec.ts` — expect FAIL.
- [ ] **Step 3: Implement** the gate change in `latest()` (include `owner: { select: { lineUserId: true } }` in the group lookup).
- [ ] **Step 4: Run** `npx vitest run src/line` — expect PASS.
- [ ] **Step 5: Commit** `feat(line): start pre-fills from host DM rosters`.

---

### Task 8: Web — "Link me" panel and DM label

**Files:**
- Modify: `web/src/app/core/line.model.ts`, `web/src/app/core/line.service.ts`, `web/src/app/core/line.service.spec.ts`, `web/src/app/pages/group-settings-detail/group-settings-detail.html` and `.ts` (embed the panel in the `line` case), `web/src/app/pages/group-entry/group-entry.ts` (roster banner name at lines ~340 and ~346), `web/src/locale/messages.xlf`, `web/src/locale/messages.en.xlf`
- Create: `web/src/app/pages/group-settings-detail/line-host-link-panel.ts` (+ `.html`, `.css`, `.spec.ts`), a standalone component `app-line-host-link-panel` styled after `app-share-dashboard-panel`

**Interfaces:**
- Consumes: server routes from Task 4.
- Produces: `LineHostStatus { configured: boolean; botAddUrl: string | null; linked: boolean; linkedAt: string | null }`; `LineService.hostStatus(): Observable<LineHostStatus>`, `hostCreateCode(): Observable<LineLinkCode>`, `hostUnlink(): Observable<{ unlinked: true }>` (URLs `${environment.apiBaseUrl}/line/host`, `/line/host/code`). `LatestRoster` gains `direct: boolean` (server `LineRosterService.latest()` copies the row's `direct` column; web mirror in `line.model.ts`). When `direct` is true the banner shows `$localize\`:@@entry.lineDirect:ส่งทางข้อความส่วนตัว\`` instead of the sender name / `@@entry.lineUnknown`.

- [ ] **Step 1: Write failing tests**: `line.service.spec.ts` — the three host calls hit the right URL and method; panel spec — shows the add-bot link and a generated code with minutes left, copy button, linked state with unlink confirm, the "not configured" and load-failed states, and shows a lock hint for an unpaid user when code creation answers 403 (reuse the pattern and components the group section uses: `app-plan-lock`, `linePausedHint` style); `group-entry` spec — a roster with `direct: true` shows the direct-message label instead of "ไม่ทราบชื่อ".
- [ ] **Step 2: Run** `cd web && npm test -- --include='**/line*.spec.ts' --include='**/group-entry*.spec.ts'` (Angular's vitest builder; adjust the include syntax to what `ng test` accepts) — expect FAIL.
- [ ] **Step 3: Implement** the model/service additions, the panel (keep it self-contained; the settings component only renders it under the existing group-link block with a short heading "ผูกบัญชี LINE ของฉัน"), the `direct` field end to end (server `LatestRoster` + route response), and both xlf entries for every new `@@line.host.*` and `@@entry.lineDirect` id.
- [ ] **Step 4: Run** `cd web && npm test` and `npm run build` — expect PASS and a clean build (the build fails on a missing translation id, which is the check that both xlf files were updated).
- [ ] **Step 5: Commit** `feat(web): link my LINE account and show DM rosters`.

---

### Task 9: Docs, full suite, real-LINE check

**Files:**
- Modify: `docs/overview.md` (LINE bot rows), `docs/superpowers/specs/2026-10-28-line-host-dm-roster-design.md` (status line)
- Create: nothing

- [ ] **Step 1: Update `docs/overview.md`** — add to the existing 2026-10-26 annotations on the "no bot" and "no passive listener" rows: a DM with the bot (host-linked) is the path for groups that already have another bot, LINE allows one Official Account per group, and why the summary card stays group-only.
- [ ] **Step 2: Run the whole suite**: `npm test` from the repo root — expect all three suites PASS. Also `cd server && npm run lint`.
- [ ] **Step 3: Real-LINE check** (needs the owner's phone, not automatable): link by DM from the settings code; forward a roster from a group that has another bot; one-group auto-store; two-group Quick Reply tap; stranger DM; unlink. Record the outcome in the spec's status line. Deploy follows the existing home-server procedure (backup, migration, rebuild) and is the owner's call.
- [ ] **Step 4: Commit** `docs: LINE host DM path`.
