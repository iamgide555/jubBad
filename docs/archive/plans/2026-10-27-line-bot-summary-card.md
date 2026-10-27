# LINE Bot Session Summary Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** When the host ends a session on a linked, paid group, the LINE bot can post a Flex
Message card with the night's totals and a button to the public summary page; a card that did
not go out can be sent once later from the summary page.

**Architecture:** A pure card builder and a `LineSummaryService` live in the existing
`server/src/line/` module. The service gates on config, plan, link and finished games, and
sends exactly once through a claim on `Session.lineSummarySentAt`. `SessionsController.end`
calls it after the session lock has released. The web adds a projected checkbox to the end
dialog, a default switch in LINE settings, and an owner-only send button on the summary page.

**Tech Stack:** NestJS + Prisma 7 + SQLite (vitest, `fileParallelism: false`), Angular 22
zoneless standalone + signals (`ng test` on vitest), LINE Messaging API push + Flex Message.

**Spec:** `docs/archive/specs/2026-10-27-line-bot-summary-card-design.md` (builds on
`docs/archive/specs/2026-10-26-line-bot-roster-design.md`).

## Global Constraints

- Paid only: `planAtLeast(await plans.planForGroup(groupCode), 'host')`, read at request time.
- Every LINE call keeps `LineClient`'s 3s timeout. `LineClient` never throws.
- Ending a session never fails or rolls back because of LINE. The send runs after
  `SessionLock.run` has returned.
- At most one card per session, ever. The claim is `Session.lineSummarySentAt`.
- Owner-only routes refuse a non-owner with 404, via `OwnershipGuard` (no `@Public`).
- The public `GET /sessions/:code/summary` payload gains no field.
- The card is Thai only. Host-facing web strings are i18n'd (`th` source, `messages.en.xlf`
  targets).
- New env `PUBLIC_APP_URL`, https only, no trailing slash. Unset means the feature is off.
- Server specs: never touch `dev.db` owned by the owner's dev server. Use the suite's
  existing test DB setup, as the phase 1 `line-*.spec.ts` files do.

## Review Focus

1. A session with no date, no venue, or a group with no name: the card must still be valid
   LINE JSON. LINE rejects an empty `text`, so empty strings count as missing. Task 2 tests
   this.
2. A long group name or venue: `altText` must stay at 400 characters or fewer (LINE's
   limit). Task 2 tests this.
3. LINE times out or 5xx during end: the end still returns 200 with the session ended, the
   outcome is `failed`, and the claim is released so resend works. Task 4 tests this.
4. The group is unlinked, or the plan lapses, between opening the dialog and confirming: the
   end succeeds with outcome `unavailable` and nothing is pushed. Task 3 tests this.
5. A public viewer of the summary page calls `GET/POST /sessions/:code/line-summary`: 404.
   Task 3 tests this.

---

### Task 1: Schema, config and `LineClient.push`

**Files:**
- Modify: `server/prisma/schema.prisma` (Group, Session)
- Create: `server/prisma/migrations/20261027000000_line_summary_card/migration.sql`
- Modify: `server/src/line/line-config.ts`, `server/src/line/line-client.ts`, `server/.env.example`
- Test: `server/src/line/line-config.spec.ts`, `server/src/line/line-client.spec.ts`, `server/src/line/line-schema.spec.ts`

**Interfaces:**
- Produces: `Group.lineSummaryDefault Boolean @default(true)`, `Session.lineSummarySentAt DateTime?`.
- Produces: `LineConfig.publicAppUrl: string | null` (from `PUBLIC_APP_URL`; https only via the
  existing `httpsUrl`; one trailing `/` stripped).
- Produces: `export type LinePushOutcome = 'ok' | 'quota' | 'failed'` and
  `LineClient.push(lineGroupId: string, messages: unknown[]): Promise<LinePushOutcome>`. This is
  `POST /message/push` with body `{ to, messages }`. Any 2xx → `ok`. A 429 whose JSON `message`
  matches `/monthly limit/i` → `quota`. Everything else, including a timeout, a network error or
  a missing token → `failed`.

