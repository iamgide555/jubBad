# Slip Payment Matching, Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Players upload their e-slip on a LINE pay page; the server reads it for free, marks them paid when it matches, and the host sees paid/unpaid per person with manual tick and a review list for the rest.

**Architecture:** A pure slip toolkit (QR parse, amount and receiver-name matching) and a local OCR wrapper feed `SlipPaymentsService`, which owns paid state, LINE-account-to-player links, waiting slips and duplicates, all written under the existing per-session lock. A public pay-page API authenticates the viewer by verifying their LIFF access token with LINE. The web app gets a player pay page and a host section inside the existing payment panel. Phase 2 (group watching) is a separate plan, written after this ships, because it depends on measurements and checks Phase 1 produces.

**Tech Stack:** NestJS 12 + Prisma 7 (SQLite) + vitest on the server; Angular 22 (signals, standalone) on the web; new server deps `jsqr`, `jpeg-js`, `pngjs`, `tesseract.js` (devDep `qrcode` for synthetic test images).

**Spec:** `docs/superpowers/specs/2026-10-30-slip-payment-matching-design.md` (read it first; this plan covers its Phase 1 and the shared slip pipeline).

## Global Constraints

- Slip images are never persisted: no file, no database column, no log line holding image bytes or OCR text. Only the fields in spec "Slip handling pipeline" step 6, plus the receiver name and last digits on a waiting slip.
- No paid slip-verification service. OCR and QR run in-process, free.
- OCR language data (`tha`, `eng`) ships inside the container; no CDN fetch at runtime.
- Server code is ESM with `.js` import suffixes; specs are `*.spec.ts` under vitest with `fileParallelism: false` (do not turn it on).
- `engines/` is not touched.
- Slip feature is gated like the other LINE features: it needs `planAtLeast(await plans.planForGroup(groupCode), 'host')` on every public slip call, so paid effects stop when a paid plan lapses while recorded paid marks stay.
- Owner routes are not `@Public()` (OwnershipGuard refuses a non-owner with 404). Public routes answer every failure with the same 404 (`NotFoundException`) so nothing says whether a session exists or the token was wrong, and each public route is listed in `server/src/auth/auth.boundary.spec.ts`.
- Web copy: Thai is the source locale, English second (`web/src/locale/messages.en.xlf`); 44px tap targets; Thai-capable typefaces only (see `PRODUCT.md`).
- Money is integer satang everywhere; a slip's `172.00` is 17200 satang.
- Names for this feature: paid status is called "paid" in code (`SessionPayment`), never "settled" (that word already means early checkout).

## Review Focus

Inputs the spec implies that no single task's happy-path tests cover. Each has its pinning test inside the named task.

1. A non-image, empty, oversized or corrupt upload to the public endpoint: must answer a 4xx without crashing or storing anything (Task 10).
2. The same slip uploaded twice at once from two phones: exactly one payment, one duplicate event (Task 9).
3. The host edits the bill after a player was auto-paid: the mark stays and is flagged "amount changed since" (Task 7).
4. Two accounts claiming one player, or one account claiming two: refused, nothing changes (Task 8).
5. The host pays a player back, so the slip's sender block is the host's own name: must not auto-pay (Task 4).
6. A confirmed card gets reconfirmed (new token): old pay links 404 on every slip endpoint (Task 10).

---

## File Structure

Server (new under `server/src/sessions/slips/`, one responsibility per file):
- `slip-qr.ts`: slip QR payload parse and CRC, image decode to QR.
- `slip-match.ts`: pure amount and receiver-name matching on OCR output.
- `slip-ocr.ts`: tesseract.js wrapper, one worker, serial queue.
- `slip-reader.ts`: QR first, OCR only for real slips.
- `liff-identity.ts`: verifies a LIFF access token with LINE.
- `slip-payments.service.ts`: paid state, links, submit pipeline, waiting slips, duplicates.
- `slip-pay.controller.ts` (public pay-page API) and `slip-payments.controller.ts` (owner API).
- `slip-upload.middleware.ts`: raw image body parser for the upload route.
Modify: `server/prisma/schema.prisma` (+ one migration), `server/src/sessions/payment-card.service.ts` (panel gains `confirmedAt`), `server/src/line/payment-card.ts` (slip button), `server/src/line/line-config.ts` (login channel id), `server/src/sessions/sessions.module.ts`, `server/src/auth/auth.boundary.spec.ts`, `server/Dockerfile`, `dockerDeploy.md`, `docs/overview.md`.
Web: `web/src/app/core/liff-client.ts`, `core/slip-pay.model.ts`, `core/slip-pay.service.ts`, `pages/line-share/` (new slip view), `shared/payment-panel/` (host section), `app.routes.ts`, locale files.

---

### Task 1: Device spike (throwaway, not committed)

**Files:** none kept.

**Interfaces:** Produces a yes/no that gates Task 14.

