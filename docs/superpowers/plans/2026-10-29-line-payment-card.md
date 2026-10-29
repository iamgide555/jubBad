# LINE payment card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A separate LINE "ใบเก็บเงิน" card (per-person amounts, bank account, copy-number button) that the host confirms in a shared panel and sends to the group, by the bot (bot-linked group) or from the host's own account through the LIFF share picker (host-share group).

**Architecture:** The card is built server-side from the existing `BillService.getBill` result plus an account (group default `Group.payAccount`, tonight's override in `Session.paymentCard`). One owner-only panel API (read, confirm, bot send) and one token-gated public read for the LIFF page. One shared web panel component is embedded in the bill screen and in a bottom sheet on the summary page. Summary-card code is untouched except one thin public accessor.

**Tech Stack:** NestJS + Prisma (SQLite) + vitest; Angular 22 standalone/signals + vitest; LIFF 2.31.2 (already pinned); LINE Flex messages.

**Spec:** `docs/superpowers/specs/2026-10-29-line-payment-card-design.md` (binding; this plan argues from it).

## Global Constraints

- Work in a worktree branch, never on `main` (main runs real sessions). Never touch the owner's dev servers or `dev.db`; a worktree needs its own gitignored `server/.env` with `SESSION_SECRET` (see how the previous feature did it). Plain `git` may be hook-blocked: use `/usr/bin/git`, one simple command per call.
- Server specs run with `fileParallelism: false`; do not change that. Remove `PUBLIC_APP_URL` and `LINE_LIFF_ID` in `beforeEach` of any spec that depends on them (hermetic env).
- The card text is always Thai (money in a group chat is not localized). UI strings are Thai source plus English, hand-spliced into `web/src/locale/messages.xlf` and `messages.en.xlf` (do not run `ng extract-i18n`; it rewrites about 500 unrelated lines).
- Money is integer satang on the server; whole baht on the card via the existing `formatBaht` rule (copy it server-side, do not import from `web/`).
- The summary card, `retryKeyFor`, `lineSummarySentAt` and its claim fields are not modified. The existing group key stays byte-identical (pinned test: `abc12345` -> `998d5d06-092a-5ebb-af39-2b5d50e20966`).
- No amount or account number in any existing public read. A new spec asserts the public summary, display and group-dashboard payloads contain neither.
- Never print, log or hardcode `HOME_SERVER_*` values; reference env vars by name. Confirm before any deploy or restart.
- Bank list (Thai name, alias), in this order: กรุงไทย (KTB), กรุงเทพ (BBL), กสิกร (KBANK), ธนชาต (TTB), ไทยพาณิชย์ (SCB), ซีไอเอ็มบี (CIMBT), ยูโอบี (UOB), กรุงศรี (BAY), ออมสิน (GSB), แลนด์แอนด์เฮ้าส์ (LHBANK), ทิสโก้ (TISCO), PromptPay. Any other bank is typed as free text (<= 40 chars).
- The server uses `ValidationPipe({ whitelist: true })`: **a DTO property without a class-validator decorator is silently stripped**, so a DTO that looks complete can receive nothing. Every new DTO field gets `@IsOptional() @IsString() @MaxLength(...)` (or `@IsUUID()`), and each DTO has a test that a real body arrives intact.
- The group export (`GroupsService.exportGroup`) maps columns explicitly, so the new columns do not leak by default; a test pins that `payAccount` and `paymentCard` (which holds the share token) never appear in it.
- Web tests: `web/package.json` runs `ng test`; run single files with `npx ng test --include <path>` (confirm the flag works before relying on it).
- Field limits: bank <= 40, account name <= 80, account number 6-20 characters of digits, spaces, dashes. Either all three fields are present or none (partial is 400 `PAY_ACCOUNT_INVALID`). The copied number is digits only.

## Review Focus

Inputs the spec implies but no happy-path task exercises; each has a pinning test in the owning task.

1. A stale or wrong token, or a token after a re-confirm, on the public read: same uniform 404 as "no such session" (Task 5).
2. Bill edited after confirm (an amount changes): panel says `stale`, host-target link and bot send are refused until re-confirm (Task 5).
3. Plan lapses or LINE unlinked between confirm and send: send returns `unavailable`, nothing is pushed (Task 5).
4. Malformed `Session.paymentCard` / `Group.payAccount` JSON in the database reads as "absent", never breaks a bill read or ending a session (Task 1).
5. 40 billed players with long Thai names: the Flex bubble stays inside LINE's size limit and every host-typed text is clipped (Task 4).

---

### Task 0: Copy-button spike (controller + owner, no repo code)

Answers the open question in the spec before the card is designed around it. Not a subagent task: it needs the owner's phone.

**Interfaces:** Produces one fact, recorded in the ledger and later in the code as `PAYMENT_NUMBER_TEXT = { group: boolean; host: boolean }` (Task 4): whether a second plain-text message with the account number must accompany the card on each path.

**Done 2026-10-29; result in the ledger (`.superpowers/sdd/2026-10-29-line-payment-card/progress.md`, "TASK 0 SPIKE RESULT"):** a Flex `clipboard` button in a card sent through `liff.shareTargetPicker` renders; on the owner's phone (LINE mobile) it copies the number, on LINE Desktop it does nothing. Decision: keep `PAYMENT_NUMBER_TEXT = { group: true, host: true }`, so the digits-only plain-text message accompanies the card on both paths. The bot path's clipboard rendering is still checked at deploy (Task 9 checklist).

- [x] **Step 1: Build a throwaway test page in the scratchpad (not the repo).** One static HTML file that loads the LIFF SDK from `cdn.jsdelivr.net/npm/@line/liff@2.31.2`, calls `liff.init`, and on a button tap calls `liff.shareTargetPicker([...])` with a hard-coded Flex bubble whose button is `{ type: 'clipboard', label: 'คัดลอกเลขบัญชี', clipboardText: '1234567890' }`. No JubBad data in it.
- [x] **Step 2: Serve it through a temporary tunnel.** Ask the owner to create a second LIFF app on the existing "Jubbad share" LINE Login channel whose endpoint is the tunnel URL (this leaves the production LIFF app untouched). Serve the file locally, open the tunnel, and give the owner the second LIFF URL.
- [x] **Step 3: Owner opens it in the LINE app, sends the test card to any chat, and long-presses/taps the button in the received card.** Record: does the card render, does the tap copy `1234567890` (paste into a note to check)?
- [x] **Step 4: Record the decision using the spec's table.** Copy works -> `{ group: false, host: false }`. Fails in the picker only -> `{ group: false, host: true }`. Fails both -> `{ group: true, host: true }`. (The bot path is re-checked for real in Task 9's checklist; if it fails there, flip `group` and redeploy.) Delete the second LIFF app and stop the tunnel.