- [x] **Step 1: Write failing tests.**
  - `line-config.spec.ts`: `publicAppUrl` is `'https://jubbad.wongnok.dev'` for
    `PUBLIC_APP_URL=https://jubbad.wongnok.dev/`; `null` for `http://x`, `''` and unset.
  - `line-client.spec.ts`, using the existing fetch-stub pattern:
    - `push` posts to `https://api.line.me/v2/bot/message/push` with body `{ to: 'Cgroup', messages: [m] }` → `'ok'`.
    - A 429 `{ message: 'You have reached your monthly limit.' }` → `'quota'`.
    - A 429 with another message → `'failed'`.
    - A 500 → `'failed'`.
    - A fetch that rejects → `'failed'`.
    - No token → `'failed'` with fetch not called.
  - `line-schema.spec.ts`: a new group has `lineSummaryDefault === true`; a new session has
    `lineSummarySentAt === null`.
- [x] **Step 2: Run** `cd server && npx vitest run src/line/line-config.spec.ts src/line/line-client.spec.ts src/line/line-schema.spec.ts`.
  Expected: the new cases FAIL.
- [x] **Step 3: Implement.**
  - Add both columns and write the migration SQL: two `ALTER TABLE … ADD COLUMN`, the boolean
    `NOT NULL DEFAULT true`.
  - Run `npx prisma generate`.
  - Split `call()` so that one private helper returns `{ status: number; body } | null` and
    `call()` keeps its current contract on top of it. `push` reads the status.
  - Add `PUBLIC_APP_URL=` with a one-line comment to `.env.example`.
- [x] **Step 4: Run** the same command plus `npx prisma migrate deploy` against the test DB
  as the suite already does. Expected: PASS.
- [x] **Step 5: Commit** `feat(server): LINE push client, public app URL, summary card columns`.

### Task 2: Pure card builder

**Files:**
- Create: `server/src/line/line-summary-card.ts`
- Test: `server/src/line/line-summary-card.spec.ts`

**Interfaces:**
- Produces: `export interface SummaryCardInput { groupName: string | null; date: string | null; endedAt: Date; venue: string | null; players: number; games: number; url: string }`
- Produces: `export function summaryCard(input: SummaryCardInput): { type: 'flex'; altText: string; contents: Record<string, unknown> }`
- Produces: `export function cardDate(date: string | null, endedAt: Date): string`. It returns the
  trimmed `date` when it is non-empty (the session's free-text date from the roster header,
  shown as the summary page shows it). Otherwise it formats `endedAt` with `th-TH`,
  `timeZone: 'Asia/Bangkok'`, `{ day: 'numeric', month: 'short', year: 'numeric' }`.

Card layout: a `bubble` with:
- a header box: small text `สรุปก๊วน`, then the group name in bold. A missing or blank name
  falls back to `ก๊วน`.
- a body box of label/value rows: `วันที่` → `cardDate(...)`; `สนาม` → venue, with the row left
  out when the venue is null or blank; `ผู้เล่น` → `${players} คน`; `เกม` → `${games} เกม`.
- a footer with one primary `button`, action `{ type: 'uri', label: 'ดูสรุป', uri: url }`.

The builder picks colours from `DESIGN.md`'s primary. `altText` is
`สรุปก๊วน ${name} ${cardDate}`, cut to 400 characters.

- [x] **Step 1: Write failing tests**:
  - `full input`: walk `contents` and assert it contains texts `'สรุปก๊วน'`, `'ก๊วนพฤหัส'`,
    `'26 ต.ค.'`, `'Bad@Mama'`, `'18 คน'`, `'42 เกม'`. The footer button uri equals `url` and
    its label is `'ดูสรุป'`. `altText === 'สรุปก๊วน ก๊วนพฤหัส 26 ต.ค.'`.
  - `no venue`: `venue: null` and `venue: '  '` both leave out the `'สนาม'` label.
  - `no name`: `groupName: null` and `''` both give header text `'ก๊วน'`.
  - `no text is empty`: a recursive walk finds no `{ type: 'text', text: '' }` for every
    combination of null name, date and venue.
  - `altText cap`: a 500-character group name gives `altText.length <= 400`.
  - `cardDate`: `cardDate(null, new Date('2026-10-26T15:30:00Z'))` contains `'27'` and
    `'ต.ค.'` (Bangkok is already the next day). `cardDate('  ', d)` falls back the same way.
- [x] **Step 2: Run** `npx vitest run src/line/line-summary-card.spec.ts`. Expected: FAIL (module missing).
- [x] **Step 3: Implement** both functions.
- [x] **Step 4: Run** the same command. Expected: PASS. Then paste
  `JSON.stringify(summaryCard(sample).contents)` into LINE's Flex Message Simulator. Check it
  renders, and note in the ledger that the check was done.