- [ ] **Step 1:** On a scratch branch, add a bare page under the existing LIFF endpoint (`/line-share/slip-test`) that calls `liff.init`, prints `liff.getAccessToken() !== null`, and has `<input type="file" accept="image/*">` that logs the chosen file's `type` and `size` and POSTs it raw (`fetch(..., {method:'POST', body: file})`) to any echo URL.
- [ ] **Step 2:** Open it through `https://liff.line.me/<LINE_LIFF_ID>/slip-test` on one iPhone and one Android phone inside LINE. Pass = picker opens, a screenshot from Photos is selected, size logged, access token is non-null, and `liff.getProfile()` returns a display name (this proves the LIFF app has the `profile` scope; if it does not, ask the owner to enable it in the LINE developer console and retest). Record the result in the PR description of Task 14.
- [ ] **Step 3:** Delete the scratch branch. If the picker fails on either platform, stop and take it to the owner before Task 14.

### Task 2: Dependencies and OCR data

**Files:**
- Modify: `server/package.json`, `server/Dockerfile`
- Create: `server/assets/tessdata/eng.traineddata`, `server/assets/tessdata/tha.traineddata`, `server/assets/tessdata/README.md`

**Interfaces:** Produces the constant `TESSDATA_DIR` exported from `server/src/sessions/slips/slip-ocr.ts` (Task 5) resolving to the assets folder in both `src` and `dist` layouts.

- [ ] **Step 1:** `npm i jsqr jpeg-js pngjs tesseract.js` and `npm i -D qrcode @types/pngjs @types/qrcode` in `server/`.
- [ ] **Step 2:** Download the `tessdata_fast` `eng` and `tha` files into `server/assets/tessdata/`; the README states the source URL, licence (Apache-2.0) and download date. Check combined size is under 20 MB; if not, say so in the PR.
- [ ] **Step 3:** In `server/Dockerfile` runtime stage, `COPY --from=build /repo/server/assets ./assets`. In `nest-cli.json` make sure `assets` is copied to `dist` or that `TESSDATA_DIR` resolves from the project root; whichever applies, `node dist/server/src/main.js` must find the files.
- [ ] **Step 4:** `npm run build` in `server/`; expected: no errors. Commit: `chore(slips): add QR and OCR dependencies and bundled language data`.

### Task 3: Slip QR parsing

**Files:**
- Create: `server/src/sessions/slips/slip-qr.ts`
- Test: `server/src/sessions/slips/slip-qr.spec.ts`

**Interfaces:**
- Produces: `interface SlipQr { bankCode: string; reference: string }`, `parseSlipQr(payload: string): SlipQr | null`, `decodeSlipQr(image: Buffer): SlipQr | null` (JPEG or PNG; anything else, corrupt, or no QR gives `null`, never throws), and a test helper `makeSlipPayload(bankCode: string, reference: string): string` exported from the same file for tests.

Format (spec "Facts"): outer TLV tags of 2-digit tag + 2-digit length: `00` holds inner TLV `00`=`000001` (API id), `01`=3-digit sending-bank code, `02`=transaction reference; then `51`=`TH`; `91`=4 hex CRC-16/CCITT-FALSE over everything before the CRC value (including `9104`).

- [ ] **Step 1: Failing tests**, using synthetic references only (do not commit real ones):
  - `parseSlipQr(makeSlipPayload('004','ABC123'))` returns `{ bankCode: '004', reference: 'ABC123' }`.
  - a payload with one changed character in the reference returns `null` (CRC).
  - a PromptPay payload starting `000201` returns `null`; empty string returns `null`.
  - `decodeSlipQr` of a PNG generated with `qrcode` from a `makeSlipPayload` string returns the same parse; of a PNG of a plain URL QR returns `null`; of `Buffer.from('not an image')` returns `null`; of a JPEG re-encoded from the PNG (via `jpeg-js` encode at quality 60) still returns the parse.
- [ ] **Step 2:** `npx vitest run src/sessions/slips/slip-qr.spec.ts`; expected FAIL (module missing).
- [ ] **Step 3:** Implement with `jsQR`; decode JPEG with `jpeg-js`, PNG with `pngjs`, sniffing the magic bytes. Reject images over 8000 px on a side before decoding.
- [ ] **Step 4:** Run again; expected PASS. Commit: `feat(slips): parse and validate the slip QR`.

### Task 4: Amount and receiver matching (pure)

**Files:**
- Create: `server/src/sessions/slips/slip-match.ts`
- Test: `server/src/sessions/slips/slip-match.spec.ts`

