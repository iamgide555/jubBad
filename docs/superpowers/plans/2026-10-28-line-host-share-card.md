# LINE host share card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At จบรอบ, a group whose owner linked their LINE by DM (and has no bot in the group) gets the summary card DMed to the host with a "ส่งเข้ากลุ่ม" button that opens a LIFF page where the host picks a group and LINE sends the card as the host.

**Architecture:** `LineSummaryService` learns a second *target* (`host`) beside `group`, reusing the existing claim / sent marker / retry key. `summaryCard` gains an optional share button. A public endpoint serves the card + LIFF id to a new unguarded web route `/line-share/:sessionCode`, which calls `liff.shareTargetPicker`. No schema change.

**Tech Stack:** NestJS + Prisma + vitest (server), Angular 22 standalone + signals + `ng test` (web), `@line/liff` (lazy-loaded on one route only).

**Spec:** `docs/superpowers/specs/2026-10-28-line-host-share-card-design.md`

Work on a branch, not main (main runs real weekly sessions): create `feat/line-host-share-card` in a worktree via superpowers:using-git-worktrees before Task 1.

## Global Constraints

- Group-linked behavior is byte-identical to today: same push, same card JSON, same outcomes.
- Env value `LINE_LIFF_ID`. Absent (or `PUBLIC_APP_URL` absent) → the `host` target is off everywhere; nothing else changes.
- One push per session per host DM; reuse `lineSummarySentAt`, `lineSummaryClaimedAt`, the 30 000 ms stale claim and `retryKeyFor`. No migration.
- A group that is both bot-linked and DM-enabled is target `group`.
- Target `host` requires: `lineGroupId === null`, `lineDmEnabled`, owner `lineUserId != null`, owner plan ≥ `host` (read at request time), ≥ 1 finished game, session ended.
- LIFF URL shape: `https://liff.line.me/<LINE_LIFF_ID>/<sessionCode>`; LIFF endpoint URL is `<PUBLIC_APP_URL>/line-share`.
- Card text Thai-only. DM card alt text unchanged: `สรุปก๊วน <ชื่อกลุ่ม> <วันที่>`. Shared (group-bound) card has no share button.
- Host-facing UI strings Thai primary + English (`$localize` / `i18n`, both xlf files updated the way commit `a8c80a0` did).
- The public card endpoint returns only fields the public summary page already shows. No owner/user/LINE ids.
- The LIFF SDK loads only on `/line-share`.
- Server specs run serially (`fileParallelism: false`); do not change that.

## Review Focus

- Host blocked/unfriended the bot → push fails → outcome `failed`, session still ended, resend still offered (Task 2).
- Group later linked or unlinked after a DM was sent → `lineSummarySentAt` still reads sent; no second card of either kind (Task 2).
- Public card endpoint called for a group-linked session, an unended session, a zero-game session or a lapsed plan → 404, never a card (Task 3).
- Session code with odd characters in the LIFF URL / route param → encoded, never breaks the path (Tasks 1, 5).
- Host opens the LIFF page where `shareTargetPicker` is unavailable, or closes the picker without sending → clear message / stay on page, no error state (Task 5).
- Host's LINE not logged in (iPad / external browser) → `login` is called once with the current URL, not looped (Task 5).
- Long group name / venue still clipped on the DM card with the extra button (Task 1).

---

### Task 1: Config, LIFF URL and the DM card button

**Files:**
- Modify: `server/src/line/line-config.ts`, `server/src/line/line-config.spec.ts`
- Modify: `server/src/line/line-summary-card.ts`, `server/src/line/line-summary-card.spec.ts`
- Modify: `server/.env.example`, `dockerDeploy.md` (mirror how `PUBLIC_APP_URL` is documented)

**Interfaces:**
- Produces: `LineConfig.liffId: string | null`; `export function liffShareUrl(liffId: string, sessionCode: string): string`; `SummaryCardInput.shareUrl?: string`.