- [x] **Step 5: Commit** `feat(server): LINE summary card builder`.

### Task 3: `LineSummaryService` and the owner routes

**Files:**
- Create: `server/src/line/line-summary.service.ts`, `server/src/line/line-summary.controller.ts`
- Modify: `server/src/line/line.module.ts` (provide + export `LineSummaryService`, add the controller)
- Test: `server/src/line/line-summary.spec.ts`; add to `server/src/auth/auth.boundary.spec.ts`

**Interfaces:**
- Consumes: `LineClient.push`, `lineConfig().publicAppUrl`, `summaryCard`, `PlansService.planForGroup`, `planAtLeast`.
- Produces: `export type LineSummaryOutcome = 'sent' | 'already-sent' | 'quota' | 'failed' | 'unavailable'`
- Produces: `export interface LineSummaryState { available: boolean; sent: boolean; defaultOn: boolean }`
- Produces: `LineSummaryService.state(sessionCode: string, now?: Date): Promise<LineSummaryState>`.
  `available` = the bot's secret and token are set, `publicAppUrl` is set,
  `group.lineGroupId` is set, the plan is at least host, and at least one finished game exists
  (`confirmedAt` and `endedAt` both set, the same filter as `getSummary`). It does **not**
  require the session to be ended, because the dashboard asks before ending. `sent` =
  `lineSummarySentAt !== null`. `defaultOn` = `group.lineSummaryDefault`.
- Produces: `LineSummaryService.send(sessionCode: string, now?: Date): Promise<LineSummaryOutcome>`:
  - Return `unavailable` unless `state().available` and `session.endedAt !== null`.
  - Claim with `updateMany({ where: { code, lineSummarySentAt: null }, data: { lineSummarySentAt: now } })`.
    A count of 0 returns `already-sent`.
  - Build the card. `players` = distinct ids across `teamA`/`teamB` (JSON strings) of the
    finished pairings. `games` = their count. `url` = `${publicAppUrl}/s/${code}/summary`.
  - Push. `ok` returns `sent`. Otherwise reset the column to null (only where it still equals
    `now`) and return `quota` or `failed`.
- Produces routes (owner-only, `@Controller('sessions')`):
  - `GET /sessions/:code/line-summary` → `LineSummaryState`.
  - `POST /sessions/:code/line-summary` → `{ outcome: LineSummaryOutcome }`.

- [x] **Step 1: Write failing tests** in `line-summary.spec.ts`. Use a real test DB with a
  group, an owner on plan `host`, a linked `lineGroupId`, an ended session with 2 finished
  pairings over 4 distinct players, and `LineClient` replaced by a stub that records calls:
  - `state` → `{ available: true, sent: false, defaultOn: true }`.
  - `send` → `'sent'`. The stub is called once with `'C…'` and a flex message whose
    altText starts with `'สรุปก๊วน'` and whose contents contain `'4 คน'` and `'2 เกม'`.
    `lineSummarySentAt` is set.
  - A second `send` → `'already-sent'`, with no second push.
  - Two concurrent `send`s (`Promise.all`) give exactly one push and the outcomes
    `['sent', 'already-sent']` in either order.
  - The stub returns `'failed'` → outcome `'failed'`, the column is back to null, and a later
    `send` with the stub on `'ok'` → `'sent'`.
  - The stub returns `'quota'` → `'quota'`, and the column is null.
  - Each of the following gives `unavailable`, no push, and `state().available === false`
    (except the session-not-ended case, where `state` stays available):
    - the owner's plan is `free`;
    - the group is unlinked;
    - `PUBLIC_APP_URL` is unset;
    - there are zero finished games;
    - the session is not ended.
- [x] **Step 2: Add to `auth.boundary.spec.ts`:** another user's cookie gets 404 on both
  `GET` and `POST /sessions/:code/line-summary`. With no cookie, both get 401 (or whatever
  this spec already expects for owner routes).
- [x] **Step 3: Run** `npx vitest run src/line/line-summary.spec.ts src/auth/auth.boundary.spec.ts`. Expected: FAIL.
- [x] **Step 4: Implement** the service, the controller and the module wiring. The module
  comment stays true, because LineModule still must not import GroupsModule or SessionsModule.