---

### Task 1: Schema and the two tolerant JSON helpers

**Files:**
- Modify: `server/prisma/schema.prisma` (add `Group.payAccount String?` and `Session.paymentCard String?`, both with a doc comment like their neighbours)
- Create: `server/prisma/migrations/20261029000000_line_payment_card/migration.sql` (two `ALTER TABLE ... ADD COLUMN` statements, nullable, no default)
- Create: `server/src/sessions/pay-account.ts`, `server/src/sessions/payment-card-state.ts`
- Test: `server/src/sessions/pay-account.spec.ts`, `server/src/sessions/payment-card-state.spec.ts`

**Interfaces:**
- Produces (`pay-account.ts`):
  - `interface PayAccount { bank: string; number: string; name: string }`
  - `parsePayAccount(raw: string | null): PayAccount | null` (anything malformed, wrong types, over-limit or partial -> `null`)
  - `serializePayAccount(account: PayAccount | null): string | null`
  - `validatePayAccount(input: { bank?: string; number?: string; name?: string }): { ok: true; value: PayAccount | null } | { ok: false }` (trims; all blank -> `{ ok: true, value: null }`; partial or over-limit or bad number characters -> `{ ok: false }`)
  - `copyableNumber(number: string): string` (digits only)
- Produces (`payment-card-state.ts`):
  - `interface PaymentCardState { account: PayAccount | null; token: string | null; confirmedAt: string | null; confirmedHash: string | null; lastSentAt: string | null }`
  - `EMPTY_PAYMENT_STATE`, `parsePaymentState(raw: string | null): PaymentCardState` (malformed -> `EMPTY_PAYMENT_STATE`, never throws), `serializePaymentState(state: PaymentCardState): string`
  - `newShareToken(): string` (16 random bytes, base64url)

- [x] **Step 1: Write failing tests.** `validatePayAccount({ bank: ' กสิกร ', number: '123-4-56789-0', name: 'สมชาย' })` -> value trimmed; `copyableNumber('123-4 5678')` is `'12345678'`; `{ bank: 'x', number: '', name: '' }` -> `{ ok: false }`; `{}` -> `{ ok: true, value: null }`; number `'12'` and `'1'.repeat(21)` and `'12ab3456'` -> `{ ok: false }`; bank of 41 chars -> `{ ok: false }`. `parsePayAccount('{not json')`, `parsePayAccount('{"bank":1}')`, `parsePayAccount(null)` -> `null`. `parsePaymentState` of `'garbage'`, `'[]'`, `'{"token":5}'` -> `EMPTY_PAYMENT_STATE`; round trip equals input; `newShareToken()` is >= 22 chars of `[A-Za-z0-9_-]` and two calls differ.
- [x] **Step 2: Run to see them fail** (`cd server && npx vitest run src/sessions/pay-account.spec.ts src/sessions/payment-card-state.spec.ts`).
- [x] **Step 3: Implement both modules and the migration; run `npx prisma generate` and `npx prisma migrate deploy` against the worktree's scratch DB only.**
- [x] **Step 4: Run the new specs and `npx vitest run src/prisma-roundtrip.spec.ts`; all pass.**
- [x] **Step 5: Commit** `feat(payment): schema columns and tolerant account/state helpers`.