- [ ] **Step 1: Write failing tests**
  - `line-config.spec.ts`: `lineConfig().liffId` is `null` when `LINE_LIFF_ID` is unset or whitespace; trimmed value otherwise.
  - `line-summary-card.spec.ts`:
    - `liffShareUrl('1234-abc', 'ab c/d')` equals `'https://liff.line.me/1234-abc/ab%20c%2Fd'`.
    - `summaryCard({...base})` deep-equals the output captured from the current code (snapshot the existing object literal in the test) — "without shareUrl the card is unchanged".
    - with `shareUrl: 'https://liff.line.me/x/y'`: `footer.contents` has 2 buttons; first is the `ดูสรุป` primary uri button unchanged; second is `{ type:'button', style:'secondary', action:{ type:'uri', label:'ส่งเข้ากลุ่ม', uri:'https://liff.line.me/x/y' } }`; `altText` equals the no-share card's altText.
    - a 200-char group name and venue with `shareUrl` still clips to 60 chars (existing clip assertions hold).
- [ ] **Step 2: Run** `cd server && npx vitest run src/line/line-config.spec.ts src/line/line-summary-card.spec.ts` → FAIL.
- [ ] **Step 3: Implement.** `liffId` via the existing `nonEmpty`. `liffShareUrl` uses `encodeURIComponent` on the code. In `summaryCard`, when `input.shareUrl` is set, add the secondary button as a second footer content with `spacing: 'sm'` on the footer; otherwise leave the footer untouched. Document `LINE_LIFF_ID` in `.env.example` and `dockerDeploy.md`.
- [ ] **Step 4: Run** the same command → PASS.
- [ ] **Step 5: Commit** `feat(line): LIFF id config and the host share button on the summary card`.

---

### Task 2: Summary service learns the `host` target