- [x] **Step 5: Run** the same command. Expected: PASS. Then run the full `npm test` in
  `server/`: specs that build `LineModule` may need nothing new; any that break get the
  same fix as phase 1 (import `LineModule`).
- [x] **Step 6: Commit** `feat(server): send the LINE summary card once per session`.

### Task 4: End session sends the card; the default setting on the server

**Files:**
- Modify: `server/src/sessions/sessions.controller.ts` (the `end` route), `server/src/sessions/sessions.module.ts` (import `LineModule`)
- Create: `server/src/sessions/dto/end-session.dto.ts` (follow the existing DTO folder and class-validator style)
- Modify: `server/src/line/line-link.service.ts` (`status` gains `summaryDefault`; new `setSummaryDefault`), `server/src/line/line.controller.ts` (new `PATCH`)
- Test: `server/src/sessions/end-session-line.spec.ts`, `server/src/line/line-link.spec.ts`

**Interfaces:**
- Consumes: `LineSummaryService.send`.
- Produces: `POST /sessions/:code/end` accepts an optional body `{ sendLineSummary?: boolean }`.
  The response is `{ code, endedAt }` as today, plus `lineSummary: LineSummaryOutcome` only
  when `sendLineSummary === true`. `send` is awaited in the controller **after**
  `sessionsService.endSession` resolves. It is never inside the lock, and its errors are
  caught as `'failed'`.
- Produces: `LineStatus.summaryDefault: boolean`.
- Produces: `PATCH /groups/:code/line` with body `{ summaryDefault: boolean }` →
  `{ summaryDefault }`. It requires the host plan (`plans.requireGroupPlan(code, 'host')`, the
  same error as `createCode`) and a linked group (409 `LINE_NOT_LINKED` otherwise).

- [x] **Step 1: Write failing tests:**
  - `end-session-line.spec.ts` (same fixture shape as Task 3, with a stubbed `LineClient`):
    - End with `{ sendLineSummary: true }` → 201, body `lineSummary: 'sent'`, the session is
      ended, one push.
    - End with `{}` → no `lineSummary` key and no push.
    - The stub push returns `'failed'`, or `send` itself throws → the end is still 201, the
      session is ended, and `lineSummary: 'failed'`.
    - End on an unlinked group with `sendLineSummary: true` → 201 with `lineSummary: 'unavailable'`.
  - `line-link.spec.ts`:
    - `status().summaryDefault` is `true` by default.
    - `setSummaryDefault(code, false)` persists.
    - It throws the plan error on `free` and `LINE_NOT_LINKED` when unlinked.
- [x] **Step 2: Run** `npx vitest run src/sessions/end-session-line.spec.ts src/line/line-link.spec.ts`. Expected: FAIL.
- [x] **Step 3: Implement.** Existing end-session specs post no body. Keep them passing,
  because the DTO is fully optional.
- [x] **Step 4: Run** those two files, then the full `npm test` and `npm run lint` in `server/`.
  Expected: PASS and clean.
- [x] **Step 5: Commit** `feat(server): end session can post the LINE summary card; default setting`.

### Task 5: Web — models, service, settings switch

**Files:**
- Modify: `web/src/app/core/line.model.ts`, `web/src/app/core/line.service.ts`
- Modify: `web/src/app/pages/group-settings-detail/group-settings-detail.{ts,html}`
- Test: `web/src/app/core/line.service.spec.ts` (create it if missing), `web/src/app/pages/group-settings-detail/group-settings-detail.spec.ts`

**Interfaces:**
- Produces in `line.model.ts`: `LineSummaryOutcome`, `LineSummaryState` (mirror Task 3), and `LineStatus.summaryDefault: boolean`.
- Produces in `LineService`:
  - `summaryState(sessionCode: string): Observable<LineSummaryState>`
  - `sendSummary(sessionCode: string): Observable<{ outcome: LineSummaryOutcome }>`
  - `setSummaryDefault(groupCode: string, on: boolean): Observable<{ summaryDefault: boolean }>`

The settings switch goes only in the `line.linked && paid` branch, after `@@line.linkedHint`.
It uses the existing `switch-row` markup:
- `name="lineSummaryDefault"`, `data-summary-default`.
- Title `ส่งสรุปเข้ากลุ่ม LINE เมื่อจบรอบ` (`@@line.summaryDefault`).
- Hint `ค่าเริ่มต้นของช่องติ๊กตอนกดจบรอบ เปลี่ยนได้ทุกครั้ง` (`@@line.summaryDefaultHint`).

