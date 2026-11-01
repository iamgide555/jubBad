# Collector LINE Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The receiving-account owner ("collector") manages a bill's payments (check slips, tick, close) from the LINE status page, identified by LINE identity only.

**Architecture:** A collector player id is stored per group (new column) and, for a night account, on the confirmed payment card. A `CollectorService` resolves a bill's collector live to a LINE user id. New public `slip-pay/manage` routes reuse the pay page's viewer/token/throttle gate plus a collector check and call the existing `SlipPaymentsService` methods. On the web, `SlipReview` gets its data through an injectable API so the LIFF status page can render it with a LINE-token implementation.

**Tech Stack:** NestJS + Prisma (SQLite, better-sqlite3 adapter), vitest; Angular standalone + signals, `ng test` (vitest).

**Spec:** `docs/superpowers/specs/2026-11-01-collector-line-access-design.md`

## Global Constraints

- Branch `feat/collector-line-access`; main stays deployable.
- Thai-primary UI, English second locale. Every new `i18n`/`$localize` id is hand-added to both `web/src/locale/messages.xlf` (source only) and `web/src/locale/messages.en.xlf` (source + target), appended before `</body>`. Never run `ng extract-i18n` into `src/locale` (it reorders the whole file).
- Chip text for a collector tick: **ผู้รับเงินติ๊ก** (English: "Collector ticked"). Host tick stays **โฮสต์ติ๊ก**.
- Picker confirmation copy: `ให้ {player} (LINE: {lineName}) จัดการการชำระเงินใน LINE ได้?`; clearing: `ไม่ให้ใครจัดการการชำระเงินใน LINE?`.
- LIFF collector header: `คุณจัดการการชำระเงินบิลนี้`. Host line: `ผู้รับเงินจัดการใน LINE: {player}`.
- Public slip routes: every refusal is the same bare 404 (`{ message, statusCode }`), 429 when throttled; never reveal whether a collector exists.
- The read-only status projection (`GET :code/slip-pay/status`) keeps exactly its keys: `closedAt, pendingSlipCount, rows, sessionDate`; row keys `amountChangedSince, amountSatang, name, paid, pending`.
- Collector may not: set/unset LINE links (`setLink`, resolve's `senderPlayerId` is forced to `null`), update the saved receiver name, read group settings.
- 44px tap targets, confirmations in `<dialog class="sheet-dialog">` (no browser `confirm`).
- Server tests run serially (`fileParallelism: false`); run single files with `npx vitest run <file>` from `server/`.
- Commit messages end with `Claude-Session: https://claude.ai/code/session_015LkwdwpwXLn4BTrNQgZNWS`.

## Review Focus

1. **A non-collector player opening the status page repeatedly** must never be throttled into 429 on their read-only page: the role check (`GET slip-pay/role`) answers `{ collector: false }` and records no failure. Test in Task 4.
2. **"Update saved name" from a receiver-mismatch slip** must not cut off the collector or drop the group collector. Test in Task 1 (`sameReceivingAccount` ignores name) and Task 2 (`updateSavedReceiverName` keeps `payCollectorPlayerId`).
3. **Host unlinks the collector's LINE mid-collection** (or the LINE group unlinks): the next manage call is 404. Test in Task 4.
4. **Collector sends `senderPlayerId` on resolve**: ignored, no `PlayerLineAccount` written. Test in Task 4.
5. **Collector's slip image fetch**: works with the LINE header, 404 without it and with the card token alone; object URLs revoked on destroy. Tests in Task 4 (server) and Task 5 (web).

---

### Task 1: Collector storage and resolution (server)

**Files:**
- Modify: `server/prisma/schema.prisma` (Group, Player)
- Create: `server/prisma/migrations/20261102000000_pay_collector/migration.sql` (via `npx prisma migrate dev --name pay_collector --create-only`, then rename folder timestamp if needed)
- Modify: `server/src/sessions/pay-account.ts`
- Modify: `server/src/sessions/payment-card-state.ts`
- Create: `server/src/sessions/collector.service.ts`, `server/src/sessions/collector.service.spec.ts`
- Create: `server/src/groups/pay-collector.ts` (plain function, no Nest module: `SessionsModule` already imports `GroupsModule`, so `GroupsModule` must not import `SessionsModule`; `PrismaModule` is `@Global`)
- Modify: `server/src/sessions/sessions.module.ts` (provide `CollectorService`)
- Test: `server/src/sessions/pay-account.spec.ts`, `server/src/sessions/payment-card-state.spec.ts` (both exist; add cases)

**Interfaces:**
- Produces:
  - Schema: `Group.payCollectorPlayerId String?` with `payCollector Player? @relation("PayCollector", fields: [payCollectorPlayerId], references: [id], onDelete: SetNull)`; back-relation `collectorOf Group[] @relation("PayCollector")` on `Player`. This is a second Group–Player relation: if `npx prisma validate` reports an ambiguous relation, also name the existing pair (`players Player[] @relation("GroupPlayers")` / `group Group @relation("GroupPlayers", ...)`). Relation names do not change the SQL; the migration must contain only the new column, its index and foreign key.
  - `sameReceivingAccount(a: PayAccount | null, b: PayAccount | null): boolean` in `pay-account.ts`: both non-null, `bank` equal, `copyableNumber(number)` equal. Name ignored.
  - `PaymentCardState.collectorPlayerId?: string | null` (night collector); `parsePaymentState` reads it with `str()`, serialize keeps it.
  - `export interface BillCollector { playerId: string; playerName: string; lineUserId: string; lineName: string | null; pictureUrl: string | null }`
  - `CollectorService.forBill(code: string): Promise<BillCollector | null>` — card account = `state.account ?? groupAccount`; if `sameReceivingAccount(cardAccount, groupAccount)` use `group.payCollectorPlayerId`, else `state.collectorPlayerId ?? null`; resolve the player's `PlayerLineAccount` in the session's group (with `lineAccount`); null if no player id, player missing, or no link.
  - `assertCollectorEligible(prisma: PrismaService, groupId: string, playerId: string): Promise<void>` in `server/src/groups/pay-collector.ts` — throws `ConflictException({ code: 'COLLECTOR_INVALID' })` unless the player is in the group and has a `PlayerLineAccount` there. Used by Task 2 (groups) and Task 3 (sessions).

- [ ] **Step 1: Write failing tests**
  - `pay-account.spec.ts`: `sameReceivingAccount` true for `{กสิกร,'123-4-56789-0',A}` vs `{กสิกร,'1234567890',B}`; false for different bank; false when either is null.
  - `payment-card-state.spec.ts` (or existing): round-trip keeps `collectorPlayerId: 'p1'`; a state without it parses to `collectorPlayerId: null`.
  - `collector.service.spec.ts` (AppModule harness like `slip-payments.paid.spec.ts`), cases:
    - saved account + `payCollectorPlayerId` = linked player → returns that player's id, name, `lineUserId`, LINE `displayName`.
    - saved collector set but player has no link → `null`.
    - card confirmed with a different account and `collectorPlayerId: p2` (linked) → p2; with no night collector → `null` even though the group has one.
    - group account name changed after confirm (bank/number same) → still the group collector.
    - group account bank/number changed after confirm → falls back to night collector (`null`).
    - after `prisma.playerLineAccount.deleteMany` for the collector → `null`.
    - `assertCollectorEligible` rejects a player of another group and an unlinked player with `COLLECTOR_INVALID`.
- [ ] **Step 2: Run, verify they fail**
  Run: `npx vitest run src/sessions/collector.service.spec.ts src/sessions/pay-account.spec.ts`
  Expected: FAIL (module / export not found)
- [ ] **Step 3: Add the schema field, create the migration, `npx prisma generate`, implement the functions above**
- [ ] **Step 4: Run the same command, expect PASS; then `npm test` (server) for regressions**
- [ ] **Step 5: Commit** `feat(payments): store and resolve a bill's collector`

### Task 2: Group collector setting API (server)

**Files:**
- Create: `server/src/groups/dto/set-pay-collector.dto.ts`
- Modify: `server/src/groups/groups.controller.ts`, `server/src/groups/groups.service.ts`
- Modify: `server/src/sessions/slips/slip-payments.service.ts` (`updateSavedReceiverName` must not touch the new column; add regression test only)
- Test: `server/src/groups/pay-account.controller.spec.ts`

**Interfaces:**
- Consumes: `assertCollectorEligible` (Task 1).
- Produces:
  - `GET /groups/:code/pay-account` → `{ account: PayAccount | null, collectorPlayerId: string | null }`
  - `PUT /groups/:code/pay-collector` body `{ playerId: string | null }` (DTO: `@IsOptional() @IsString() @MaxLength(64)`, null allowed) → `{ collectorPlayerId: string | null }`; owner-only (no `@Public`), not plan-gated (like pay-account). 409 `COLLECTOR_INVALID` for ineligible; 409 `PAY_ACCOUNT_REQUIRED` when setting a non-null collector on a group with no saved account.
  - `setPayAccount` with an all-blank body also sets `payCollectorPlayerId: null`.

- [ ] **Step 1: Failing tests in `pay-account.controller.spec.ts`**
  - GET on fresh group → `{ account: null, collectorPlayerId: null }`.
  - PUT collector with a linked player → 200, GET returns it.
  - PUT with unlinked player / other group's player → 409 `COLLECTOR_INVALID`, value unchanged.
  - PUT with no saved account → 409 `PAY_ACCOUNT_REQUIRED`.
  - PUT `{ playerId: null }` clears.
  - Clearing the account (all blank) clears the collector; editing only the name keeps it.
  - Non-owner gets 404 (OwnershipGuard), as other group routes.
  - In `slip-payments.resolve.spec.ts` (or the file holding update-name tests): after `updateSavedReceiverName`, `group.payCollectorPlayerId` is unchanged.
- [ ] **Step 2: Run** `npx vitest run src/groups/pay-account.controller.spec.ts` → FAIL
- [ ] **Step 3: Implement DTO, route, service methods**
- [ ] **Step 4: Run again → PASS**
- [ ] **Step 5: Commit** `feat(groups): pick the pay account's collector`

### Task 3: Night collector on confirm, collector on host panels, collector tick source (server)

**Files:**
- Modify: `server/src/sessions/dto/confirm-payment-card.dto.ts`, `server/src/sessions/payment-card.service.ts`, `server/src/sessions/payment-card.controller.ts`
- Modify: `server/src/sessions/slips/slip-payments.service.ts` (`PaidRow.source`, `getPaid`, `tick`)
- Modify: `server/src/sessions/slips/slip-payments.controller.ts` (`SlipPaymentsPanel.collector`)
- Test: `server/src/sessions/payment-card.service.spec.ts` (or the existing confirm spec), `server/src/sessions/slips/slip-payments.paid.spec.ts`

**Interfaces:**
- Consumes: `CollectorService.forBill`, `assertCollectorEligible`, `sameReceivingAccount` (Task 1).
- Produces:
  - `ConfirmPaymentCardDto.collectorPlayerId?: string | null`.
  - `confirm()`: if `sameReceivingAccount(account, groupAccount)` store `collectorPlayerId: null`; else, when `dto.collectorPlayerId` is a string, `assertCollectorEligible(prisma, groupId, id)` then store it; else `null`. The eligibility check runs before the write, inside the existing lock.
  - Host responses of `GET :code/payment-card` and `POST :code/payment-card/confirm` gain `groupCode: string` and `collector: { playerId: string; playerName: string; lineName: string | null; pictureUrl: string | null } | null` (from `forBill`, minus `lineUserId`), added in `PaymentCardController`, **not** in `PaymentCardService.panel()`: `panel()` runs many times per slip request (gate, listWaiting, collection) and is the base of the pay-page gate, so it stays free of the extra reads. Not part of `contentHash`.
  - `PaidRow.source: 'slip' | 'host' | 'collector'`; `getPaid` maps stored source verbatim when one of the three, else `'host'`.
  - `SlipPaymentsService.tick(code: string, playerId: string, source: 'host' | 'collector' = 'host'): Promise<void>`.
  - `SlipPaymentsPanel.collector: { playerName: string; lineName: string | null } | null`.

- [ ] **Step 1: Failing tests**
  - confirm with a typed different account + eligible `collectorPlayerId` → `forBill` returns that player; with the group's account + any `collectorPlayerId` → stored null, `forBill` is the group's collector; ineligible id → 409 `COLLECTOR_INVALID`, card unchanged.
  - host `GET /sessions/:code/payment-card` (and the confirm response) exposes `groupCode` and `collector`, never the LINE user id: `expect(res.text).not.toContain(lineUserId)`; `cards.panel(code)` itself has no `collector` key.
  - `tick(code, id, 'collector')` → `getPaid` row `source: 'collector'`; a later host `tick` keeps `'collector'`.
  - host `GET /sessions/:code/payments` includes `collector`.
- [ ] **Step 2: Run** the touched spec files → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run → PASS, then server `npm test`**
- [ ] **Step 5: Commit** `feat(payments): night collector on confirm, collector tick source`

### Task 4: Collector manage routes (server)

**Files:**
- Create: `server/src/sessions/slips/slip-viewer-gate.ts` (extract `viewer`, `known`, `fail`, `tooMany`, `payToken` from `SlipPayController`, injectable `SlipViewerGate`)
- Modify: `server/src/sessions/slips/slip-pay.controller.ts` (use the gate; add `GET :code/slip-pay/role`)
- Create: `server/src/sessions/slips/slip-collector.controller.ts`
- Modify: `server/src/sessions/slips/slip-payments.service.ts` (add `collectorAccess`)
- Modify: `server/src/sessions/sessions.module.ts`
- Modify: `server/test/slip-http.fixture.ts` (add `linkLine(groupCode, playerId, user)` and `setCollector(groupCode, playerId)` helpers)
- Test: `server/src/sessions/slips/slip-collector.controller.spec.ts`

**Interfaces:**
- Consumes: `CollectorService.forBill`, `tick(..., 'collector')`, existing `untick`, `resolveWaiting`, `dismissWaiting`, `dismissDuplicate`, `closeCollection`, `getPaid`, `listWaiting`, `listDuplicates`, `collection`, `SlipImagesService.read`.
- Produces:
  - `SlipPaymentsService.collectorAccess(code: string, token: string | undefined, user: LiffUser, now?: Date): Promise<{ panel: PaymentPanel } | null>` — `gate()` passes and `forBill(code)?.lineUserId === user.userId`.
  - `GET /sessions/:code/slip-pay/role?token=` (header) → `{ collector: boolean }`. Same gate as status; when the gate fails it is the uniform 404 counted as today; when the gate passes and the viewer is not the collector it returns `{ collector: false }` and records nothing.
  - Under `/sessions/:code/slip-pay/manage`, all `@Public`, header + `?token=`, any refusal = uniform 404 counted via `fail(key)`:
    - `GET ` → `{ groupName, date, accountName, rows: {playerId,name,amountSatang,absent}[], paid: PaidRow[], waiting: WaitingSlip[], duplicates: DuplicateSlip[], links: [], collection }`, `Cache-Control: no-store`.
    - `GET /images/:id` → image, same headers as host route.
    - `POST /tick`, `/untick` body `SlipPlayerDto`; `POST /waiting/:id/resolve` body `ResolveWaitingSlipDto` (sender ignored → `null`); `POST /waiting/:id/dismiss`; `POST /duplicates/:id/dismiss`; `POST /close` body `CloseCollectionDto` (`{ confirmDeleteImages: true }`, as the host sends). Each → `{ ok: true }`. Service 409/404 pass through. A collector check that fails after a valid gate is the uniform 404 and counts (only collectors' own pages call these).

- [ ] **Step 1: Failing tests in `slip-collector.controller.spec.ts`** (boot with `bootSlipApp`; collector = `ids[0]` linked via `linkLine` and set via `setCollector`)
  - Uniform-404 table over every manage route: no header, unverifiable header, bad/no/repeated token, unknown session, **verified non-collector**, collector after `playerLineAccount.deleteMany`, lapsed plan (`owner('free')`), reconfirmed card (old token). Each equals the baseline 404 body.
  - Image: collector GET with header → 200 `image/png`; same URL without header → 404.
  - Tick → 200 and `getPaid` source `collector`; untick removes.
  - Resolve with `senderPlayerId: ids[1]` → payment written, `playerLineAccount.count` unchanged.
  - Close when ready → `paymentCollectionClosedAt` set; after close, tick → 409 `COLLECTION_CLOSED`.
  - No route under manage for `links` or `update-name` (POST to them → 404).
  - Role: collector → `{ collector: true }`; non-collector → `{ collector: false }` 20 times in a row, then `GET status` still 200 (not throttled).
  - Status projection key set unchanged (reuse the existing assertion).
- [ ] **Step 2: Run** `npx vitest run src/sessions/slips/slip-collector.controller.spec.ts` → FAIL
- [ ] **Step 3: Extract the gate (no behavior change; `slip-pay.controller.spec.ts` must stay green), add `collectorAccess`, role route, collector controller**
- [ ] **Step 4: Run the new spec and `src/sessions/slips/` → PASS; server `npm test`; `npm run lint`**
- [ ] **Step 5: Commit** `feat(payments): collector manage routes behind LINE identity`

### Task 5: SlipReview API seam, collector mode, collector chip (web)

**Files:**
- Create: `web/src/app/core/slip-review-api.ts`
- Modify: `web/src/app/core/slip-host.service.ts` (implements `SlipReviewApi`), `web/src/app/core/slip-host.model.ts`
- Modify: `web/src/app/shared/slip-review/slip-review.{ts,html,css,spec.ts}`
- Modify: every spec that mocks `SlipHostService` (rename `imageUrl` → `image` returning `of(url)` in the mock): `core/slip-host.service.spec.ts`, `shared/payment-sheet/payment-sheet.spec.ts`, `shared/payment-status-sheet/payment-status-sheet.spec.ts`, `shared/payment-panel/payment-panel.spec.ts`, `pages/session-summary/session-summary.spec.ts`, `pages/session-bill/session-bill.spec.ts`. They keep providing `SlipHostService`; `SlipReviewApi` resolves to it through `useExisting`.
- Modify: locale files

**Interfaces:**
- Consumes: Task 3/4 response shapes.
- Produces:
  - `export abstract class SlipReviewApi` (providedIn root, `useExisting: SlipHostService`) with `panel(code): Observable<SlipHostPanel>`, `image(code, id): Observable<string>` (a URL usable in `<img src>`), `tick`, `untick`, `resolve`, `dismiss`, `dismissDuplicate`, `closeCollection`, `updateName`, `setLink` (same signatures as `SlipHostService` today). `SlipHostService.imageUrl(code, id): string` is replaced by `image(code, id): Observable<string>` returning `of(directUrl)`; it is used only by `SlipReview`.
  - `SlipPaidRow.source: 'slip' | 'host' | 'collector'`; `SlipHostPanel.collector?: { playerName: string; lineName: string | null } | null`.
  - `SlipReview` input `collectorMode = input(false)`: hides the sender `<select>` (resolve sends `senderPlayerId: null`), the `data-links` details, and `data-update-name`.
  - `SlipReview` resolves image URLs through `api.image()` into a `Map<imageId, url>` signal; revokes `blob:` URLs in `DestroyRef.onDestroy`.
  - Host line `data-collector-line`: `ผู้รับเงินจัดการใน LINE: {playerName}` when `data.collector` and not `collectorMode`.

- [ ] **Step 1: Failing tests in `slip-review.spec.ts`** (provide `{ provide: SlipReviewApi, useValue: svc }`; `svc.image` returns `of('/private/image')`)
  - chip for `source: 'collector'` reads `ผู้รับเงินติ๊ก`; collector rows untick on tap (no dialog).
  - `collectorMode`: no `[data-sender]`, no `[data-links]`, no `[data-update-name]`; resolve called with `senderPlayerId: null`.
  - host mode with `collector: { playerName: 'บูม' }` shows `[data-collector-line]` containing `บูม`; collector mode hides it.
  - image src comes from `svc.image`; a `blob:` URL given by `svc.image` is revoked on `fixture.destroy()` (spy `URL.revokeObjectURL`).
  - existing tests updated to the renamed `image` method; all green.
- [ ] **Step 2: Run** `npx ng test --watch=false --include src/app/shared/slip-review` (from `web/`) → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run → PASS; full `npx ng test --watch=false`**
- [ ] **Step 5: Commit** `feat(web): slip review behind an API seam, collector mode and chip`

### Task 6: LIFF status page renders SlipReview for the collector (web)

**Files:**
- Create: `web/src/app/core/collector-slip.service.ts`
- Modify: `web/src/app/core/slip-pay.service.ts` (add `role`), `web/src/app/core/slip-pay.model.ts`
- Modify: `web/src/app/pages/payment-status/payment-status.{ts,html,css,spec.ts}`
- Modify: locale files

**Interfaces:**
- Consumes: Task 4 routes; `SlipReviewApi` (Task 5).
- Produces:
  - `SlipPayService.role(code, token, accessToken): Observable<{ collector: boolean }>`.
  - `CollectorSlipService extends SlipReviewApi` (not root-provided) with `configure(token: string, accessToken: string): void`; every call targets `/sessions/:code/slip-pay/manage...?token=` with the `X-Line-Access-Token` header; `panel()` maps the manage response to `SlipHostPanel` (and exposes the rows for the page via `manage(code): Observable<CollectorManageView>`); `closeCollection()` posts `{ confirmDeleteImages: true }`; `image()` GETs the image as a blob and returns `URL.createObjectURL(blob)`; `updateName`/`setLink` return `throwError` (never called in collector mode).
  - `PaymentStatus` component `providers: [CollectorSlipService, { provide: SlipReviewApi, useExisting: CollectorSlipService }]`; after LINE login it calls `role`; `collector: true` → phase `'manage'`, loads `manage(code)` for `rows`/`accountName`, renders header `คุณจัดการการชำระเงินบิลนี้` and `<app-slip-review [code] [rows] [collectorMode]="true" [hideTitle]="true">`; otherwise the existing read-only flow unchanged. A failed role read falls back to the read-only flow.

- [ ] **Step 1: Failing tests in `payment-status.spec.ts`**
  - role `{collector:false}` → existing read-only list and no `app-slip-review`.
  - role `{collector:true}` → header text present, `app-slip-review` rendered with `collectorMode` true, `status()` not called.
  - role error → read-only list.
  - `collector-slip.service.spec.ts`: requests carry header and `?token=` (HttpTestingController); `image()` returns a `blob:` URL; `panel()` maps `links` to `[]`.
- [ ] **Step 2: Run** `npx ng test --watch=false --include src/app/pages/payment-status --include src/app/core/collector-slip.service.spec.ts` → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run → PASS; full web tests; `npx ng build`**
- [ ] **Step 5: Commit** `feat(web): collector manages payments from the LINE status page`

### Task 7: Collector picker in group settings and on the payment card (web)

**Files:**
- Create: `web/src/app/shared/collector-picker/collector-picker.{ts,html,css,spec.ts}`
- Modify: `web/src/app/core/pay-account.service.ts` (`getWithCollector`, `setCollector`; existing `get` keeps mapping `r.account`)
- Modify: `web/src/app/pages/group-settings-detail/pay-account-panel/pay-account-panel.{ts,html,spec.ts}`
- Modify: `web/src/app/core/payment-card.model.ts` (`PaymentCardPanel.groupCode`, `.collector`), `web/src/app/core/payment-card.service.ts` (`confirm(sessionCode, account, expectedHash, collectorPlayerId?: string | null)`; the key is left out of the body when undefined)
- Modify: `web/src/app/shared/payment-panel/payment-panel.{ts,html,spec.ts}`
- Modify: locale files

**Interfaces:**
- Consumes: Task 2 routes, Task 3 panel fields, `LineAccountsService.list(groupCode)`.
- Produces:
  - `CollectorPicker` (`app-collector-picker`): inputs `groupCode: string`, `value: string | null` (player id), `disabled = false`; output `chosen: string | null` emitted **only after** its own confirmation dialog (`data-collector-confirm` / `data-collector-cancel`). Lists only `LineAccountRow`s with `player !== null`, each showing LINE picture (`referrerpolicy="no-referrer"`), player name, LINE name, plus a "nobody" option (`ไม่มี`). Empty list text: `ยังไม่มีผู้เล่นที่ผูก LINE`. A `value` that is not among the linked rows (the player's LINE was unlinked since) shows as `ไม่มี` with the note `คนที่เลือกไว้ไม่ได้ผูก LINE แล้ว` (`data-collector-stale`), matching the server, which already treats that bill as having no collector.
  - `PayAccountService.getWithCollector(groupCode): Observable<{ account: PayAccount | null; collectorPlayerId: string | null }>`; `setCollector(groupCode, playerId: string | null): Observable<string | null>`.
  - Pay account panel: picker under the fields, shown only when an account is saved; `chosen` → `setCollector`; 409 `COLLECTOR_INVALID` → `เลือกคนนี้ไม่ได้ ผู้เล่นต้องผูก LINE ในก๊วนนี้ก่อน`.
  - Payment panel: when the account fields are a different receiving account from `groupAccount` — compared like the server's `sameReceivingAccount` (bank equal and number digits equal, name ignored; add `sameReceiving(a, b)` beside the existing `sameAccount`, which still drives the fold/confirm logic) — the picker shows under the fields (`value` = `nightCollector` signal, initialised from `panel.collector?.playerId` when the confirmed account is not the group's); `chosen` sets `nightCollector` and counts as an edit (`editedSinceConfirm` also true when `nightCollector` differs from the confirmed collector). Confirm sends `collectorPlayerId: nightCollector` (or omitted when fields equal the group account). Panel shows `ผู้รับเงินจัดการใน LINE: {name}` (`data-collector-line`) from `panel.collector` when confirmed.

- [ ] **Step 1: Failing tests**
  - picker: only linked rows listed with name + LINE name; a `value` not in the list shows `data-collector-stale`; choosing opens dialog; cancel emits nothing; confirm emits id; choosing `ไม่มี` asks the clearing copy and emits `null`.
  - pay account panel: picker hidden with no saved account; confirm → `setCollector` called; COLLECTOR_INVALID shows the message.
  - payment panel: fields equal group account → no picker, confirm body has no `collectorPlayerId`; only the name edited → still no picker; edited account → picker shown, confirm body carries the chosen id; changing the night collector after confirm shows `ยืนยันใหม่`; `data-collector-line` shows the confirmed collector.
- [ ] **Step 2: Run** the three spec files → FAIL
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run → PASS; full web tests; `npx ng build`**
- [ ] **Step 5: Commit** `feat(web): pick the collector in settings and for tonight's account`

### Task 8: Docs and full verification

**Files:**
- Modify: `docs/overview.md` (slip images paragraph: "Only the owning host (or administrator)" → "the owning host, an administrator, or the bill's collector"; read-only status paragraph: note the collector sees the management screen, and that the host list orders paid first (earliest payer at the top) while the LIFF list keeps unpaid first (shipped 2026-11-01, 07dc269); new `### Collector access (2026-11-01)` subsection under Slip payment matching with the why and the live/snapshot rule)
- Modify: `docs/superpowers/specs/2026-11-01-collector-line-access-design.md` (Status: built)

- [ ] **Step 1: Write the doc changes**
- [ ] **Step 2: Run everything** — from repo root `npm test`; `server/`: `npm run lint`; `web/`: `npx ng build`. Expected: all suites pass, lint clean, build complete.
- [ ] **Step 3: Commit** `docs: collector access`