---

### Task 2: Group default account endpoints

**Files:**
- Create: `server/src/groups/dto/set-pay-account.dto.ts`
- Modify: `server/src/groups/groups.controller.ts`, `server/src/groups/groups.service.ts`
- Test: `server/src/groups/pay-account.controller.spec.ts` (follow the structure of `group-share.controller.spec.ts`)

**Interfaces:**
- Consumes: Task 1 `validatePayAccount`, `parsePayAccount`, `serializePayAccount`.
- Produces: `GET /groups/:code/pay-account` -> `{ account: PayAccount | null }`; `PUT /groups/:code/pay-account` body `{ bank, number, name }` (all optional strings) -> `{ account: PayAccount | null }`, 400 `{ code: 'PAY_ACCOUNT_INVALID' }` on `{ ok: false }`. Owner-only like the rest of `/groups/:code/...` (no `@Public`, no plan gate: available without a LINE link or paid plan, so a lapsed host can still clear it). Blank body clears it.

- [x] **Step 1: Write failing tests:** the DTO's three fields survive the global pipe (a PUT through the real app, not a direct service call, stores all three); the group export contains neither `payAccount` nor its number; owner PUT then GET round trips; all-blank PUT clears to `{ account: null }`; partial PUT is 400 `PAY_ACCOUNT_INVALID`; a different host gets 404 on both; unauthenticated is refused; the account never appears in `GET /groups/:code` (the group read), `GET /groups/:code/export`'s other groups, or the public `GET /dashboards/:token` payload (assert the serialized JSON does not contain the number).
- [x] **Step 2: Run to see them fail.**
- [x] **Step 3: Implement** (service methods `getPayAccount(code)` / `setPayAccount(code, dto)`; make sure no existing select/include spreads `payAccount` into a public shape).
- [x] **Step 4: Run the new spec plus `src/auth/auth.boundary.spec.ts` and `src/groups/groups.controller.spec.ts`; all pass.**
- [x] **Step 5: Commit** `feat(payment): group default pay account endpoints`.

---

### Task 3: Web bank list, bank field and the group settings panel

**Files:**
- Create: `web/src/app/core/thai-banks.ts`, `web/src/app/shared/bank-field/bank-field.{ts,html,css,spec.ts}`, `web/src/app/pages/group-settings-detail/pay-account-panel/pay-account-panel.{ts,html,css,spec.ts}`, `web/src/app/core/pay-account.service.ts`
- Modify: `web/src/app/pages/group-settings-detail/group-settings-detail.{ts,html}` (new section `payment`, titled "บัญชีรับเงิน"), the group-home settings disclosure that lists sections (add the link; find it the way the `line` section is linked), `web/src/locale/messages.xlf`, `messages.en.xlf`