On change it calls `setSummaryDefault`. On failure it reverts the switch and shows the error
in the existing `lineError()` line.

- [x] **Step 1: Write failing tests:**
  - Service URLs: `GET`/`POST /api/sessions/S1/line-summary` and `PATCH /api/groups/G1/line`
    with `{ summaryDefault: false }`.
  - Settings: the switch is checked when `summaryDefault: true`. Toggling sends `PATCH false`.
    A failed PATCH leaves it checked and shows the error. The switch is absent when paused
    (linked, free) and when unlinked.
- [x] **Step 2: Run** the web tests for those two specs, the same way phase 1 ran single web
  specs. Expected: FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** the same specs. Expected: PASS.
- [x] **Step 5: Commit** `feat(web): LINE summary default switch in group settings`.

### Task 6: Web — end dialog checkbox

**Files:**
- Modify: `web/src/app/shared/shuttle-details-dialog/shuttle-details-dialog.html` (add `<ng-content />` after `.shuttle-fields`, before the error line)
- Modify: `web/src/app/core/live-session.service.ts` (`endSession`)
- Modify: `web/src/app/pages/session-dashboard/session-dashboard.{ts,html}`
- Test: `web/src/app/pages/session-dashboard/session-dashboard.spec.ts` (or the spec that already covers `confirmEndSession`), `web/src/app/shared/shuttle-details-dialog/shuttle-details-dialog.spec.ts`

**Interfaces:**
- Consumes: `LineService.summaryState`, `LineSummaryOutcome`.
- Produces: `LiveSessionService.endSession(sendLineSummary = false): Promise<ActionResult & { lineSummary?: LineSummaryOutcome }>`.
  It posts `{ sendLineSummary: true }` only when the flag is true, and `{}` otherwise.
  `lineSummary` is carried through from the response; extend the `post()`/`fillDetails`
  pass-through rather than duplicating the error handling.
- Produces: the dashboard navigates to the summary with `{ state: { lineSummary } }` when
  there is an outcome.

Dashboard:
- `openEndSession()` also loads `summaryState(code)` into `lineSummary = signal<LineSummaryState | null>(null)`.
  A failed load gives `null`, which means no checkbox; ending must never wait on this load.
- `sendLineSummary = signal(false)` is set to `defaultOn` when the state arrives.
- The projected content, shown only when `lineSummary()?.available && !lineSummary()?.sent`,
  is a `switch-row` checkbox `name="sendLineSummary"`, `data-send-line-summary`, labelled
  `ส่งสรุปเข้ากลุ่ม LINE` (`@@dashboard.sendLineSummary`) and disabled while
  `endSessionBusy()`.
- `confirmEndSession` passes `this.lineSummary()?.available === true && this.sendLineSummary()`.

- [x] **Step 1: Write failing tests:**
  - The dialog renders projected content.
  - The dashboard:
    - The checkbox is absent when the state is `available: false`, when the load fails, and
      when `sent: true`.
    - It is present and checked when the state is `{ available: true, sent: false, defaultOn: true }`,
      and unchecked when `defaultOn: false`.
    - Confirming with it checked calls `endSession(true)`; unchecking it calls `endSession(false)`.
    - Navigation carries `state.lineSummary` when the result has one.
- [x] **Step 2: Run** those specs. Expected: FAIL.
- [x] **Step 3: Implement.** Existing dashboard specs that open the end dialog need a
  `LineService` stub (`summaryState` → `available: false`), the same fix as phase 1's
  `noLineBot`.
- [x] **Step 4: Run** those specs. Expected: PASS.
- [x] **Step 5: Commit** `feat(web): end dialog can send the LINE summary card`.

### Task 7: Web — summary page send-once button and outcome line

**Files:**
- Modify: `web/src/app/pages/session-summary/session-summary.{ts,html}`
- Test: `web/src/app/pages/session-summary/session-summary.spec.ts`

**Interfaces:**
- Consumes: `LineService.summaryState`, `LineService.sendSummary`, the router navigation `state.lineSummary`.

Behaviour:
- Only when `owner()` is true (the existing inventory-based check) does the page load
  `summaryState(code)`.