**Files:**
- Modify: `server/src/line/line-summary.service.ts`, `server/src/line/line-client.ts` (rename `push`'s first param `lineGroupId` → `to`; doc "a group id or a user id"; no behavior change)
- Test: `server/src/line/line-summary.spec.ts` (extend; reuse its `setup`, add options `dm?: boolean`)

**Interfaces:**
- Produces: `export type LineSummaryTarget = 'group' | 'host'`; `LineSummaryState` gains `target: LineSummaryTarget | null` and `shareUrl: string | null` (the LIFF URL, set only when `target === 'host'` and `available`). `send()` signature and `LineSummaryOutcome` unchanged.
- Consumes: `liffShareUrl`, `lineConfig().liffId` from Task 1.

- [ ] **Step 1: Write failing tests** (in `line-summary.spec.ts`, fake `LineClient.push` already mocked):
  - target selection: linked group → `state().target === 'group'`; not linked + `lineDmEnabled` + owner `lineUserId` → `'host'` and `shareUrl === 'https://liff.line.me/<id>/<code>'`; linked AND dm-enabled → `'group'` and `shareUrl === null`; neither → `target: null, available: false`.
  - `host` gates each yield `available: false`: `LINE_LIFF_ID` unset, `PUBLIC_APP_URL` unset, `lineDmEnabled` false, owner has no `lineUserId`, owner plan `free`, zero finished games.
  - `send()` for `host`: `push` called once with `to === owner.lineUserId` (not a group id), messages `[card]` where the card has the share button whose uri equals `shareUrl`; returns `'sent'`; `lineSummarySentAt` set; second `send()` returns `'already-sent'` with no second push.
  - `send()` for `group` unchanged: `push` called with `lineGroupId` and a card with exactly one footer button.
  - two concurrent `send()` on a `host` session → exactly one push (`Promise.all`), the other `'busy'` or `'already-sent'`.
  - push returns `'failed'` / `'quota'` → same outcome returned, claim released (`lineSummaryClaimedAt` null, `lineSummarySentAt` null), a later `send()` pushes again.
  - after a `host` send, link the group to a LINE group (`lineGroupId` set) → `send()` returns `'already-sent'`, no push (marker survives a target change).
  - `send()` on an unended session → `'unavailable'`.
- [ ] **Step 2: Run** `npx vitest run src/line/line-summary.spec.ts` → FAIL.
- [ ] **Step 3: Implement** in `line-summary.service.ts`: load the session with `include: { group: { include: { owner: true } } }`; one private `resolve(session, config, now)` returning `{ target, to } | null` applying the table in Global Constraints (group wins); `state()` and `send()` both use it. Build the card with `shareUrl` only for `host`. Keep claim/release/retry-key code as is. Existing `state()` early-returns need `target: null, shareUrl: null`.
- [ ] **Step 4: Run** the spec plus `npx vitest run src/sessions/end-session-line.spec.ts` → PASS (end endpoint unchanged and still green).
- [ ] **Step 5: Commit** `feat(line): summary card can be DMed to the host when no bot is in the group`.

---

### Task 3: Public share-card endpoint

**Files:**
- Create: `server/src/line/line-share.controller.ts`
- Modify: `server/src/line/line-summary.service.ts` (add `shareCard`), `server/src/line/line.module.ts` (register controller)
- Test: `server/src/line/line-share.spec.ts` (service-level, same setup style as `line-summary.spec.ts`; one HTTP-level case for the `@Public` route following how `sessions.controller.spec.ts` drives requests)

**Interfaces:**
- Produces: `LineSummaryService.shareCard(sessionCode: string, now?: Date): Promise<LineShareCard>` where `LineShareCard = { liffId: string; card: SummaryCard; preview: { name: string; date: string; venue: string | null; players: number; games: number } }`; throws `NotFoundException` when unavailable. Route `GET /sessions/:code/line-share-card`, `@Public()`.
- Consumes: Task 2's `state()` (`target === 'host' && available`).

- [ ] **Step 1: Write failing tests**
  - returns 200/payload for an ended `host`-target session with games; `card.contents.footer.contents` has exactly one button (`ดูสรุป`); `liffId` equals env; `preview` values match the totals; `Object.keys(payload)` equals `['liffId','card','preview']` and the JSON contains no `lineUserId`, no email, no owner id.
  - 404 for: unknown code, unended session, zero finished games, group-linked session (target `group`), `lineDmEnabled` false, lapsed plan, `LINE_LIFF_ID` unset.
  - route is reachable with no auth cookie (HTTP-level).
- [ ] **Step 2: Run** `npx vitest run src/line/line-share.spec.ts` → FAIL.
- [ ] **Step 3: Implement** `shareCard` by reusing the card-building code path (extract the totals query + `summaryCard` call from `send` into one private method shared by both, so DM and share cards cannot drift). Controller delegates; `@Public()` from `../auth/public.decorator.js`.
- [ ] **Step 4: Run** `npx vitest run src/line` → PASS. Also `cd server && npm run lint`.
- [ ] **Step 5: Commit** `feat(line): public endpoint serving the share card and LIFF id`.

---

### Task 4: Settings: the default switch works for DM-only groups

**Files:**
- Modify: `server/src/line/line-link.service.ts` (`setSummaryDefault`), `server/src/line/line-host.service.ts` (`LineHostStatus`)
- Test: `server/src/line/line-link.spec.ts`, `server/src/line/line-host.spec.ts`

**Interfaces:**
- Produces: `LineHostStatus` gains `summaryDefault: boolean` and `summaryAvailable: boolean` (`publicAppUrl !== null && liffId !== null`). `setSummaryDefault` accepts a group that is bot-linked **or** (`lineDmEnabled` and owner has `lineUserId`); otherwise 409 `LINE_NOT_LINKED` as today.

- [ ] **Step 1: Write failing tests:** `setSummaryDefault` succeeds for a DM-enabled, account-linked, not bot-linked group and persists `lineSummaryDefault`; still 409 for neither; still 403 on a free plan; `hostStatus` reports `summaryDefault` from the group and `summaryAvailable` false when `LINE_LIFF_ID` is unset, true when both env values set.
- [ ] **Step 2: Run** `npx vitest run src/line/line-link.spec.ts src/line/line-host.spec.ts` → FAIL.
- [ ] **Step 3: Implement** the two changes in the signatures above.
- [ ] **Step 4: Run** the same command → PASS.
- [ ] **Step 5: Commit** `feat(line): summary-card default switch covers DM-linked groups`.

---

### Task 5: Web LIFF share page

**Files:**
- Modify: `web/package.json` (add `@line/liff`, exact current 2.x version), `web/src/app/app.routes.ts`, `web/src/app/core/line.model.ts`, `web/src/app/core/line.service.ts`
- Create: `web/src/app/core/liff-client.ts`, `web/src/app/pages/line-share/line-share.ts`, `.html`, `.css`, `line-share.spec.ts`

**Interfaces:**
- Produces: `LineShareCard` (mirrors Task 3); `LineService.shareCard(sessionCode: string): Observable<LineShareCard>` (GET `/sessions/:code/line-share-card`, URL-encoded); `@Injectable({providedIn:'root'}) LiffClient` with `init(liffId: string): Promise<void>`, `isLoggedIn(): boolean`, `login(redirectUri: string): void`, `canShare(): boolean` (`liff.isApiAvailable('shareTargetPicker')`), `share(messages: unknown[]): Promise<'sent' | 'cancelled'>` (`'sent'` only when the result has `status === 'success'`); loads `@line/liff` with a dynamic `import()` inside `init`. Route `line-share/:sessionCode`, no guard, `loadComponent` of `LineShare`, with a comment like the `s/:sessionCode/summary` one.
- Consumes: Task 3 endpoint.

- [ ] **Step 1: Write failing tests** (`line-share.spec.ts`, stub `LineService` and `LiffClient`):
  - 404 from `shareCard` → shows "ไม่พบสรุปนี้" (`data-share-missing`), never calls `LiffClient`.
  - card loaded, `init` called with the returned `liffId`; not logged in → `login` called once with `location.href`, page shows "กำลังไปหน้าเข้าสู่ระบบ LINE" (`data-share-login`), no share button.
  - logged in → preview shows name, date, venue (omitted when null), `N คน`, `N เกม`; button `data-share-pick` enabled; tap calls `share([card])` with the card from the endpoint; `'sent'` → `data-share-done` "ส่งแล้ว" and a `data-share-again` button that returns to ready.
  - `share` resolves `'cancelled'` → stays ready, no error shown.
  - `canShare()` false → `data-share-unavailable` message telling the host to open it in the LINE app; no pick button.
  - `init` rejects → `data-share-error` message.
- [ ] **Step 2: Run** `cd web && npx ng test --include='src/app/pages/line-share/**/*.spec.ts'` (adjust to this project's `ng test` filter flag) → FAIL.
- [ ] **Step 3: Implement** the files above. Component calls `shareCard`, then `init`, then branches; `share` must run directly from the button's click handler (no `await` before it). Page is Thai primary with `i18n` ids `@@share.line.*`; layout follows existing page conventions (44px tap target, one-handed). Add the strings to both xlf files as commit `a8c80a0` did.
- [ ] **Step 4: Run** the spec → PASS; `npx ng build` succeeds and the `@line/liff` code is in a lazy chunk, not the main bundle (check the build output chunk list).
- [ ] **Step 5: Commit** `feat(web): LIFF page that shares the summary card to a LINE chat`.

---

### Task 6: Web: dialog wording, summary-page link, settings switch

**Files:**
- Modify: `web/src/app/core/line.model.ts` (`LineSummaryState` + `LineHostStatus` mirror Tasks 2 and 4), `web/src/app/pages/session-dashboard/session-dashboard.ts|.html`, `web/src/app/pages/session-summary/session-summary.ts|.html`, `web/src/app/pages/group-settings-detail/line-host-link-panel.ts|.html`, matching `*.spec.ts`, both xlf files.

**Interfaces:**
- Consumes: `LineSummaryState.target: 'group' | 'host' | null`, `LineSummaryState.shareUrl: string | null`; `LineHostStatus.summaryDefault`, `summaryAvailable`; existing `LineService.setSummaryDefault(groupCode, on)`.

- [ ] **Step 1: Write failing tests**
  - dashboard: with `target: 'group'` the checkbox text is unchanged (`ส่งสรุปเข้ากลุ่ม LINE`); with `target: 'host'` it reads `ส่งการ์ดสรุปให้ฉันทาง LINE`; ticked state follows `defaultOn`; ending still passes `sendLineSummary` as today.
  - summary page: for owner + `target: 'host'` + ended session, an `<a data-share-to-group>` "ส่งการ์ดเข้ากลุ่ม LINE" with `href === shareUrl` is shown even when `sent` is true; hidden for `target: 'group'`, for non-owners and while the session is open. Outcome messages for `host` read "ส่งการ์ดให้คุณทาง LINE แล้ว" (sent) and "ส่งการ์ดให้คุณไม่สำเร็จ เพิ่มบอทเป็นเพื่อนอีกครั้งแล้วลองใหม่" (failed); `group` messages unchanged.
  - settings: the `line-host-link-panel` shows the `data-host-summary-default` switch only when `accountLinked && enabled && summaryAvailable`; toggling calls `setSummaryDefault` and reverts the checkbox on error, like the group card's switch.
- [ ] **Step 2: Run** the three specs → FAIL.
- [ ] **Step 3: Implement** with the strings above; en translations in `messages.en.xlf`.
- [ ] **Step 4: Run** `cd web && npm test` → PASS; `npx ng build` OK.
- [ ] **Step 5: Commit** `feat(web): host share card wording, summary-page link and settings switch`.

---

### Task 7: Docs and runbook, full verification

**Files:**
- Modify: `docs/overview.md` (LINE section: the target rule and the reversed "no host push" decision), `CLAUDE.md` only if its LINE description names the summary card rule
- Create: `docs/line-liff-setup.md`

- [ ] **Step 1: Write `docs/line-liff-setup.md`**: create a LINE Login channel in the bot's provider; add a LIFF app (endpoint `https://jubbad.wongnok.dev/line-share`, size Full, scope default, enable Share Target Picker if the console offers it); **publish the Login channel** (a Developing channel only admits its own admins and testers; flag as to be confirmed in the console); copy the LIFF ID into `server/.env` as `LINE_LIFF_ID`; restart; then the real-LINE checklist from the spec's Testing section.
- [ ] **Step 2: Update `docs/overview.md`** LINE summary section for target `host`.
- [ ] **Step 3: Run** `npm test` from the repo root and `cd server && npm run lint` → all green.
- [ ] **Step 4: Commit** `docs: LIFF setup runbook and the host share card rule`.
- [ ] **Step 5:** hand back to the owner for the real-LINE check (phone in-app, iPad external browser, group with another bot, non-admin host). Do not merge or deploy; deployment follows the usual backup-first flow after the owner's check, and the spec/plan are archived after deploy.

---

## Self-Review

- **Spec coverage:** target table and gates (T2), DM card + button (T1, T2), exactly-once and reused marker (T2), public endpoint and no-leak (T3), LIFF page incl. login, cancel, unavailable, again (T5), summary-page link and dialog wording (T6), settings switch (T4, T6), env/LIFF steps and published-channel caveat (T1, T7), no schema change (none planned), overview doc (T7). Setting for `group` targets unchanged.
- **Type consistency:** `LineSummaryTarget`, `shareUrl`, `LineShareCard`, `liffShareUrl`, `LineHostStatus.summaryDefault|summaryAvailable` used identically in producers and consumers.
- **Proportion:** signatures, test names and assertions only; bodies left to the implementer.