**Interfaces:**
- Produces: `THAI_BANKS: { name: string; alias: string }[]` in the order of Global Constraints; `searchBanks(query: string): { name: string; alias: string }[]` (case-insensitive over name and alias, trimmed; empty query returns all). `PayAccount` model type `{ bank: string; number: string; name: string }` in `core/pay-account.service.ts` with `PayAccountService.get(groupCode)` / `.set(groupCode, account)` (observables over Task 2's routes). `<app-bank-field [value] (valueChange)>`: input + listbox of matches (combobox ARIA); **the full list opens on focus** (12 big tap rows beat typing on a phone), narrowing as the host types; typing a bank not in the list is accepted as is (free text, <= 40), selecting a suggestion fills the Thai name. Account number inputs use `inputmode="numeric"` and accept a pasted number with dashes or spaces.

- [x] **Step 1: Write failing tests:** `searchBanks('กส')` and `searchBanks('kbank')` both return กสิกร; `searchBanks('')` returns 12 entries; `searchBanks('  scb ')` returns ไทยพาณิชย์; unknown query returns `[]`. Bank field: focusing it with no text shows all 12 banks; typing "kbank" narrows to กสิกร, tapping it emits `กสิกร`; typing "Dime" and blurring emits `Dime` (free text kept); arrow-down/enter selects (keyboard). Panel: loads the saved account into the three fields; Save with a partial entry shows the validation message and does not call the API; Save with all three calls `PUT`; a "ล้าง" action sends all-blank; server 400 shows the error message.
- [x] **Step 2: Run to see them fail** (`cd web && npm test -- --include <file>` per spec file).
- [x] **Step 3: Implement.** Tap targets 44px (one-handed courtside rule in `PRODUCT.md`). The panel is reachable with no LINE link and no paid plan. Hand-splice Thai and English units into both xlf files.
- [x] **Step 4: Run the new specs plus `group-settings-detail.spec.ts`; all pass. Run `npx ng build` to confirm the bundle still builds.**
- [x] **Step 5: Commit** `feat(payment): bank list, bank field and group account settings panel`.

---

### Task 4: The payment card builder (pure)

**Files:**
- Create: `server/src/line/payment-card.ts`
- Test: `server/src/line/payment-card.spec.ts`

**Interfaces:**
- Consumes: Task 1 `PayAccount`, `copyableNumber`; `cardTexts` / `cardDate` / `clip` conventions from `line-summary-card.ts` (export `clip` if needed; do not change its behavior).
- Produces:
  - `interface PaymentCardInput { groupName: string | null; date: string | null; endedAt: Date; venue: string | null; rows: { name: string; amountSatang: number; absent: boolean }[]; settledCount: number; totalSatang: number; account: PayAccount }`
  - `paymentCardMessages(input: PaymentCardInput, target: 'group' | 'host'): unknown[]` -> `[flexBubble]`, plus `[flexBubble, textMessage]` when `PAYMENT_NUMBER_TEXT[target]` is true.
  - `export const PAYMENT_NUMBER_TEXT: { group: boolean; host: boolean }` (value from Task 0).
  - `formatBaht(satang: number): string` (same output as the web helper: `144000 -> "1,440"`, `8550 -> "85.50"`).
  - `liffPayUrl(liffId: string, sessionCode: string, token: string): string` -> `https://liff.line.me/<id>/pay/<enc code>/<enc token>`.

Card layout (spec "The card"): green header "ยอดค่าเล่น" + group name; body rows date and venue (when present), then one row per person in the bill's own order (same as the copied text): name on the left, amount **right-aligned** on the right (`฿1,440`), absent shown as `name (ไม่มา)`; a row whose amount is 0 (typically the collector, zeroed by an override) reads "ไม่ต้องโอน" instead of `฿0`; total row "รวม ฿X"; footer line "จ่ายแล้ว N คน" only when `settledCount > 0`; account block "โอนให้ <name>", bank, number; one `clipboard` button labelled "คัดลอกเลขบัญชี" with `clipboardText = copyableNumber(number)`. No "ดูสรุป", no URI action, no margin. `altText` = `ยอดค่าเล่น <name> <date>` clipped to 400.

- [x] **Step 1: Write failing tests:** the button action is exactly `{ type: 'clipboard', label: 'คัดลอกเลขบัญชี', clipboardText: '1234567890' }` for number `123-4-56789-0`; one row per input row in input order; an absent row's text contains `ไม่มา`; a 0-satang row shows `ไม่ต้องโอน` and no `฿0`; each amount component has `align: 'end'`; the account number is printed in the card body even without the button (an old LINE client that cannot run the clipboard action still shows it); `settledCount: 0` has no "จ่ายแล้ว" text and `3` has "จ่ายแล้ว 3 คน"; the serialized card contains no `uri` action and no `ดูสรุป`; every host-typed text (group name, venue, person name, bank, account name) over 60 characters is clipped with an ellipsis and an emoji is never split; a 40-row card with 60-character Thai names serializes to < 50,000 bytes (LINE's bubble limit) and has `type: 'bubble'` (never a carousel); `formatBaht` cases above; `liffPayUrl('1-a','abc 1','T_k-9')` encodes the code and keeps the token; `PAYMENT_NUMBER_TEXT.host === true` makes `paymentCardMessages(..., 'host')` return two messages, the second `{ type: 'text', text }` containing the digits-only number (write the test against the constant: assert the message count equals `PAYMENT_NUMBER_TEXT.host ? 2 : 1`).
- [x] **Step 2: Run to see them fail.**
- [x] **Step 3: Implement.** Reuse the summary card's colour constants (COURT green, INK) by exporting them rather than copying literals.
- [x] **Step 4: Run `src/line/payment-card.spec.ts` and `src/line/line-summary-card.spec.ts` (unchanged and green).**
- [x] **Step 5: Commit** `feat(payment): payment card builder`.

---

### Task 5: PaymentCardService, owner routes and the public token read

**Files:**
- Create: `server/src/sessions/payment-card.service.ts`, `server/src/sessions/payment-card.controller.ts`, `server/src/sessions/dto/confirm-payment-card.dto.ts`, `server/src/sessions/dto/send-payment-card.dto.ts`
- Modify: `server/src/sessions/sessions.module.ts` (register), `server/src/line/line-summary.service.ts` (add the accessor below), `server/src/auth/auth.boundary.spec.ts` (exact-path skip for `/sessions/:code/payment-share-card`, as for `line-share-card`)
- Test: `server/src/sessions/payment-card.spec.ts`, `server/src/sessions/payment-card.public.spec.ts`