**Interfaces:**
- Produces:
  - `interface OcrLine { text: string; y0: number; y1: number }`
  - `amountPresent(text: string, satang: number): boolean`
  - `owedAmountsFound(text: string, owedSatang: number[]): number[]` (distinct values from `owedSatang` present as whole tokens)
  - `receiverNameMatches(lines: OcrLine[], savedName: string): boolean`
  - `receiverName(lines: OcrLine[]): string | null` (the lowest name block's text, title removed)
  - `receiverTail(text: string): string | null` (last 4 digits of the masked receiver number, e.g. `5953`)

Rules (spec "Auto-paid rule" 4 and "open decision 2"):
- Amount token: digits with optional thousands commas then `.` and exactly two digits, not preceded or followed by another digit, comma or dot-digit (so `1172.00` does not contain `172.00`). `0` owed is never present.
- Name lines are OCR lines, spaces removed, starting with a title (`นางสาว`, `น.ส.`, `นส.`, `นาย`, `นาง`, `Mr`, `Mrs`, `Ms`, `Miss`).
- Two or more name lines: the receiver block is the one with the largest `y0`. Exactly one name line: it is the receiver unless the line directly above it, or the same line, holds `จาก` or `From`. Zero name lines: no match.
- Saved name is split on whitespace, titles dropped; every word must equal a whole word of the receiver block. A word of five or more characters may differ by one character. A saved name whose words are all two characters or fewer never matches.

- [ ] **Step 1: Failing tests** for each:
  - `amountPresent('จำนวนเงิน 172.00 บาท', 17200)` true; `'1172.00'` with 17200 false; `'1,172.00'` with 117200 true; `'172.0'` false; `amountPresent('0.00', 0)` false.
  - `owedAmountsFound('172.00 ... 150.00', [17200, 15000, 9900])` equals `[17200, 15000]`.
  - Receiver cases built as `OcrLine[]` fixtures: sender-top `นาย ธนัช อ.` / receiver-below `น.ส. จิตติญา ฉัตรเฉลิมวิทย์` with saved `จิตติญา` true; with saved `ธนัช` (host is the sender) false (Review Focus 5); saved `นก` against a receiver `น.ส. ภัคชนก` false; saved `จิตติญา ฉัตรเฉลิมวิทย์` against a one-character OCR misread `จิตติญา ฉัตรเฉลิมวิทย` true; saved `ต้อม` against `ต้อง` false (four characters, no tolerance); one titled line `น.ส. จิตติญา` below an untitled English sender with saved `จิตติญา` true; one titled line preceded by `จาก` false; a title-less slip false.
  - `receiverName` on the first fixture returns `จิตติญา ฉัตรเฉลิมวิทย์`; `receiverTail('xxx-xxx-5953')` returns `5953`, `'062-xxx-5953'` too, `'no digits'` null.
- [ ] **Step 2:** Run `npx vitest run src/sessions/slips/slip-match.spec.ts`; expected FAIL.
- [ ] **Step 3:** Implement as pure functions. Commit: `feat(slips): amount and receiver-name matching`.
- [ ] **Step 4:** Run; expected PASS.

### Task 5: OCR wrapper and slip reader

**Files:**
- Create: `server/src/sessions/slips/slip-ocr.ts`, `server/src/sessions/slips/slip-reader.ts`, `server/scripts/slip-check.ts`
- Test: `server/src/sessions/slips/slip-reader.spec.ts`, `server/src/sessions/slips/slip-ocr.fixtures.spec.ts`

**Interfaces:**
- Consumes: `decodeSlipQr`, `SlipQr` (Task 3), `OcrLine` (Task 4).
- Produces:
  - `TESSDATA_DIR: string`
  - `interface SlipOcrResult { text: string; lines: OcrLine[] }`
  - `@Injectable() class SlipOcr { read(image: Buffer): Promise<SlipOcrResult> }` (one tesseract worker with `tha`+`eng` and `langPath: TESSDATA_DIR`, `cacheMethod: 'none'`, `gzip: false`; reads run one at a time; the worker is created lazily and terminated in `onModuleDestroy`). Verified against tesseract.js 7.0.0: `data.lines` does not exist, so call `worker.recognize(image, {}, { blocks: true })` and flatten `data.blocks[].paragraphs[].lines[]`, taking `text` and `bbox.y0`/`bbox.y1` from each line.
  - `type SlipRead = { kind: 'not-slip' } | { kind: 'slip'; qr: SlipQr; ocr: SlipOcrResult }`
  - `@Injectable() class SlipReader { read(image: Buffer): Promise<SlipRead> }`

- [ ] **Step 1: Failing tests** (`slip-reader.spec.ts`, with a fake `SlipOcr`): an image with no slip QR returns `{kind:'not-slip'}` and the fake OCR is **not called**; an image with a valid slip QR returns `kind:'slip'` with the QR and the fake's result.
- [ ] **Step 2:** Run; expected FAIL. Implement `SlipOcr` and `SlipReader`; run; expected PASS.
- [ ] **Step 3:** `slip-ocr.fixtures.spec.ts` runs only when `SLIP_FIXTURE_DIR` is set (`describe.skipIf`): for every image in the folder it asserts `SlipReader.read` returns `kind:'slip'` and `ocr.text` contains a `\d+\.\d{2}` token. `scripts/slip-check.ts <dir>` prints per image: QR bank code, reference, amount-like tokens, `receiverName(lines)`, `receiverTail(text)`, milliseconds. Do not commit any slip image.
- [ ] **Step 4:** Run the script against the owner's four slips in `~/Downloads` (ask the owner for the folder). Expected: all four read, each under 2 s. Commit: `feat(slips): OCR wrapper and slip reader`.

### Task 6: Schema and migration

**Files:**
- Modify: `server/prisma/schema.prisma`
- Create: `server/prisma/migrations/20261030000000_slip_payments/migration.sql`
- Test: `server/src/sessions/slips/slip-schema.spec.ts`

**Interfaces:** Produces these Prisma models (all `groupId`/`sessionId` reference `Group.code`/`Session.code`; group and session relations are `onDelete: Cascade`; id fields are `String @id @default(cuid())`):
- Player relations are `onDelete: Cascade` as well, so deleting a player never leaves an orphan row.
- `PlayerLineAccount { groupId, playerId, lineUserId, displayName String?, linkedBy String /* 'self'|'host' */, createdAt; @@unique([groupId, lineUserId]); @@unique([groupId, playerId]) }`
- `SessionPayment { sessionId, playerId, source String /* 'slip'|'host' */, amountSatang Int?, reference String?, createdAt; @@unique([sessionId, playerId]) }`
- `SlipReference { groupId, reference, bankCode, sessionId String?, lineUserId String?, createdAt; @@unique([groupId, reference]) }`
- `PendingSlip { sessionId, groupId, reference, lineUserId, displayName String?, pictureUrl String? /* the profile picture's address, not the image */, amountSatang Int?, receiverName String?, receiverTail String?, reason String /* 'unmapped'|'amount'|'receiver'|'unreadable'|'stale'|'collision' */, resolvedAt DateTime?, createdAt }`
- `SlipDuplicate { groupId, sessionId String?, reference, lineUserId, displayName String?, originalPlayerIds String /* JSON string[] */, dismissedAt DateTime?, createdAt }`

- [ ] **Step 1: Failing test** (`slip-schema.spec.ts`, real dev DB like other specs): a second `PlayerLineAccount` with the same `(groupId, lineUserId)` or the same `(groupId, playerId)` rejects; a second `SessionPayment` for the same `(sessionId, playerId)` rejects; a second `SlipReference` with the same `(groupId, reference)` rejects; deleting the group removes all five tables' rows.
- [ ] **Step 2:** Run; FAIL. Edit the schema, then `npx prisma migrate dev --name slip_payments --create-only`, check the SQL matches the file name above, apply with `npx prisma migrate deploy`; regenerate the client.
- [ ] **Step 3:** Run; PASS. Commit: `feat(slips): schema for paid state, account links, pending slips`.

### Task 7: Paid state, manual tick, panel fields

**Files:**
- Create: `server/src/sessions/slips/slip-payments.service.ts`
- Modify: `server/src/sessions/payment-card.service.ts` (add the public method below), `server/src/sessions/sessions.module.ts`
- Test: `server/src/sessions/slips/slip-payments.paid.spec.ts`

**Interfaces:**
- Consumes: `PaymentCardService.panel(code)` (rows, `confirmed`, `stale`, `account`).
- Produces on `PaymentCardService`: `tokenValid(code: string, token: string | undefined): Promise<boolean>`, true only when the session's stored card token equals `token` (reuse the private `sameToken`; any missing session or state is `false`, never a throw). `PaymentCardService` has no such public method today.
- Produces on `SlipPaymentsService`:
  - `interface PaidRow { playerId: string; source: 'slip' | 'host'; at: string; amountChangedSince: boolean }`
  - `getPaid(code: string): Promise<PaidRow[]>` (`amountChangedSince` true when the stored `amountSatang` differs from the player's current panel row)
  - `tick(code: string, playerId: string): Promise<void>` (source `host`; no-op if already paid; 409 `PLAYER_NOT_ON_BILL` if the player has no row)
  - `untick(code: string, playerId: string): Promise<void>` (removes any paid mark; the slip's `SlipReference` stays, so a repost is a duplicate)
  All writes run in `SessionLock.run(code, ...)`.

- [ ] **Step 1: Failing tests:** `tokenValid` is true for the confirmed card's token, false for another string, `undefined`, an unconfirmed session and an unknown code; tick marks paid and `getPaid` shows `source:'host'`; ticking twice leaves one row; untick removes it; tick of a player not on the bill throws `PLAYER_NOT_ON_BILL`; after a slip-paid row exists (insert directly with `amountSatang: 17200`), changing the bill so the player's row is 18000 makes `getPaid` return `amountChangedSince: true` and the row stays (Review Focus 3).
- [ ] **Step 2:** Run `npx vitest run src/sessions/slips/slip-payments.paid.spec.ts`; FAIL. Implement; PASS. Commit: `feat(slips): per-person paid state with host tick and undo`.

### Task 8: Account links

**Files:**
- Modify: `server/src/sessions/slips/slip-payments.service.ts`
- Test: `server/src/sessions/slips/slip-payments.links.spec.ts`

**Interfaces:**
- Produces:
  - `interface LiffUser { userId: string; displayName: string | null; pictureUrl: string | null }` (the pay page's profile call supplies all three; the host prompt shows name and avatar from the stored values)
  - `type ClaimOutcome = 'linked' | 'player-taken' | 'account-already-linked' | 'not-on-bill'`
  - `claimPlayer(code: string, user: LiffUser, playerId: string): Promise<ClaimOutcome>` (links with `linkedBy:'self'`)
  - `linkedPlayerOf(groupCode: string, lineUserId: string): Promise<string | null>`
  - `listLinks(code: string): Promise<{ playerId: string; displayName: string | null; linkedBy: 'self' | 'host' }[]>`
  - `setLink(code: string, playerId: string, lineUserId: string | null): Promise<void>` (host: repoints or, with `null`, removes the player's link)

- [ ] **Step 1: Failing tests:** claim links and `linkedPlayerOf` returns the player; a second account claiming the same player returns `player-taken` and changes nothing; the same account claiming a second player returns `account-already-linked` (Review Focus 4); `setLink(code, p, null)` removes it; `setLink` to an account already linked to another player throws `ACCOUNT_ALREADY_LINKED`.
- [ ] **Step 2:** Run; FAIL. Implement (under the session lock, using the group of the session); PASS. Commit: `feat(slips): link LINE accounts to players`.

### Task 9: Submit pipeline

**Files:**
- Modify: `server/src/sessions/slips/slip-payments.service.ts`
- Test: `server/src/sessions/slips/slip-payments.submit.spec.ts`

**Interfaces:**
- Consumes: `SlipReader`, `amountPresent`, `owedAmountsFound`, `receiverNameMatches`, `receiverName`, `receiverTail` (Tasks 3 to 5), `PlansService.planForGroup`, `PaymentCardService.panel` and `PaymentCardService.tokenValid` (Task 7).
- Scope note: a pay link belongs to one session, so a slip is matched against that session's bill only. The spec's "look across every unpaid bill in the group" (call 3) needs the group-chat entry point and is left to the Phase 2 plan; the reference check is already per group, so one slip can never pay twice across sessions.
- Produces:
  - `type WaitingReason = 'unmapped' | 'amount' | 'receiver' | 'unreadable' | 'stale' | 'collision'`
  - `type SubmitOutcome = { kind: 'paid'; playerIds: string[] } | { kind: 'waiting'; reason: WaitingReason } | { kind: 'duplicate' } | { kind: 'not-slip' } | { kind: 'unavailable' }`
  - `submitSlip(code: string, token: string, user: LiffUser, image: Buffer, now?: Date): Promise<SubmitOutcome>`

Order inside the lock: token matches the card's current token, else `unavailable`; plan at least `host`, else `unavailable`; card confirmed (not confirmed gives `unavailable`); read the slip (`not-slip` records nothing); reference already in `SlipReference` for the group gives `duplicate` and a `SlipDuplicate` row (originals taken from the earlier slip's paid players); otherwise record the reference (a waiting slip stores the viewer's `displayName` and `pictureUrl`), then: stale card gives waiting `stale`; sender unlinked gives waiting `unmapped`; sender's own player not on the bill, or already paid, gives waiting `collision`; amount of the sender's own row not present gives waiting `amount`; receiver name check (skipped when the group has no saved name) fails gives waiting `receiver`; otherwise `paid` with that one player, `source:'slip'`, `amountSatang`, `reference`. A waiting slip stores `amountSatang` only when `owedAmountsFound` returns exactly one value, and stores `receiverName`/`receiverTail` when the reason is `receiver`; if the OCR text has no amount token at all the reason is `unreadable`. The OCR text and image are dropped before the function returns.

- [ ] **Step 1: Failing tests** (fake `SlipReader` returning canned `SlipRead`s; real DB): matching slip from a linked player gives `paid` and a `SessionPayment` with `source:'slip'`; same reference again gives `duplicate`, no second payment, one `SlipDuplicate` row; two simultaneous calls with the same reference give exactly one `paid` and one `duplicate` (Review Focus 2); wrong token gives `unavailable` and records nothing; lapsed plan (owner `planRenewsAt` in the past) gives `unavailable`; stale card gives `waiting/stale`; unlinked sender gives `waiting/unmapped`; amount off gives `waiting/amount` with `amountSatang` set only when exactly one owed amount was found; receiver mismatch gives `waiting/receiver` with `receiverName` stored; group with no saved name skips the receiver check; `not-slip` leaves `SlipReference` empty; after `untick`, the same slip again is `duplicate`.
- [ ] **Step 2:** Run; FAIL. Implement; PASS. Commit: `feat(slips): submit pipeline with auto-paid, waiting and duplicates`.

### Task 10: Resolve waiting slips, duplicates, update saved name

**Files:**
- Modify: `server/src/sessions/slips/slip-payments.service.ts`
- Test: `server/src/sessions/slips/slip-payments.resolve.spec.ts`

**Interfaces:**
- Consumes: `GroupsService.setPayAccount` semantics (validate with `validatePayAccount`, write with `serializePayAccount`).
- Produces:
  - `listWaiting(code: string): Promise<WaitingSlip[]>` where `WaitingSlip = { id: string; reason: WaitingReason; displayName: string | null; pictureUrl: string | null; lineUserId: string; amountSatang: number | null; receiverName: string | null; receiverTail: string | null; createdAt: string; candidatePlayerIds: string[] }` (candidates = unpaid players whose current row equals `amountSatang`; all unpaid players when it is null)
  - `resolveWaiting(code: string, id: string, input: { coversPlayerIds: string[]; senderPlayerId: string | null }): Promise<void>` (`coversPlayerIds` non-empty, all on the bill; marks them paid `source:'slip'`; a non-null sender links the account `linkedBy:'host'`, conflicts throw `ACCOUNT_ALREADY_LINKED`; sets `resolvedAt`)
  - `dismissWaiting(code: string, id: string): Promise<void>`
  - `listDuplicates(code: string)`, `dismissDuplicate(code: string, id: string): Promise<void>`
  - `updateSavedReceiverName(code: string, waitingId: string): Promise<void>` (only for a `receiver`-reason slip with a stored `receiverName`; sets the group's pay-account `name` to it, keeping bank and number)

- [ ] **Step 1: Failing tests:** resolve with two covered players marks both paid and clears the waiting slip; resolve with `senderPlayerId` links the account; sender already linked elsewhere throws; empty `coversPlayerIds` throws `COVERS_REQUIRED`; `listWaiting` candidates narrow to the equal-amount players; `updateSavedReceiverName` changes only `name` in `Group.payAccount`; calling it on an `amount`-reason slip throws `NAME_UPDATE_NOT_APPLICABLE`; a name that fails `validatePayAccount` throws.
- [ ] **Step 2:** Run; FAIL. Implement (in the lock); PASS. Commit: `feat(slips): host review of waiting slips and duplicates`.

### Task 11: Verify LIFF identity

**Files:**
- Create: `server/src/sessions/slips/liff-identity.ts`
- Modify: `server/src/line/line-config.ts` (add `loginChannelId: string | null` from `LINE_LOGIN_CHANNEL_ID`)
- Test: `server/src/sessions/slips/liff-identity.spec.ts`

**Interfaces:**
- Consumes: `LiffUser` (Task 8).
- Produces: `@Injectable() class LiffIdentity { verify(accessToken: string): Promise<LiffUser | null> }`. It calls `GET https://api.line.me/oauth2/v2.1/verify?access_token=...`, requires `client_id` equal to `lineConfig().loginChannelId` and `expires_in > 0`, then `GET https://api.line.me/v2/profile` with the bearer token for `userId`, `displayName` and `pictureUrl`. This needs the **`profile` scope** enabled on the LIFF app in the LINE developer console, which the owner must switch on (existing viewers are asked to consent again); say so in Task 16's deploy notes. Any failure, timeout (3 s) or missing config returns `null`. A caller-supplied user id is never trusted.

- [ ] **Step 1: Failing tests** (mock `fetch`): valid token gives the user; `client_id` for another channel gives `null`; expired gives `null`; profile call failing gives `null`; network error gives `null`; unset `LINE_LOGIN_CHANNEL_ID` gives `null` with no fetch made.
- [ ] **Step 2:** Run; FAIL. Implement; PASS. Commit: `feat(slips): verify LIFF access tokens with LINE`.

### Task 12: HTTP API

**Files:**
- Create: `server/src/sessions/slips/slip-pay.controller.ts`, `server/src/sessions/slips/slip-payments.controller.ts`, `server/src/sessions/slips/slip-upload.middleware.ts`
- Modify: `server/src/sessions/sessions.module.ts`, `server/src/auth/auth.boundary.spec.ts`
- Test: `server/src/sessions/slips/slip-pay.controller.spec.ts`, `server/src/sessions/slips/slip-payments.controller.spec.ts`

**Interfaces:**
- Consumes: Tasks 7 to 11, `LoginThrottle` (`check`, `recordFailure`, `recordSuccess`). Throttle keys: a request whose LIFF token fails verification counts against `slip-ip:${request ip}`; once the viewer is known, a bad pay token or an `unavailable` outcome counts against `slip:${code}:${userId}`. Waiting, duplicate and paid outcomes are not failures.
- Produces public routes (all `@Public()`, token in `?token=`, viewer's LIFF token in header `X-Line-Access-Token`, every failure a 404, a throttled caller a 429):
  - `GET /sessions/:code/slip-pay` returns `{ amountSatang: number | null; playerName: string | null; claimable: { playerId: string; name: string }[]; accountName: string; alreadyPaid: boolean }` (`claimable` lists unpaid, unlinked players on the bill)
  - `POST /sessions/:code/slip-pay/claim` body `{ playerId }` returns `{ outcome: ClaimOutcome }`
  - `POST /sessions/:code/slip-pay/upload` raw `image/*` body, 8 MB limit via `slip-upload.middleware.ts` (`express.raw`), returns `{ outcome: SubmitOutcome['kind']; reason?: WaitingReason }`; non-image or empty body is 400, over the limit 413.
- Produces owner routes (OwnershipGuard, not public) under `/sessions/:code/payments`: `GET` (paid rows, waiting slips, duplicates, links), `POST tick` and `POST untick` body `{ playerId }`, `POST waiting/:id/resolve`, `POST waiting/:id/dismiss`, `POST waiting/:id/update-name`, `POST duplicates/:id/dismiss`, `POST links` body `{ playerId, lineUserId: string | null }`.

- [ ] **Step 1: Failing tests:** each public route with no header, a bad token and a wrong card token answers 404 with the same body; after a reconfirm (new token) the old token 404s on all three (Review Focus 6); upload with a text body is 400, with an empty body 400, with 9 MB 413 and nothing is written (Review Focus 1); a valid upload returns the outcome kind; the eleventh failed attempt from one user for one session is 429; owner routes refuse a non-owner with 404 and an anonymous caller with 401; `tick`/`untick` round-trip through `GET`.
- [ ] **Step 2:** Add the three public paths to the public list in `auth.boundary.spec.ts` with a comment like the neighbouring entries. Run; FAIL. Implement and register in the sessions module (middleware via `configure(consumer)` so specs that build `AppModule` get it); PASS.
- [ ] **Step 3:** `npm test` in `server/`; expected all green. Commit: `feat(slips): pay-page and host API`.

### Task 13: Card button

**Files:**
- Modify: `server/src/line/payment-card.ts`, `server/src/sessions/payment-card.service.ts`
- Test: `server/src/line/payment-card.spec.ts`

**Interfaces:**
- Produces: `liffSlipUrl(liffId: string, sessionCode: string, token: string): string` returning `https://liff.line.me/${liffId}/slip/${encodeURIComponent(sessionCode)}/${encodeURIComponent(token)}`; `paymentCardMessages(input, target, slipUrl?: string | null)` where a non-null `slipUrl` adds a secondary footer button `{ type:'button', style:'secondary', action:{ type:'uri', label:'ส่งสลิป', uri: slipUrl } }` after the copy button on the `group` card. `PaymentCardService.send` passes the URL when `liffId` is configured and the token exists; the host DM card is unchanged.

- [ ] **Step 1: Failing tests:** `liffSlipUrl` output exactly as above with a code containing a space; `paymentCardMessages(input, 'group', url)` footer has two buttons, the second a `uri` action with the Thai label; without `slipUrl` the card is byte-identical to today's (existing tests keep passing); label length is within LINE's 20-character limit.
- [ ] **Step 2:** Run; FAIL. Implement; PASS. Commit: `feat(slips): send-slip button on the group payment card`.

### Task 14: Player pay page (web)

**Files:**
- Modify: `web/src/app/core/liff-client.ts` (add `getAccessToken(): string | null`), `web/src/app/app.routes.ts`, `web/src/locale/messages.xlf`, `web/src/locale/messages.en.xlf`
- Create: `web/src/app/core/slip-pay.model.ts`, `web/src/app/core/slip-pay.service.ts`, `web/src/app/pages/slip-pay/slip-pay.ts`, `slip-pay.html`, `slip-pay.css`
- Test: `web/src/app/pages/slip-pay/slip-pay.spec.ts`, `web/src/app/core/slip-pay.service.spec.ts`

**Interfaces:**
- Consumes: the Task 12 public routes.
- Produces: route `line-share/slip/:sessionCode/:token` (unguarded, lazy, same style as the pay route; read `liff.state` `/slip/<code>/<token>` like `routeTargetFrom` in `pages/line-share/line-share.ts`; when `LiffClient.isLoggedIn()` is false, call `login(redirectUri)` exactly as the share page's `login` phase does, because the access token only exists after login); `SlipPayService` with `view(code, token, accessToken)`, `claim(...)`, `upload(code, token, accessToken, file: File)`; the page implements mockups A, A1, A2: amount and receiver, **ส่งสลิป** picks a photo and starts the upload at once, first time shows the "I'm ..." list first with a skip option, result states for `paid` / `waiting` (explains "ส่งให้โฮสต์ตรวจแล้ว") / `duplicate` / `not-slip` / `unavailable`, and a **ฉันจ่ายเงินสดแล้ว** note that tells the player to tell the host (no server call).

- [ ] **Step 1: Failing tests:** service sends `X-Line-Access-Token` and the token query and posts the file as the raw body with its content type; page shows the amount and name when linked; shows the claim list when not linked; picking a file calls `upload` once and shows the paid state; a `waiting` outcome shows the host-review text; a 404 shows the unavailable state; the file input has `accept="image/*"` and the action buttons are at least 44px tall.
- [ ] **Step 2:** `cd web && npx ng test --include='**/slip-pay*.spec.ts'` (or the project's single-file form); FAIL. Implement with signals, add Thai source strings with `i18n` ids and the English entries; PASS.
- [ ] **Step 3:** Phone check on the Task 1 devices with a real confirmed card: open from the group card button, claim, upload a real slip, see the host list update. Commit: `feat(slips): player pay page with slip upload`.

### Task 15: Host section in the payment panel (web)

**Files:**
- Modify: `web/src/app/shared/payment-panel/payment-panel.ts`, `payment-panel.html`, `web/src/app/core/payment-card.service.ts`, locale files
- Create: `web/src/app/core/slip-host.model.ts`
- Test: `web/src/app/shared/payment-panel/payment-panel.spec.ts` (extend)

**Interfaces:**
- Consumes: the Task 12 owner routes.
- Produces in the panel, below the rows and only once the card is confirmed: per-person status chips (unpaid / **สลิป** for slip / **โฮสต์ติ๊ก** for host tick, with an "amount changed" marker), tap a row to tick or undo, a **รอตรวจ N** badge, the waiting-slip prompt (mockups C and C2: "this slip covers" multi-select, "the sender is" single optional pick with the pre-fill rule from the spec, the **Update saved name** button behind a confirmation that shows old and new name), and the duplicate list with an acknowledge action. The waiting-slip prompt shows the sender's name and avatar (`pictureUrl`). A "linked LINE accounts" list shows each player's link with a self/host label and lets the host remove or repoint one. Do not reuse the existing "จ่ายแล้ว N คน" copy (it means early checkouts).

- [ ] **Step 1: Failing tests:** the linked-accounts list shows the self/host label and its remove action calls the links route with `lineUserId: null`; a waiting slip with a `pictureUrl` renders the avatar and one without renders a placeholder; chips render the right source label; tapping an unpaid row calls tick, a paid row calls untick; the badge counts waiting slips plus undismissed duplicates; with one ticked player and an unlinked sender the "sender is" pick is pre-filled with that player and can be cleared; confirming sends both lists; the update-name button is absent for an `amount`-reason slip and shows a confirmation with old and new name for a `receiver`-reason one; nothing from this section renders before the card is confirmed.
- [ ] **Step 2:** Run the web test for the file; FAIL. Implement; PASS. Commit: `feat(slips): host paid status and waiting-slip review`.

### Task 16: Purge, config docs, overview

**Files:**
- Modify: `server/src/line/line-link.service.ts` (the unlink path), `server/src/groups/groups.service.ts` (group delete relies on cascade; verify), `dockerDeploy.md`, `docs/overview.md`
- Test: `server/src/line/line-link.spec.ts` (extend)

**Interfaces:** Consumes Task 6 models.

- [ ] **Step 1: Failing test:** after a LINE unlink, that group's `PlayerLineAccount`, `PendingSlip`, `SlipDuplicate` and `SlipReference` rows are gone and its `SessionPayment` rows remain (spec default: links purged on unlink; recorded payments stay).
- [ ] **Step 2:** Run; FAIL. Add the deletes to the unlink path; PASS.
- [ ] **Step 3:** `dockerDeploy.md`: document `LINE_LOGIN_CHANNEL_ID` (the LINE Login channel that owns the LIFF app), that the LIFF app needs the `profile` scope switched on in the LINE developer console (players are asked to consent the first time they open the pay page), and that `assets/tessdata` ships in the image. `docs/overview.md`: add a "Slip payment matching" section covering the phase split, the QR and OCR approach, no image storage, the paid-vs-settled naming and the auto-paid rules (point at the spec rather than restating it).
- [ ] **Step 4:** Run `npm test` at the repo root; expected all three suites green. Commit: `docs(slips): deploy notes and overview; purge on unlink`.

---

## Self-Review

- **Spec coverage (Phase 1):** pipeline steps 0 to 7 (Tasks 3, 5, 9 and the controller's size cap and throttle in 12; spec step 0's queue is the serial `SlipOcr` in Task 5, since uploads arrive on the pay-page route and not on the LINE webhook); auto-paid rules 1 to 6 (Tasks 4, 7, 9); host prompt, name-update, duplicates (Task 10, 15); pay-page upload and self-claim (Tasks 11, 12, 14); manual tick (Tasks 7, 15); plan gating and lapse (Task 9); purge (Task 16); card entry point (Task 13). Phase 2 items (group image events, setup screen, roster-name suggestion, LINE privacy notice) are deliberately not here.
- **Known carry-over for the Phase 2 plan:** account ids from LIFF (LINE Login channel) match the webhook's `source.userId` (Messaging API channel) only if both channels sit under the same LINE provider; Phase 2 must check this first, and until then the links made here are LIFF-only.
- **Type consistency:** `LiffUser` is defined in Task 8 and used in 9, 11, 12; `WaitingReason` and `SubmitOutcome` in Task 9 are the ones Tasks 10 and 12 use; `OcrLine` from Task 4 is used by Task 5.