- The outcome from navigation state, or from a button press, shows in a `role="status"` line
  (`data-line-summary-outcome`):
  - `sent` and `already-sent` → `ส่งสรุปเข้ากลุ่ม LINE แล้ว` (`@@summary.lineSent`)
  - `quota` → `โควตาข้อความ LINE เดือนนี้หมดแล้ว ส่งสรุปไม่ได้` (`@@summary.lineQuota`)
  - `failed` → `ส่งสรุปเข้ากลุ่ม LINE ไม่สำเร็จ ลองอีกครั้งได้` (`@@summary.lineFailed`)
  - `unavailable` → `ส่งสรุปไม่ได้ กลุ่มยังไม่ได้เชื่อม LINE หรือแพ็กเกจหมดอายุ` (`@@summary.lineUnavailable`)
- The button `data-send-line-summary`, `ส่งสรุปเข้ากลุ่ม LINE` (`@@summary.sendLine`), shows
  when the state is `available && !sent`. It is disabled while sending. After `sent` or
  `already-sent` the state becomes `sent: true`, so the button disappears.
- With no outcome and `sent: true`, the page shows the `@@summary.lineSent` line and no button.

- [x] **Step 1: Write failing tests:**
  - A non-owner makes no `line-summary` request and sees no button.
  - An owner with `available: true, sent: false` sees the button. Pressing it with the
    service returning `sent` shows the sent line and removes the button.
  - `quota` keeps the button and shows the quota line.
  - Navigation state `{ lineSummary: 'failed' }` shows the failed line on load.
  - `sent: true` shows the sent line and no button.
- [x] **Step 2: Run** the spec. Expected: FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** the spec. Expected: PASS.
- [x] **Step 5: Commit** `feat(web): send the LINE summary card from the summary page`.

### Task 8: Locale, docs, full verification

**Files:**
- Modify: `web/src/locale/messages.xlf`, `web/src/locale/messages.en.xlf` (extract the new ids and add English targets)
- Modify: `docs/overview.md` (a LINE section paragraph for the summary card), `dockerDeploy.md` (`PUBLIC_APP_URL` in the LINE setup), `docs/superpowers/specs/2026-10-26-line-bot-weekly-post-design.md` (a quota bullet: the summary card shares the push quota, about 86 more a month per 20-member group), `CLAUDE.md` only if a module line changes (it should not)
- Modify: the spec's status line → built

English targets:

| Thai | English |
|---|---|
| ส่งสรุปเข้ากลุ่ม LINE | Send summary to LINE group |
| ส่งสรุปเข้ากลุ่ม LINE เมื่อจบรอบ | Send summary to LINE when ending |
| ค่าเริ่มต้นของช่องติ๊กตอนกดจบรอบ เปลี่ยนได้ทุกครั้ง | Default for the checkbox when you end a session; you can change it each time |
| ส่งสรุปเข้ากลุ่ม LINE แล้ว | Summary sent to LINE group |
| โควตา…ส่งสรุปไม่ได้ | LINE's message quota for this month is used up; summary not sent |
| ส่ง…ไม่สำเร็จ ลองอีกครั้งได้ | Couldn't send the summary to LINE; you can try again |
| ส่งสรุปไม่ได้ กลุ่มยังไม่ได้เชื่อม… | Can't send: the group isn't linked to LINE or the plan has lapsed |

- [x] **Step 1: Extract** the i18n ids the way phase 1 did, and add the English targets above.
- [x] **Step 2: Edit the docs** listed.
- [x] **Step 3: Run** the root `npm test` (engines, server, web), `cd server && npm run lint`, and `cd web && npm run build`. Expected: all pass, lint clean, build OK with no missing-translation warnings for the new ids.
- [x] **Step 4: Commit** `docs: LINE summary card (overview, deploy, quota note); i18n`.

## After the plan

- Browser check on a scratch DB and my own ports, as for phase 1.
- Real-LINE check: the owner runs the tunnel and I run a scratch API with the owner's local
  LINE env plus `PUBLIC_APP_URL` set to the tunnel URL. Check:
  - end with the box ticked → the card appears in the test group and its button opens the summary;
  - end with the box unticked → no card, then the summary page button → the card, and the button is gone.
- Merge, push and deploy only with the owner's OK. The deploy adds
  `PUBLIC_APP_URL=https://jubbad.wongnok.dev` to the server `.env` and runs the migration
  after a backup.