**Interfaces:**
- Consumes: Tasks 1, 4; `BillService.getBill(code)` (rows from `result.rows` with `status === 'billed'`, names from `players`, `settled.length`, `readyToCopy`, `result.warnings`; the card total is the sum of the listed rows' `amountSatang`, which a test pins, so it equals `result.totals.stillDueSatang`); `LineSummaryService`; `LineClient.push(to, messages, retryKey)`; `SessionLock.run`.
- Add to `LineSummaryService` (no behavior change to anything existing): `destination(sessionCode: string, now?: Date): Promise<{ target: LineSummaryTarget; to: string } | null>` wrapping the private `load` + `resolve` (same plan, config, link and finished-game rules).
- Produces `PaymentCardService`:
  - `panel(code): Promise<PaymentPanel>`:
    `interface PaymentPanel { target: 'group' | 'host' | null; ended: boolean; ready: boolean; warnings: string[]; rows: { playerId: string; name: string; amountSatang: number; absent: boolean }[]; settledCount: number; totalSatang: number; groupAccount: PayAccount | null; account: PayAccount | null; confirmed: boolean; stale: boolean; lastSentAt: string | null; shareUrl: string | null }`. `account` = tonight's override else the group default. `stale` = confirmed but the content hash of (rows, total, settledCount, account) now differs from `confirmedHash`. `shareUrl` only for target `host`, confirmed, not stale, `LINE_LIFF_ID` and `PUBLIC_APP_URL` set. Works for an open session (`ended: false`, `shareUrl` null). `target` null when the summary destination is null.
  - `confirm(code, dto: { bank?, number?, name? }): Promise<PaymentPanel>` under `SessionLock`: requires target non-null, session ended, `ready`, >= 1 row, a valid non-null account (dto, else existing effective account); otherwise 409 with `{ code: 'PAYMENT_NOT_READY' | 'PAYMENT_NO_ACCOUNT' | 'PAYMENT_UNAVAILABLE' }` (400 `PAY_ACCOUNT_INVALID` for a partial dto). On success: stores the account as tonight's, a fresh `newShareToken()`, `confirmedAt`, `confirmedHash`; keeps `lastSentAt`.
  - `send(code, sendId): Promise<'sent' | 'quota' | 'failed' | 'unavailable' | 'not-confirmed' | 'stale' | 'busy'>`: `busy` when `lastSentAt` is under 5 seconds old (a double tap from a second tab with a different `sendId` must not post twice; a deliberate resend later is allowed); target must be `group` (a `host` target returns `unavailable`), re-checks `destination` and `panel` (so a lapsed plan or an unlinked group is `unavailable`), `confirmed` and not `stale`; pushes `paymentCardMessages(input, 'group')` with retry key `paymentRetryKey(code, sendId)` = the same sha1->UUIDv5-shape construction as `retryKeyFor`, hashing `jubbad-line-payment:${code}:${sendId}`; on `ok` stores `lastSentAt`. `sendId` is a UUID string validated by the DTO.
  - `shareCard(code, token): Promise<{ liffId: string; messages: unknown[]; preview: { name: string; date: string; count: number; totalSatang: number; bank: string; accountName: string } }>` (the LIFF page shows the host the total, count and who is paid before they pick a group): any failure (feature config unset, no session, not ended, target not `host`, no confirm, stale, token missing/wrong/superseded) throws the same `NotFoundException`; the token compare uses `crypto.timingSafeEqual` over equal-length buffers.
- Routes (`@Controller('sessions')`): owner-only `GET :code/payment-card`, `POST :code/payment-card/confirm`, `POST :code/payment-card/send` (always 200 with `{ outcome }`); `@Public() GET :code/payment-share-card?token=`.

- [x] **Step 1: Write failing tests** (real DB like `bill.controller.spec.ts` / `line-summary.spec.ts`, LINE client faked, both targets). Panel: rows/total match `getBill`; a removed (ไม่คิดเงิน) player is not a row; an absent (ไม่มา) player is, `absent: true`; `ready: false` while the court fee is missing and `confirm` -> 409 `PAYMENT_NOT_READY`; no account anywhere -> 409 `PAYMENT_NO_ACCOUNT`; open session -> `confirm` 409, `panel.ended === false`. Confirm: stores account and token, `confirmed: true`, `stale: false`; a second confirm yields a different token. Review-focus pins: after `setBillConfig` changes an amount, `panel.stale === true` and `shareUrl === null` and bot `send` returns `stale`; after a re-confirm the old token gets 404 from `shareCard` while the new works; wrong token, no token, token for another session, not-`host` target, unconfirmed, and nonexistent session all give identical 404 bodies; a lapsed plan between confirm and send -> `unavailable` and the fake `push` was not called; unlinking the LINE group -> `unavailable`. Send: `group` target pushes once with the Task 4 messages; same `sendId` twice produces the same retry key and two different `sendId`s produce different keys; push `quota`/`failed` map through and leave `lastSentAt` unchanged; success sets `lastSentAt` and a later `panel` shows it; a second `send` with a different `sendId` within 5 seconds returns `busy` and pushes nothing, and after 5 seconds a deliberate resend goes out; the confirm and send DTOs deliver their fields through the real global pipe (`sendId` must be a UUID, a non-UUID is 400); the group export and the public summary/display/dashboard payloads contain neither `paymentCard` nor the token. Public read returns only `{ liffId, messages, preview }`, and its JSON contains the account number (it is the card) but the public summary, display feed and `GET /dashboards/:token` payloads contain neither the number nor any amount (assert on serialized JSON). Malformed `Session.paymentCard` and `Group.payAccount` stored directly in the DB: `panel` still answers with `confirmed: false`/`account: null`, `getBill` still answers, and ending a session still succeeds.
- [x] **Step 2: Run to see them fail** (`npx vitest run src/sessions/payment-card.spec.ts src/sessions/payment-card.public.spec.ts`).
- [x] **Step 3: Implement.** Keep `panel` pure over one `getBill` call so the web panel and both send paths see identical rows. Content hash = sha256 of the canonical JSON of the card input. Reuse `lineConfig()` for `liffId` / `publicAppUrl`.
- [x] **Step 4: Run both new specs, `src/auth/auth.boundary.spec.ts`, `src/line/line-summary.spec.ts`, `src/line/line-share.spec.ts` and `src/sessions/bill.controller.spec.ts`; all pass. Run `npm run lint` in `server/`.**
- [x] **Step 5: Commit** `feat(payment): payment card service, owner routes and token-gated share read`.

---

### Task 6: Web payment panel component, service and bill-screen embed

**Files:**
- Create: `web/src/app/core/payment-card.model.ts`, `web/src/app/core/payment-card.service.ts`, `web/src/app/shared/payment-panel/payment-panel.{ts,html,css,spec.ts}`
- Modify: `web/src/app/pages/session-bill/session-bill.{ts,html}` (embed `<app-payment-panel [sessionCode]="sessionCode" [billVersion]="bill()" />` below the copy button area; the panel re-reads when the bill changes), both xlf files

**Interfaces:**
- Consumes: Task 2 `PayAccountService` types, Task 3 `<app-bank-field>`, Task 5 routes.
- Produces: `PaymentPanel` TypeScript model mirroring Task 5. `PaymentCardService`: `panel(code)`, `confirm(code, account)`, `send(code, sendId)` (each returns an observable of the Task 5 shape / `{ outcome }`). `<app-payment-panel>` with inputs `sessionCode: string`, optional `compact: boolean`, outputs `(closed)` and `(sent)`.

Panel behaviour (spec "Bill screen: the send panel"): hidden entirely (renders nothing) when `target === null`. Shows rows and total, the three account fields prefilled from `account ?? groupAccount` (bank field + number + name), a not-ready block naming what is missing (map warnings: `MISSING_COURT_FEE` -> "ยังไม่ได้ใส่ค่าสนาม", `MISSING_SHUTTLE_COUNT` -> "ยังไม่ได้ใส่จำนวนลูก", `MISSING_SHUTTLE_PRICE` -> "ยังไม่ได้ใส่ราคาลูก", `UNKNOWN_SHUTTLE_USE` -> "มีเกมที่ไม่ได้บันทึกลูก") with a link to the bill settings when embedded in the sheet. Buttons: "ยืนยันยอด" (confirm) then, per target: `group` -> "ส่งเข้ากลุ่ม" (or "ส่งอีกครั้ง" with a confirm prompt when `lastSentAt` is set; a fresh `crypto.randomUUID()` per click); `host` -> an anchor to `shareUrl` labelled "เปิดใน LINE เพื่อส่ง". `stale` shows "ยอดเปลี่ยน, ยืนยันใหม่" and hides the send action. No account anywhere -> the confirm button is disabled with "ตั้งบัญชีรับเงินในหน้าตั้งค่ากลุ่ม". An outcome message per `quota` / `failed` / `unavailable` / `busy`. Extra UX, all small: (a) when tonight's fields differ from the group default, a "ใช้บัญชีของกลุ่ม" action puts the default back; (b) a one-line hint under the account fields: "คนรับเงินไม่ต้องโอนให้ตัวเอง ใช้ ไม่คิดเงิน หรือแก้ยอดในหน้าคิดเงิน" with a link to the bill rows (the collector's own share is not netted automatically, so the host must be able to find the fix); (c) for the `host` target, text under the link: "กดแล้วเลือกกลุ่มในแอป LINE" and, after the link is used, no "sent" claim (the server cannot see a picker send); (d) all rows people-first: each row is name left, amount right, matching the card; (e) "ไม่มีใครต้องจ่าย" empty state when there are no rows, with Send and Confirm hidden.

- [x] **Step 1: Write failing tests** (HttpTestingController, as `session-bill.spec.ts` does): renders nothing for `target: null`; shows rows and total; confirm disabled without an account and enabled with all three fields; confirm posts the three fields; after confirm on `host` the anchor `href` equals `shareUrl`; on `group` send posts a UUID and shows "ส่งแล้ว"; a second send asks for confirmation first (stub `window.confirm` via the component's own method, not the global dialog); `stale: true` hides send and shows the re-confirm text; `ready: false` shows the missing-input text for each warning and no send/confirm; `quota` shows the quota message. In `session-bill.spec.ts`: the panel is present after the bill loads and re-fetches after a `bill-config` save.
- [x] **Step 2: Run to see them fail.**
- [x] **Step 3: Implement.** 44px tap targets; never show Send while `ready` is false; no `window.alert/confirm` browser dialogs (use an inline two-step button for the resend confirm).
- [x] **Step 4: Run the new specs, `session-bill.spec.ts`, and `npx ng build`.**
- [x] **Step 5: Commit** `feat(payment): shared payment panel and bill-screen embed`.

---

### Task 7: End-session tick, post-end sheet and summary-page banner

**Files:**
- Modify: `web/src/app/pages/session-dashboard/session-dashboard.{ts,html}`, `web/src/app/pages/session-summary/session-summary.{ts,html,css}`, both xlf files
- Create: `web/src/app/shared/payment-sheet/payment-sheet.{ts,html,css,spec.ts}` (bottom sheet wrapping `<app-payment-panel [compact]="true">`; follow the existing `upgrade-sheet` pattern for markup, focus and close)
- Test: `session-dashboard.spec.ts`, `session-summary.spec.ts` (existing files), `payment-sheet.spec.ts`

**Interfaces:**
- Consumes: Task 6 `PaymentCardService.panel`, `<app-payment-panel>`.
- Behaviour: the tick "ส่งใบเก็บเงินด้วย" shows when the already-fetched `lineSummary().target !== null` (no new request, and **no bill computation at dialog open**: the full panel read runs `getBill`, which is wasted work here). Its default is read from `PayAccountService.get(session().groupCode)` (Task 2/3 endpoint, fetched in `openEndSession` beside `summaryState`): checked iff the group has an account; a failed read leaves it unchecked and never blocks ending. Under the label, small helper text: "จะเปิดให้ตรวจยอดก่อนส่ง" so nobody thinks the tick sends by itself. The summary-card tick and its logic are unchanged and independent. `confirmEndSession` navigates to the summary URL with `state: { ...existing, paymentSheet: true }` when the tick is on and the end succeeded. The summary page, for the owner, reads the panel beside `loadLineSummary`; it opens the sheet once on load when `history.state.paymentSheet` is true and then clears that key with `history.replaceState` (a refresh must not reopen it); and shows a banner "ส่งใบเก็บเงินเข้ากลุ่ม" (opens the sheet) when `ended && target !== null` and either `!confirmed || stale`, or (target `group` only) `lastSentAt === null` (a confirmed card the bot has not posted yet). For target `host` the banner hides after a fresh confirm, since a picker send cannot be observed. Closing the sheet sends nothing; after a successful bot send the sheet shows "ส่งแล้ว" and a close button.

- [x] **Step 1: Write failing tests:** tick hidden when `lineSummary().target` is null; no `/payment-card` request is made when the end dialog opens (only `pay-account`); tick default on/off by whether the group account exists, and unchecked when that read fails; unticking sends `paymentSheet` false (no state key); ticking navigates with `paymentSheet: true` and the end call is the same as before (the summary tick's argument is unaffected); a pay-account read that never answers does not stop the end dialog from confirming; summary page opens the sheet when navigated with the state and not otherwise, and calls `history.replaceState` to drop the key; the banner shows for unconfirmed, for confirmed+stale, and for a confirmed-but-unsent `group` target, and not for confirmed+fresh `host`, confirmed+sent `group`, `target: null`, or a non-owner; closing the sheet leaves the banner visible.
- [x] **Step 2: Run to see them fail.**
- [x] **Step 3: Implement.** The end itself must not wait on the payment read.
- [x] **Step 4: Run the three spec files and `npx ng build`.**
- [x] **Step 5: Commit** `feat(payment): end-session tick, post-end sheet and summary banner`.

---

### Task 8: The LIFF page sends the payment card

**Files:**
- Modify: `web/src/app/app.routes.ts` (add `line-share/pay/:sessionCode/:token`, unguarded, same component), `web/src/app/pages/line-share/line-share.{ts,html}`, `web/src/app/core/line.service.ts`, `web/src/app/core/line.model.ts`, both xlf files
- Test: `web/src/app/pages/line-share/line-share.spec.ts` (existing), `web/src/app/core/line.service.spec.ts` if present

**Interfaces:**
- Consumes: Task 5 `GET /sessions/:code/payment-share-card?token=`.
- Produces: `LineService.paymentShareCard(sessionCode, token): Observable<{ liffId: string; messages: unknown[]; preview: { name: string; date: string; count: number; totalSatang: number; bank: string; accountName: string } }>`. In `line-share.ts` generalize `sessionCodeFrom` into `routeTargetFrom(snapshot): { kind: 'summary' | 'pay'; code: string; token: string | null }`: path params `sessionCode` + `token` (pay), `sessionCode` only (summary), else `liff.state` of the form `/<code>` (summary) or `/pay/<code>/<token>` (pay), URL-decoded. The pay variant fetches the payment card, shares `data.messages` (all of them), and shows its own preview ("ใบเก็บเงิน · N คน · รวม ฿X · โอนให้ <accountName> (<bank>)", so the host sees who is paid before picking a group) and success text; summary behaviour and strings are unchanged.

- [x] **Step 1: Write failing tests:** path `/line-share/pay/abc/TOK` calls the pay endpoint with the token and not the summary endpoint; `/line-share?liff.state=%2Fpay%2Fabc%2FTOK` does the same; `/line-share?liff.state=%2Fabc` still calls the summary endpoint (regression); 404 from the pay endpoint shows the existing "missing" phase; `pick()` passes every message in `messages` (two messages when the endpoint returns two) to `liff.share`; summary-page tests in the existing spec stay green untouched.
- [x] **Step 2: Run to see them fail.**
- [x] **Step 3: Implement.**
- [x] **Step 4: Run `line-share.spec.ts`, `liff-client.spec.ts` and `npx ng build`; confirm the LIFF SDK is still only in the lazy chunk.**
- [x] **Step 5: Commit** `feat(payment): LIFF page shares the payment card`.

---

### Task 9: Docs, full verification and the real-LINE checklist

**Files:**
- Modify: `docs/overview.md` (LINE section bullet + Bill section line + a one-line note on the payment-tracking decision row), `docs/line-liff-setup.md` (checklist), `dockerDeploy.md` only if a deploy step changes (it does not: one migration, run through the usual flow), `docs/superpowers/plans/2026-10-29-line-payment-card.md` (flip checkboxes)

- [x] **Step 1: Write the docs.** Overview: the separate card, the panel as the single confirm step, the token-gated public read and why (the bill is owner-only by design), `Group.payAccount` / `Session.paymentCard` and the tolerant parse, `PAYMENT_NUMBER_TEXT` and the spike result, resend semantics (no exactly-once; per-click `sendId`). Runbook: the checklist below.
- [ ] **Step 2: Real-LINE checklist (added to the runbook, run after deploy):**
  - [ ] Set the group account in settings (bank searchable, a typed unlisted bank also works).
  - [ ] Host-share group: end a session with the new tick; the sheet opens on the summary page; confirm; "เปิดใน LINE เพื่อส่ง" opens the page in LINE; pick a group; the card shows every person's amount and the account; the copy button copies the digits.
  - [ ] Same on a group that already has another bot (ขุนทอง).
  - [ ] Bot-linked group: confirm then Send posts into the group; the copy button works in the bot-sent card (if not, set `PAYMENT_NUMBER_TEXT.group = true` and redeploy); Send again asks first.
  - [ ] Edit the bill after confirming: the panel says to confirm again and the old LIFF link shows the "not found" page after re-confirm.
  - [ ] Skip the tick, close the sheet: the banner still offers the panel; the bill screen shows the same panel.
  - [ ] No account set: confirm is disabled with the pointer to settings. Free/lapsed plan or unlinked group: no panel, no tick.
  - [ ] The public summary page, display and group dashboard show no amount or account.
- [ ] **Step 3: Run the whole suite:** `npm test` at the repo root (engines, server, web), `npm run lint` in `server/`, `npx ng build` in `web/`. Report any failure with its output; do not claim green without it.
- [ ] **Step 4: Commit** `docs: LINE payment card in overview and the LIFF runbook`.
- [ ] **Step 5: Hand back to the owner for the merge and deploy decision** (finishing-a-development-branch). The deploy has one migration: take `npm run db:backup` first, check for other undeployed migrations before rebuilding (not after), and follow `dockerDeploy.md`; confirm before running anything on the home server. After the real-LINE checklist passes, archive this plan and the spec into `docs/archive/plans/` and `docs/archive/specs/`, and also archive the host share card spec and plan, whose checklist this feature's runbook now continues.
