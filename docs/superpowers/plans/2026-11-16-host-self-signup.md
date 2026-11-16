# Host Self Sign-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new host can create their own JubBad account from the website (free plan) or from the LINE bot, and the first LINE link on an account starts a 30-day Host-plan trial.

**Architecture:** A new server `SignupModule` owns five public routes under `/auth/...` (web register, sign-up info, and three LIFF-verified LINE routes). One pure rule plus one service decide when a trial is given, inside the same transaction that attaches the LINE id. The bot gains a per-user guest rich menu whose two buttons are plain LIFF links. The web gains one ordinary page (`/signup`), two LIFF pages under `/line-share/`, and a trial offer on the landing page and upgrade sheet.

**Tech Stack:** NestJS + Prisma + SQLite (server, vitest + supertest), Angular standalone components with signals (web, vitest), LINE Messaging API, LIFF SDK (`@line/liff`, already installed).

**Spec:** `docs/superpowers/specs/2026-11-16-host-self-signup-design.md` — read it first; this plan argues from it.

## Global Constraints

- Work on branch `feat/host-signup`. Never merge, push or deploy; the owner does that.
- `User.plan`'s schema default stays `club`. Every self-sign-up sets its plan explicitly.
- The trial is `plan = 'host'`, 30 days, `planRenewsAt` = `23:59:59.999+07:00` of the Bangkok calendar day 30 days after the link.
- The trial is given only when all three hold: no `TrialRecord` for the LINE id, none for the user, and the user's `effectivePlan` is `free`.
- No push messages. The bot only replies, and only in the one-to-one chat.
- LINE menu calls are best effort: a failure never fails sign-up, linking or a reply. With `LINE_GUEST_RICHMENU_ID` unset, no menu call is made at all.
- A LIFF token LINE refuses is `401`; LINE not answering is `503` (already thrown by `LiffIdentity.verify`) and is never counted as a failed attempt.
- The LIFF access token travels in the `X-Line-Access-Token` header, as on the slip-pay routes. Never log it.
- Password rules are `CreateUserDto`'s: valid email (max 320), password 8–512 characters.
- Bot text is Thai only. Web text is Thai source with an English target: add each new trans-unit **by hand** to both `web/src/locale/messages.xlf` (source only) and `web/src/locale/messages.en.xlf` (source + target), before `</body>`. Never run `ng extract-i18n`.
- Every "แพ็กเกจ" in web copy carries U+2060 between "แพ็ก" and "เกจ".
- Tap targets stay at least 44px.
- Server specs run with `fileParallelism: false`; do not change it.
- After adding the migration, check that its folder timestamp sorts after `20261104062852_line_group_roster_only`.
- Any route added as `@Public()` must be added to `PUBLIC_ROUTES` in `server/src/auth/auth.boundary.spec.ts`, or that spec fails.

## Review Focus

1. **Two sign-ups for the same LINE id at the same moment** (double tap, two tabs): exactly one account is created; the other answers `409 LINE_ALREADY_REGISTERED`, not a 500. Pinned in Task 4.
2. **The same email typed with other casing or spaces** (`  Host@Mail.com `): `409 EMAIL_TAKEN` on both register routes. Pinned in Tasks 3 and 4.
3. **Sign-up just before or after midnight Bangkok time**: the trial ends at the end of the Bangkok day 30 days later, not a UTC day. Pinned in Task 1.
4. **Returning from the LINE Login screen outside the LINE app**: LIFF comes back to `/line-share?liff.state=%2Fsignup` with extra query (`liff.hback`, `code`); the host must land on the form, not on the summary-card page treating `signup` as a session code. Pinned in Task 9.
5. **An account whose paid plan has lapsed** (plan column `host`, `planRenewsAt` in the past, never had a trial) links LINE: it is effectively free, so it gets the trial. **An admin, or a `club` host with no renewal date,** links: nothing about their plan changes. Pinned in Task 2.

---

## File Structure

Server, new:
- `server/prisma/migrations/<timestamp>_host_signup/migration.sql` — `TrialRecord` table, `User.signupSource`.
- `server/src/plans/trial.ts` — pure trial constants and date rule.
- `server/src/plans/trial.service.ts` — gives the trial inside a transaction; answers "is a trial available".
- `server/src/line/liff-identity.ts` — moved from `server/src/sessions/slips/`.
- `server/src/line/liff-identity.module.ts` — provides and exports `LiffIdentity`.
- `server/src/line/signup-links.ts` — the two LIFF URLs.
- `server/src/line/guest-menu.service.ts` — show/hide the guest rich menu per LINE user.
- `server/src/auth/session-cookie.ts` — the cookie options, extracted from `AuthController`.
- `server/src/signup/signup.module.ts`, `signup.controller.ts`, `signup.service.ts`, `dto/register.dto.ts`, `dto/credentials.dto.ts`.
- `server/scripts/create-guest-richmenu.mjs`, `server/assets/line/guest-menu.png`, `server/assets/line/guest-menu.html`.

Server, modified: `prisma/schema.prisma`, `users/users.service.ts`, `auth/auth.controller.ts`, `auth/auth.boundary.spec.ts`, `plans/plans.service.ts`, `plans/plans.module.ts`, `groups/groups.service.ts`, `line/line-config.ts`, `line/line-client.ts`, `line/line-host.service.ts`, `line/line-webhook.service.ts`, `line/line.module.ts`, `sessions/sessions.module.ts`, `sessions/slips/*` (import path only), `admin/admin.service.ts`, `app.module.ts`, `test/slip-http.fixture.ts`, `.env.example`.

Web, new: `core/signup.service.ts`, `pages/signup/`, `pages/line-signup/`, `pages/line-link/`, `shared/trial-offer/`.

Web, modified: `app.routes.ts`, `pages/line-share/line-share.ts`, `pages/login/login.html`, `pages/landing/landing.{ts,html}`, `shared/upgrade-sheet/upgrade-sheet.{ts,html}`, `core/plan.ts`, `core/plan.testing.ts`, `core/admin.service.ts`, `pages/admin/admin.{ts,html}`, both locale files.

---

### Task 1: Schema and the pure trial rule

**Files:**
- Modify: `server/prisma/schema.prisma`
- Create: `server/prisma/migrations/<timestamp>_host_signup/migration.sql` (via `npx prisma migrate dev --name host_signup`, run from `server/`)
- Create: `server/src/plans/trial.ts`
- Test: `server/src/plans/trial.spec.ts`

**Interfaces:**
- Produces:
  - Prisma model `TrialRecord { id String @id @default(cuid()), lineUserId String @unique, userId String? @unique, user User? @relation(fields: [userId], references: [id], onDelete: SetNull), createdAt DateTime @default(now()) }`
  - `User.signupSource String @default("admin")` with a `///` comment: `'admin' | 'web' | 'line'`, feeds the admin list only. `User` gains `trialRecord TrialRecord?`.
  - `export const TRIAL_PLAN = 'host'`, `export const TRIAL_DAYS = 30`
  - `export function trialRenewsAt(now: Date): Date`

- [ ] **Step 1: Write the failing test** in `server/src/plans/trial.spec.ts`

```ts
import { TRIAL_DAYS, TRIAL_PLAN, trialRenewsAt } from './trial.js';

describe('trialRenewsAt', () => {
  it('ends at the last millisecond of the Bangkok day 30 days later', () => {
    // 16 Nov 2026, 10:00 in Bangkok
    expect(trialRenewsAt(new Date('2026-11-16T03:00:00Z')).toISOString()).toBe('2026-12-16T16:59:59.999Z');
  });
  it('counts the Bangkok day, not the UTC day, just after midnight in Bangkok', () => {
    // 17 Nov 2026, 00:30 in Bangkok is still 16 Nov in UTC
    expect(trialRenewsAt(new Date('2026-11-16T17:30:00Z')).toISOString()).toBe('2026-12-17T16:59:59.999Z');
  });
  it('counts the Bangkok day just before midnight in Bangkok', () => {
    // 16 Nov 2026, 23:30 in Bangkok
    expect(trialRenewsAt(new Date('2026-11-16T16:30:00Z')).toISOString()).toBe('2026-12-16T16:59:59.999Z');
  });
  it('is the Host plan for 30 days', () => {
    expect(TRIAL_PLAN).toBe('host');
    expect(TRIAL_DAYS).toBe(30);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run (from `server/`): `npx vitest run src/plans/trial.spec.ts`
Expected: FAIL, cannot resolve `./trial.js`.

- [ ] **Step 3: Implement `server/src/plans/trial.ts`** with the three exports above. Take the Bangkok calendar date of `now` (shift by +7h, read the UTC date), add `TRIAL_DAYS` days, and return that day's `23:59:59.999+07:00`, the same end-of-day form `AdminService.setPlan` builds.

- [ ] **Step 4: Run it and see it pass**

Run: `npx vitest run src/plans/trial.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add the model and the column to `schema.prisma`, then generate the migration**

Run (from `server/`): `npx prisma migrate dev --name host_signup`
Expected: a new folder under `prisma/migrations/` whose name sorts after `20261104062852_line_group_roster_only`. Open `migration.sql` and confirm it only creates `TrialRecord` and adds `signupSource` to `User` (SQLite redefines the `User` table to do it; every existing column must still be listed, and `plan` must still default to `'club'`).

- [ ] **Step 6: Run the server suite**

Run: `npm test`
Expected: PASS, no test changed behaviour.

- [ ] **Step 7: Commit**

```bash
git add server/prisma server/src/plans/trial.ts server/src/plans/trial.spec.ts
git commit -m "feat(signup): trial record table and the 30-day trial date rule"
```

---

### Task 2: TrialService — give the trial when a LINE id is attached

**Files:**
- Create: `server/src/plans/trial.service.ts`
- Modify: `server/src/plans/plans.module.ts` (provide and export `TrialService`)
- Test: `server/src/plans/trial.service.spec.ts`

**Interfaces:**
- Consumes: `TRIAL_PLAN`, `trialRenewsAt` (Task 1); `effectivePlan` from `plans/plan.ts`.
- Produces:
  - `TrialService.applyOnLink(tx: Prisma.TransactionClient, input: { userId: string; lineUserId: string }, now: Date): Promise<Date | null>` — call it inside the transaction that sets `User.lineUserId`. Returns the trial's end, or null when no trial was given. When it gives the trial it sets `plan = TRIAL_PLAN`, `planRenewsAt = trialRenewsAt(now)` and creates the `TrialRecord`.
  - `TrialService.availableForUser(userId: string, now?: Date): Promise<boolean>` — true when the user has no LINE link, no `TrialRecord`, and `effectivePlan` is `free`.
  - `TrialService.availableForLine(lineUserId: string): Promise<boolean>` — true when no `TrialRecord` holds this LINE id.

- [ ] **Step 1: Write the failing tests** in `server/src/plans/trial.service.spec.ts`

Boot a testing module with `PrismaModule` and `PlansModule` (follow the setup in `server/src/plans/plans.service.spec.ts`). Create users with `prisma.user.create` directly, with emails `trial-${randomUUID()}@example.test`, and delete them and their `TrialRecord`s in `afterEach`. A helper `apply(userId, lineUserId, now)` wraps `prisma.$transaction((tx) => trials.applyOnLink(tx, { userId, lineUserId }, now))`. Use `NOW = new Date('2026-11-16T03:00:00Z')`.

Tests, each asserting the returned value and the user row afterwards:

```ts
it('gives a free account the trial', ...)
// returns 2026-12-16T16:59:59.999Z; user.plan === 'host'; planRenewsAt equals it; a TrialRecord exists with both ids
it('gives nothing when this LINE id has had a trial', ...)
// first user gets it with U1; a second free user with the same U1 → null, plan still 'free', planRenewsAt null
it('gives nothing when this account has had a trial', ...)
// user gets it with U1; same user again with U2 → null, planRenewsAt unchanged
it('gives nothing to a club account that never lapses', ...)
// plan 'club', planRenewsAt null → null, row unchanged, no TrialRecord
it('gives nothing to an admin', ...)
// role 'admin', plan 'free' → null, row unchanged
it('gives the trial to an account whose paid plan has lapsed', ...)
// plan 'host', planRenewsAt 2026-10-01 → returns the trial end, planRenewsAt replaced
it('keeps the record when the user is deleted, so the LINE id cannot earn another', ...)
// give, delete the user, availableForLine(U1) === false; the record's userId is null
it('availableForUser is false once linked, once used, or when not on free', ...)
```

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run src/plans/trial.service.spec.ts`
Expected: FAIL, cannot resolve `./trial.service.js`.

- [ ] **Step 3: Implement `TrialService`** (`@Injectable`, takes `PrismaService`). `applyOnLink` reads the user's `role`, `plan`, `planRenewsAt` through `tx`, checks the three conditions in the order listed in Global Constraints, and writes through `tx` only. Add it to `PlansModule`'s `providers` and `exports`.

- [ ] **Step 4: Run and see them pass**

Run: `npx vitest run src/plans/trial.service.spec.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/plans
git commit -m "feat(signup): give the Host trial on an account's first LINE link"
```

---

### Task 3: Website sign-up — `POST /auth/register` and `GET /auth/signup-info`

**Files:**
- Create: `server/src/auth/session-cookie.ts`
- Modify: `server/src/auth/auth.controller.ts` (use the extracted options; behaviour unchanged)
- Modify: `server/src/users/users.service.ts`
- Create: `server/src/line/signup-links.ts`
- Create: `server/src/signup/signup.module.ts`, `signup.controller.ts`, `signup.service.ts`, `dto/register.dto.ts`
- Modify: `server/src/app.module.ts` (import `SignupModule`)
- Modify: `server/src/auth/auth.boundary.spec.ts` (`PUBLIC_ROUTES`)
- Test: `server/src/signup/register.spec.ts`

**Interfaces:**
- Produces:
  - `export function sessionCookieOptions(): CookieOptions` in `auth/session-cookie.ts` — the exact object `AuthController.cookieOptions()` returns today, with its comments.
  - `UsersService.create(email: string, password: string, role?: Role, extra?: { plan?: Plan; signupSource?: 'admin' | 'web' | 'line' }, tx?: Prisma.TransactionClient): Promise<User>` — `extra` and `tx` are new and optional; with neither, behaviour is exactly today's (plan column default `club`, source `admin`).
  - `liffSignupUrl(liffId: string): string` → `https://liff.line.me/${liffId}/signup`; `liffLinkUrl(liffId: string): string` → `https://liff.line.me/${liffId}/link`.
  - `RegisterDto { email: string; password: string; website?: string }` — `website` is the trap: `@IsOptional() @IsString() @MaxLength(200)`.
  - `SignupService.registerWeb(email: string, password: string): Promise<User>` — creates `role 'host'`, `plan 'free'`, `signupSource 'web'`; a duplicate email throws `ConflictException({ code: 'EMAIL_TAKEN' })`.
  - `SignupService.info(): { liffId: string | null; lineSignupUrl: string | null; botAddUrl: string | null }` — `liffId` and `lineSignupUrl` are null unless `lineConfig()` has `liffId` and `loginChannelId`.
  - Routes on `@Controller('auth')` in `SignupController`, both `@Public()`:
    - `POST /auth/register` → `201 { authenticated: true }` and the session cookie (`packSession(user.id, user.tokenVersion)`, `sessionCookieOptions()`).
    - `GET /auth/signup-info` → `SignupService.info()`.
  - `SignupController` holds its own `LoginThrottle` instance (in memory, like the webhook's). Register is limited per IP with key `register:${req.ip ?? 'unknown'}`: `check` first (refused → `429`, message `ลองใหม่อีกครั้งภายหลัง`), and `recordFailure` on **every** attempt that reaches the service, successful or not, so one address can create at most `MAX_ATTEMPTS` accounts per window.

- [ ] **Step 1: Write the failing tests** in `server/src/signup/register.spec.ts`

Boot `PrismaModule`, `AuthModule`, `SignupModule` the way `server/src/auth/auth.controller.spec.ts` does (override `SESSION_SECRET` and `AuthBootstrapService`, `cookieParser`, the global `ValidationPipe`, `server.listen(0)`). Emails are `reg-${randomUUID()}@example.test`; delete created users in `afterEach`.

```ts
it('creates a free host, signs them in, and leaves no LINE link', async () => {
  const res = await request(server).post('/auth/register').send({ email, password: PASSWORD }).expect(201);
  expect(res.body).toEqual({ authenticated: true });
  expect(res.headers['set-cookie']?.[0]).toContain(SESSION_COOKIE);
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  expect(user).toMatchObject({ role: 'host', plan: 'free', planRenewsAt: null, signupSource: 'web', lineUserId: null });
});
it('the cookie it sets signs in', ...)          // GET /auth/me with that cookie → { authenticated: true, role: 'host', email }
it('refuses a taken email, whatever its casing or spacing', ...)
// register email, then `  ${email.toUpperCase()} ` → 409, body.code === 'EMAIL_TAKEN'; still one user row
it('refuses a short password and a malformed email', ...)   // 400 each, no user row
it('a filled trap field looks like success and creates nothing', async () => {
  const res = await request(server).post('/auth/register').send({ email, password: PASSWORD, website: 'http://spam' }).expect(201);
  expect(res.body).toEqual({ authenticated: true });
  expect(res.headers['set-cookie']).toBeUndefined();
  expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
});
it('refuses the address after MAX_ATTEMPTS registrations in the window', ...)   // the next one is 429
it('an admin-created user still gets the club default', ...)
// app.get(UsersService).create(email, PASSWORD) → plan 'club', signupSource 'admin'
it('signup-info reports the LIFF sign-up link when LINE is configured, nulls when not', ...)
// set/unset process.env.LINE_LIFF_ID, LINE_LOGIN_CHANNEL_ID, LINE_BOT_ADD_URL around the calls; restore in afterEach
// configured: { liffId: 'L1', lineSignupUrl: 'https://liff.line.me/L1/signup', botAddUrl: 'https://lin.ee/x' }
```

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run src/signup/register.spec.ts`
Expected: FAIL, cannot resolve `./signup.module.js`.

- [ ] **Step 3: Extract `sessionCookieOptions()`** and make `AuthController` use it.

Run: `npx vitest run src/auth`
Expected: PASS, unchanged.

- [ ] **Step 4: Extend `UsersService.create`, add `signup-links.ts`, and build `SignupModule`** (imports `UsersModule`, `PlansModule`; controller and service as specified). Map Prisma `P2002` on create to `EMAIL_TAKEN`. Register the module in `app.module.ts`.

- [ ] **Step 5: Add both routes to `PUBLIC_ROUTES`** in `auth.boundary.spec.ts`, following the shape of the existing `POST /auth/forgot` entry.

- [ ] **Step 6: Run and see them pass**

Run: `npx vitest run src/signup/register.spec.ts src/auth`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src
git commit -m "feat(signup): public website sign-up on the free plan"
```

---

### Task 4: LINE routes — status, sign up, link

**Files:**
- Move: `server/src/sessions/slips/liff-identity.ts` → `server/src/line/liff-identity.ts` (and its spec); define and export `LiffUser` there, and re-export it from `slip-payments.service.ts` so existing imports keep working.
- Create: `server/src/line/liff-identity.module.ts`
- Modify: `server/src/sessions/sessions.module.ts` (import `LiffIdentityModule`, drop `LiffIdentity` from providers), `server/src/sessions/slips/slip-viewer-gate.ts`, `slip-upload.middleware.ts`, `server/test/slip-http.fixture.ts` (import paths)
- Create: `server/src/signup/dto/credentials.dto.ts`
- Modify: `server/src/signup/signup.module.ts`, `signup.controller.ts`, `signup.service.ts`
- Modify: `server/src/auth/auth.boundary.spec.ts`
- Test: `server/src/signup/line-signup.spec.ts`

**Interfaces:**
- Consumes: `TrialService.applyOnLink`, `availableForLine` (Task 2); `UsersService.create(..., extra, tx)`, `sessionCookieOptions`, the controller's `LoginThrottle` (Task 3); `LineClient.friendStatus(userId): Promise<boolean | null>` (exists); `GuestMenuService.hide(lineUserId): Promise<void>` (Task 6 — until then inject it as `@Optional()` and call `this.guestMenu?.hide(id)`; Task 6 makes it required).
- Produces:
  - `LiffIdentityModule` exporting `LiffIdentity`.
  - `CredentialsDto { email: string; password: string }` (same validators as `RegisterDto`, no trap).
  - `SignupService.lineStatus(line: LiffUser): Promise<{ lineDisplayName: string | null; registered: boolean; trialAvailable: boolean }>`
  - `SignupService.registerLine(line: LiffUser, email: string, password: string, now?: Date): Promise<{ user: User; trialUntil: Date | null; botFriend: boolean | null }>`
  - `SignupService.linkLine(line: LiffUser, email: string, password: string, now?: Date): Promise<{ trialUntil: Date | null } | 'bad-credentials' | 'account-linked' | 'line-taken'>`
  - Routes, all `@Public()`, all reading the header `X-Line-Access-Token`:
    - `POST /auth/line/status` → `200` the `lineStatus` object.
    - `POST /auth/line/signup` (body `CredentialsDto`) → `201 { authenticated: true, trialUntil: string | null, botFriend: boolean | null }` plus the session cookie. `409 { code: 'LINE_ALREADY_REGISTERED' }`, `409 { code: 'EMAIL_TAKEN' }`.
    - `POST /auth/line/link` (body `CredentialsDto`) → `200 { linked: true, trialUntil: string | null }`, no cookie. `401` with message `อีเมลหรือรหัสผ่านไม่ถูกต้อง` for `bad-credentials`; `409 { code: 'ACCOUNT_ALREADY_LINKED' }`; `409 { code: 'LINE_ALREADY_LINKED' }`.
  - Every route: a missing header or a token `LiffIdentity.verify` returns null for → `401`; a `503` from `verify` passes through untouched and records no throttle failure.
  - Throttle (same instance as register): `check` then, on a refused token or `bad-credentials`, `recordFailure` on `line:${req.ip}`; link also uses `email:${normalised email}` exactly as `AuthController.login` does, and `recordSuccess` on both keys when it links.

Rules the service must follow:
- `registerLine`: one `prisma.$transaction`. Refuse `LINE_ALREADY_REGISTERED` if any user holds `line.userId`. Create the user through `UsersService.create(email, password, 'host', { plan: 'free', signupSource: 'line' }, tx)`, set `lineUserId` and `lineLinkedAt = now`, then `trials.applyOnLink(tx, …, now)`. A `P2002` on `lineUserId` → `LINE_ALREADY_REGISTERED`; on `email` → `EMAIL_TAKEN` (read `error.meta.target` to tell them apart). After the transaction: `guestMenu.hide`, then `botFriend = await line.friendStatus(line.userId)`; neither may throw out of the method.
- `linkLine`: `UsersService.verifyCredentials` (null → `bad-credentials`; this also covers a disabled account). In one transaction: `updateMany({ where: { id, lineUserId: null }, data: { lineUserId, lineLinkedAt: now } })`; count 0 → `account-linked`; `P2002` → `line-taken`; then `applyOnLink`. After it: `guestMenu.hide`. (Task 5 adds the roster switch inside this transaction.)

- [ ] **Step 1: Move `LiffIdentity`, add the module, fix imports**

Run: `npx vitest run src/sessions/slips src/line`
Expected: PASS, unchanged (the fixture's `overrideProvider(LiffIdentity)` still applies because the class token is the same).

- [ ] **Step 2: Write the failing tests** in `server/src/signup/line-signup.spec.ts`

Boot the whole `AppModule` as `server/test/slip-http.fixture.ts` does (override `SESSION_SECRET`, `AuthBootstrapService`, and `LiffIdentity` with `{ verify: vi.fn() }`; override `LineClient` with `{ friendStatus: vi.fn().mockResolvedValue(true) }` plus no-op stubs for the methods the app calls at boot, if any). `verify` is driven by a `Map<string, LiffUser>` as in `slip-pay.controller.spec.ts`. Helper `viewer()` returns `[token, user]` with a fresh `U…` id. Clean up created users and `TrialRecord`s in `afterEach`.

```ts
describe('POST /auth/line/status', () => {
  it('a new LINE account: not registered, trial available', ...)          // { lineDisplayName: 'Somchai', registered: false, trialAvailable: true }
  it('a registered LINE account', ...)                                    // registered: true
  it('a LINE account whose trial is used and whose account is gone', ...) // registered: false, trialAvailable: false
  it('401 without a token and with a token LINE refuses', ...)
  it('503 when LINE does not answer, and it is not counted against the caller', ...)
  // verify.mockRejectedValue(new ServiceUnavailableException()); MAX_ATTEMPTS + 1 calls are all 503, then a good token still answers 200
});

describe('POST /auth/line/signup', () => {
  it('creates a linked host on the trial and signs them in', async () => {
    const res = await signup(token, { email, password: PASSWORD }).expect(201);
    expect(res.body).toMatchObject({ authenticated: true, botFriend: true });
    expect(res.body.trialUntil).toEqual(expect.any(String));
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user).toMatchObject({ role: 'host', plan: 'host', signupSource: 'line', lineUserId: line.userId });
    expect(user.planRenewsAt?.toISOString()).toBe(res.body.trialUntil);
    expect(user.lineLinkedAt).not.toBeNull();
  });
  it('a LINE account whose trial is used still gets an account, on free', ...)   // trialUntil null, plan 'free', lineUserId set
  it('refuses a LINE account that already has a JubBad account', ...)            // 409 LINE_ALREADY_REGISTERED, no second user
  it('two sign-ups for one LINE account at once make exactly one account', async () => {
    const [a, b] = await Promise.all([
      signup(token, { email: emailA, password: PASSWORD }),
      signup(token, { email: emailB, password: PASSWORD }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await prisma.user.count({ where: { lineUserId: line.userId } })).toBe(1);
  });
  it('refuses a taken email, whatever its casing', ...)                          // 409 EMAIL_TAKEN, the LINE id stays free to use
  it('still succeeds when the friend check fails', ...)                          // friendStatus rejects → 201, botFriend null
  it('401 without a token', ...)
});

describe('POST /auth/line/link', () => {
  it('links a free website account and starts the trial, without signing in', ...)
  // user made by POST /auth/register; link → 200 { linked: true, trialUntil: <string> }; no set-cookie; row has lineUserId, plan 'host'
  it('links a club account and leaves its plan alone', ...)                      // trialUntil null, plan 'club', planRenewsAt null
  it('a wrong password is 401 and links nothing', ...)
  it('an account that already has a LINE link is refused', ...)                  // 409 ACCOUNT_ALREADY_LINKED
  it('a LINE account already on another account is refused', ...)                // 409 LINE_ALREADY_LINKED
  it('unlink then link again earns no second trial', ...)
  // link (trial), app.get(LineHostService).unlink(userId), link again → 200, trialUntil null, planRenewsAt unchanged
  it('refuses the email after MAX_ATTEMPTS wrong passwords', ...)                // 429
});
```

- [ ] **Step 3: Run and see them fail**

Run: `npx vitest run src/signup/line-signup.spec.ts`
Expected: FAIL, the three routes answer 404.

- [ ] **Step 4: Implement the three routes and the two service methods** as specified. `SignupModule` now also imports `LineModule` and `LiffIdentityModule`.

- [ ] **Step 5: Add the three routes to `PUBLIC_ROUTES`** in `auth.boundary.spec.ts`. They answer an anonymous caller with 401 (no token), like other token-gated public routes; follow how that spec lists the slip-pay routes.

- [ ] **Step 6: Run and see them pass**

Run: `npx vitest run src/signup src/auth src/sessions/slips`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server
git commit -m "feat(signup): sign up and link through LINE, with the trial on first link"
```

---

### Task 5: The group's roster switch follows the link

**Files:**
- Modify: `server/src/groups/groups.service.ts` (`create`)
- Modify: `server/src/signup/signup.service.ts` (`linkLine`)
- Test: `server/src/groups/group-line-default.spec.ts`, and two more cases in `server/src/signup/line-signup.spec.ts`

**Interfaces:**
- Consumes: `PlansService.planForUser(userId, now)`, `planAtLeast(plan, 'host')` (both exist).
- Produces: no new names. Behaviour:
  - `GroupsService.create`: when the upsert **creates** the group, `lineDmEnabled` is `true` if the caller has a `lineUserId` and `planAtLeast(effective plan, 'host')`; otherwise `false`. An existing group met by a retry is never changed (`update: {}` stays).
  - `SignupService.linkLine`: inside its transaction, after `applyOnLink`, if the user's effective plan is now Host or above, `tx.group.updateMany({ where: { ownerId: user.id }, data: { lineDmEnabled: true } })`.

- [ ] **Step 1: Write the failing tests**

`group-line-default.spec.ts` (boot as `server/src/plans/plan-gates.groups.spec.ts` does, signing in to call `POST /groups`):

```ts
it('a linked host on the Host plan gets a new group with the roster switch on', ...)
it('a linked host on free gets it off', ...)
it('an unlinked host on club gets it off', ...)
it('retrying the create of an existing group does not flip the switch', ...)
// create (on), switch it off through LineHostService.setEnabled(code, false), POST /groups again with the same code → still off
```

Added to `line-signup.spec.ts`:

```ts
it('linking switches the roster switch on for every group the account owns, when the trial starts', ...)
// free website account with one group (off) → link → that group's lineDmEnabled is true
it('linking a LINE account whose trial is used leaves a free account’s groups off', ...)
```

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run src/groups/group-line-default.spec.ts src/signup/line-signup.spec.ts`
Expected: FAIL on the new cases only.

- [ ] **Step 3: Implement both changes.**

- [ ] **Step 4: Run and see them pass, then the whole server suite**

Run: `npm test`
Expected: PASS. If an existing spec asserted a new group's `lineDmEnabled` is false for a linked Host-plan owner, that spec now describes the old behaviour: update its expectation and say so in the commit body.

- [ ] **Step 5: Commit**

```bash
git add server/src
git commit -m "feat(line): a linked host's groups take rosters by DM without a settings visit"
```

---

### Task 6: Guest rich menu and the bot's guest replies

**Files:**
- Modify: `server/src/line/line-config.ts`, `server/src/line/line-client.ts`, `server/.env.example`
- Create: `server/src/line/guest-menu.service.ts`
- Modify: `server/src/line/line-webhook.service.ts`, `server/src/line/line-host.service.ts`, `server/src/line/line.module.ts`, `server/src/signup/signup.service.ts` (make `GuestMenuService` a required dependency)
- Test: `server/src/line/guest-menu.spec.ts`; new cases in `server/src/line/line-webhook.spec.ts`, `line-client.spec.ts`, `line-config.spec.ts`, `line-host.spec.ts`

**Interfaces:**
- Consumes: `liffSignupUrl` (Task 3).
- Produces:
  - `LineConfig.guestRichMenuId: string | null` from `LINE_GUEST_RICHMENU_ID`.
  - `LineClient.linkRichMenu(userId: string, richMenuId: string): Promise<boolean>` → `POST /user/{userId}/richmenu/{richMenuId}`; `LineClient.unlinkRichMenu(userId: string): Promise<boolean>` → `DELETE /user/{userId}/richmenu`. Both return whether LINE answered 2xx and never throw. `send`/`call` gain `'DELETE'` in their method union.
  - `GuestMenuService` (exported from `LineModule`):
    - `show(lineUserId: string): Promise<void>` — links the guest menu unless this process already did for this id (an in-memory `Set`); a failed call is not remembered, so it is tried again next time.
    - `hide(lineUserId: string): Promise<void>` — unlinks and forgets the id.
    - `forget(lineUserId: string): void` — only drops the id from the set, so the next DM shows the menu again.
    - All three do nothing, and call LINE zero times, when `guestRichMenuId` is null.
  - `LineHostService.isLinked(lineUserId: string): Promise<boolean>` — whether a `User` holds this LINE id.

Bot behaviour in `dispatchDirect` (one-to-one chat), checked in this order:

| Event | Guest (`isLinked` false) | Linked |
|---|---|---|
| `follow` | reply `GUEST_FOLLOW_MESSAGES`; `guestMenu.show` | reply `FOLLOW_TEXT` (unchanged) |
| text matching `SIGNUP_COMMAND = /^\/?(signup\|สมัคร)$/i` | reply `GUEST_FOLLOW_MESSAGES`; `guestMenu.show` | reply `ALREADY_REGISTERED_TEXT` |
| `/link <code>` redeemed | `guestMenu.hide(lineUserId)` after the existing reply | — |
| any other text | existing behaviour, then `guestMenu.show` | existing behaviour |

`LineHostService.unlink(userId)`: read the user's `lineUserId` before the transaction and call `guestMenu.forget(it)` after, so the menu returns on their next DM.

Copy (Thai only, exact):
- `GUEST_FOLLOW_MESSAGES`: one buttons-template message when `liffId` and `loginChannelId` are configured, else today's `FOLLOW_TEXT`. Alt text and body: `สำหรับหัวก๊วน: สมัครใช้ JubBad ผ่าน LINE รับทดลองใช้ครบทุกฟีเจอร์ฟรี 30 วัน`; one URI button labelled `สมัครเลย` to `liffSignupUrl(liffId)`.
- `ALREADY_REGISTERED_TEXT`: `บัญชี LINE นี้มีบัญชี JubBad แล้ว เข้าสู่ระบบได้ที่ ${publicAppUrl}/login` (drop the URL sentence when `publicAppUrl` is null).

Before writing `linkRichMenu`/`unlinkRichMenu`, open LINE's current Messaging API reference for "Link rich menu to user" and "Unlink rich menu from user" and confirm the two paths and methods above; if they differ, follow the reference and note it in the commit.

- [ ] **Step 1: Write the failing tests**

`guest-menu.spec.ts` (unit, a stub `LineClient` of `vi.fn()`s, env set per test):

```ts
it('links the menu once per LINE user per process', ...)        // show twice → linkRichMenu called once with (U1, 'RM1')
it('tries again after a failed link', ...)                      // linkRichMenu resolves false, show again → called twice
it('hide unlinks and lets a later show link again', ...)
it('forget lets a later show link again without calling LINE', ...)
it('does nothing at all when LINE_GUEST_RICHMENU_ID is unset', ...)   // show, hide, forget → zero client calls
```

`line-client.spec.ts`: each new method hits the right method and URL, returns false on a 400 and on a network error, and returns false without a fetch when the token is unset.

`line-config.spec.ts`: `guestRichMenuId` is null when unset or blank, trimmed when set.

`line-webhook.spec.ts` (follow the file's existing event helpers):

```ts
it('a guest who follows gets the sign-up button and the guest menu', ...)
it('a linked host who follows gets the old text and no menu', ...)
it('"สมัคร" and "/signup" from a guest reply with the sign-up button', ...)
it('"สมัคร" from a linked host says they already have an account', ...)
it('a redeemed /link hides the guest menu; a failed one does not', ...)
it('any other DM from a guest keeps its old reply and shows the menu', ...)
it('a guest who follows with LIFF unconfigured gets the old follow text', ...)
it('a group chat event never touches the guest menu', ...)
```

`line-host.spec.ts`: `unlink` forgets the LINE id (assert on a spied `GuestMenuService.forget`).

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run src/line`
Expected: FAIL on the new cases only.

- [ ] **Step 3: Implement** config, client methods, `GuestMenuService`, `isLinked`, the webhook routing and the `unlink` hook; provide and export `GuestMenuService` in `LineModule`; make it a required constructor parameter of `SignupService`. Add `LINE_GUEST_RICHMENU_ID=` to `.env.example` with a one-line comment naming the script from Task 7.

- [ ] **Step 4: Run and see them pass**

Run: `npx vitest run src/line src/signup`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server
git commit -m "feat(line): guest rich menu and sign-up replies in the bot's one-to-one chat"
```

---

### Task 7: The rich menu image and its one-time script

**Files:**
- Create: `server/assets/line/guest-menu.html` (the design source), `server/assets/line/guest-menu.png` (the upload)
- Create: `server/scripts/create-guest-richmenu.mjs`
- Test: `server/scripts/create-guest-richmenu.spec.ts`
- Modify: `server/package.json` (script `line:guest-menu`)

**Interfaces:**
- Consumes: `liffSignupUrl`, `liffLinkUrl` (same URL shapes; the script builds them itself from `LINE_LIFF_ID`, since it is plain `.mjs`).
- Produces:
  - `export function guestMenuDefinition(liffId)` — the rich menu object: `size { width: 2500, height: 843 }`, `selected: true`, `name: 'jubbad-guest'`, `chatBarText: 'เมนู'`, two areas each 1250 wide and 843 tall, left `{ type: 'uri', uri: 'https://liff.line.me/<liffId>/signup' }`, right `{ … '/link' }`.
  - Running the script: creates the menu, uploads `guest-menu.png`, prints `LINE_GUEST_RICHMENU_ID=<id>`. It reads `LINE_CHANNEL_ACCESS_TOKEN` and `LINE_LIFF_ID`, exits non-zero with a plain message if either is missing or a call fails, and never sets a default rich menu.

Before writing the script, open LINE's current Messaging API reference for "Create rich menu" and "Upload rich menu image" and confirm the image limits (size, format, max bytes), the two endpoints and their hosts. Follow the reference where it differs from the numbers above.

- [ ] **Step 1: Build the image.** Write `guest-menu.html` as a 2500×843 page with two equal halves. Left: `สมัครใช้ฟรี 30 วัน` with a smaller line `สำหรับหัวก๊วน`. Right: `มีบัญชีแล้ว` with a smaller line `ผูก LINE`. Use the app's own colours and Thai-capable font from `web/src/styles` (read the tokens; do not invent a palette). Render it to `guest-menu.png` at exactly 2500×843 with a headless browser screenshot, and confirm the file is within LINE's size limit.

- [ ] **Step 2: Show the owner the PNG and stop for approval.** The look is theirs to decide (spec, "Guest rich menu"). Do not continue this task until they approve or give changes; other tasks can proceed meanwhile.

- [ ] **Step 3: Write the failing test** in `create-guest-richmenu.spec.ts` (follow `server/scripts/backfill-venues.spec.ts` for importing an `.mjs` script):

```ts
it('describes two side-by-side link areas that cover the whole image', () => {
  const menu = guestMenuDefinition('L1');
  expect(menu.size).toEqual({ width: 2500, height: 843 });
  expect(menu.areas.map((a) => a.bounds)).toEqual([
    { x: 0, y: 0, width: 1250, height: 843 },
    { x: 1250, y: 0, width: 1250, height: 843 },
  ]);
  expect(menu.areas.map((a) => a.action)).toEqual([
    { type: 'uri', uri: 'https://liff.line.me/L1/signup' },
    { type: 'uri', uri: 'https://liff.line.me/L1/link' },
  ]);
});
```

- [ ] **Step 4: Run and see it fail, implement the script, run and see it pass**

Run: `npx vitest run scripts/create-guest-richmenu.spec.ts`
Expected: FAIL first (cannot resolve), PASS after. The script must not call LINE on import; only when run directly.

- [ ] **Step 5: Lint and commit**

Run: `npm run lint`
Expected: no errors.

```bash
git add server/assets server/scripts server/package.json
git commit -m "feat(line): guest rich menu image and the script that uploads it"
```

---

### Task 8: `/plans/me` reports the trial offer; admin list shows the source

**Files:**
- Modify: `server/src/plans/plans.service.ts` (`describeCaller`), `server/src/admin/admin.service.ts` (`listUsers`)
- Test: `server/src/plans/plans.service.spec.ts`, `server/src/admin/admin.spec.ts` (new cases)

**Interfaces:**
- Consumes: `TrialService.availableForUser` (Task 2), `liffLinkUrl` (Task 3).
- Produces:
  - `GET /plans/me` gains `trialAvailable: boolean` and `linkUrl: string | null` (`liffLinkUrl(liffId)` when `liffId` and `loginChannelId` are configured, else null). `trialAvailable` is forced false when `linkUrl` is null, so the web never offers something it cannot open.
  - Each `GET /admin/users` row gains `signupSource: 'admin' | 'web' | 'line'` and `trialUsed: boolean` (the user has a `TrialRecord`).

- [ ] **Step 1: Write the failing tests**

```ts
// plans.service.spec.ts
it('offers the trial to a free, unlinked host who never had one', ...)   // trialAvailable true, linkUrl 'https://liff.line.me/L1/link'
it('does not offer it once linked, once used, or on a paid plan', ...)
it('does not offer it when LIFF is not configured', ...)                 // trialAvailable false, linkUrl null
// admin.spec.ts
it('lists where each user came from and whether their trial is used', ...)
```

- [ ] **Step 2: Run and see them fail; implement; run and see them pass**

Run: `npx vitest run src/plans/plans.service.spec.ts src/admin`
Expected: FAIL on the new cases, then PASS.

- [ ] **Step 3: Run the whole server suite and lint**

Run: `npm test && npm run lint`
Expected: PASS, no lint errors.

- [ ] **Step 4: Commit**

```bash
git add server/src
git commit -m "feat(signup): plan read reports the trial offer; admin list shows sign-up source"
```

---

### Task 9: Web — sign-up service, `/signup`, and the two LIFF pages

**Files:**
- Create: `web/src/app/core/signup.service.ts`, `signup.service.spec.ts`
- Create: `web/src/app/pages/signup/signup.{ts,html,css,spec.ts}`
- Create: `web/src/app/pages/line-signup/line-signup.{ts,html,css,spec.ts}`
- Create: `web/src/app/pages/line-link/line-link.{ts,html,css,spec.ts}`
- Modify: `web/src/app/app.routes.ts`, `web/src/app/pages/line-share/line-share.ts` (+ its spec), `web/src/app/pages/login/login.html`
- Modify: `web/src/locale/messages.xlf`, `web/src/locale/messages.en.xlf`

**Interfaces:**
- Consumes: the five server routes (Tasks 3–4); `LiffClient` (`init`, `isLoggedIn`, `login`, `getAccessToken`); `AuthService.check()` to refresh the signed-in state after a sign-up.
- Produces `SignupService` (`providedIn: 'root'`):
  - `info(): Promise<{ liffId: string | null; lineSignupUrl: string | null; botAddUrl: string | null }>`
  - `register(email: string, password: string, website: string): Promise<'ok' | 'email-taken' | 'rate' | 'invalid' | 'error'>`
  - `lineStatus(accessToken: string): Promise<{ lineDisplayName: string | null; registered: boolean; trialAvailable: boolean } | 'unauthorized' | 'unavailable' | 'error'>` (`unavailable` is a 503)
  - `lineSignup(accessToken: string, email: string, password: string): Promise<{ trialUntil: string | null; botFriend: boolean | null } | 'line-registered' | 'email-taken' | 'rate' | 'unauthorized' | 'unavailable' | 'invalid' | 'error'>`
  - `lineLink(accessToken: string, email: string, password: string): Promise<{ trialUntil: string | null } | 'bad-credentials' | 'account-linked' | 'line-linked' | 'rate' | 'unauthorized' | 'unavailable' | 'error'>`
- Routes (all unguarded), with a comment on each in the style of the neighbouring ones:
  - `signup` → `Signup`
  - `line-share/signup` → `LineSignup` and `line-share/link` → `LineLink`, placed **before** `line-share/:sessionCode` so the literal segment wins.
- `routeTargetFrom` in `line-share.ts` gains two kinds, `'signup'` and `'link'`, recognised when the `liff.state` path is exactly `signup` or `link` (after the existing `split(/[?#]/)[0]` and leading-slash strip). The constructor hands those over with `router.navigate(['/line-share', kind], { replaceUrl: true, queryParams })`, keeping every query parameter except `liff.state`, exactly as it already does for `slip`.

Page behaviour:

- **`Signup` (`/signup`)**: phases `form` | `sending`. Fields: email, password, and the trap — an input named `website` that is visually hidden, `tabindex="-1"`, `autocomplete="off"`, `aria-hidden="true"`. On `ok`: `await auth.check()`, then `router.navigate(['/groups/new'])`. `email-taken` shows the line with a link to `/login`. Below the form, when `info().lineSignupUrl` is not null: a link to it. A link to `/login`. Model the form, error lines and layout on `pages/login/login`.
- **`LineSignup` (`/line-share/signup`)**: phases `loading` | `login` | `form` | `registered` | `done` | `unavailable` | `error`. Start: `info()`; a null `liffId` → `unavailable`. `liff.init(liffId)`; if not logged in → phase `login` with one button calling `liff.login(location.href)` (as `slip-pay.ts` does). Then `lineStatus(token)`: `registered` → phase `registered` (a line and a `/login` button); otherwise `form`, showing the LINE name and, when `trialAvailable` is false, the line that this LINE account has had its trial and the account will be on the free plan. Submit → `lineSignup`. On success → phase `done`: the trial end date when `trialUntil` is set (format it as the plan notices do, see `shared/plan-notice`); when `botFriend === false` and `botAddUrl` is not null, an `เพิ่มบอทเป็นเพื่อน` link (new tab) beside the continue button; the continue button runs `auth.check()` then navigates to `/groups/new`. `unavailable` (503) offers a retry that re-runs the load without re-running `liff.init`.
- **`LineLink` (`/line-share/link`)**: same start. A `registered` status → a line saying this LINE account is already linked, with a `/login` button. Otherwise the form (LINE name, email, password). Submit → `lineLink`. Success → phase `done`: `ผูกแล้ว`, the trial end date when one started, and one line on sending a roster to the bot. It does not navigate anywhere and does not call `auth.check()`: the page did not sign the browser in.
- **Login page**: one line under the form, a link to `/signup`.

Copy (Thai source; give each an English target in `messages.en.xlf`):

| id | Thai |
|---|---|
| `signup.title` | สมัครใช้ JubBad |
| `signup.lede` | สมัครฟรี สร้างก๊วนแรกได้ทันที |
| `signup.submit` | สร้างบัญชี |
| `signup.emailTaken` | อีเมลนี้มีบัญชีแล้ว |
| `signup.viaLine` | หรือสมัครผ่าน LINE รับทดลองใช้ครบทุกฟีเจอร์ฟรี 30 วันทันที |
| `signup.haveAccount` | มีบัญชีแล้ว? เข้าสู่ระบบ |
| `login.signupLink` | ยังไม่มีบัญชี? สมัครใช้ฟรี |
| `lineSignup.lineName` | บัญชี LINE: {{name}} |
| `lineSignup.trialUsed` | บัญชี LINE นี้เคยทดลองใช้แล้ว บัญชีใหม่จะเริ่มที่แพ็ก⁠เกจฟรี |
| `lineSignup.registered` | บัญชี LINE นี้มีบัญชี JubBad แล้ว |
| `lineSignup.doneTrial` | สมัครแล้ว ทดลองใช้ครบทุกฟีเจอร์ได้ถึง {{date}} |
| `lineSignup.doneFree` | สมัครแล้ว เริ่มใช้แพ็ก⁠เกจฟรีได้เลย |
| `lineSignup.addBot` | เพิ่มบอทเป็นเพื่อน |
| `lineSignup.continue` | สร้างก๊วนแรก |
| `lineLink.title` | ผูก LINE กับบัญชี JubBad |
| `lineLink.submit` | ผูกบัญชี |
| `lineLink.badCredentials` | อีเมลหรือรหัสผ่านไม่ถูกต้อง |
| `lineLink.accountLinked` | บัญชี JubBad นี้ผูกกับ LINE อื่นอยู่แล้ว |
| `lineLink.done` | ผูกแล้ว |
| `lineLink.doneTrial` | ทดลองใช้ครบทุกฟีเจอร์ได้ถึง {{date}} |
| `lineLink.howTo` | ส่งรายชื่อก๊วนมาที่แชตบอทได้เลย |
| `line.needLogin` | เข้าสู่ระบบ LINE เพื่อไปต่อ |
| `line.unavailable` | ยังใช้งานผ่าน LINE ไม่ได้ในตอนนี้ |
| `line.tryAgain` | LINE ไม่ตอบ ลองใหม่อีกครั้ง |

Reuse existing trans-units for the email label, password label, rate-limit and generic error lines where the login page already has them (read `login.html` for their ids).

- [ ] **Step 1: Write the failing tests**

`signup.service.spec.ts` (with `HttpTestingController`, as `core/auth.service.spec.ts`): each method maps its statuses to the union above — `201/200` → value, `409` by `error.code`, `401`, `429`, `503`, `400`, anything else `error`; `lineStatus`/`lineSignup`/`lineLink` send the token in `X-Line-Access-Token` and never in the body or URL.

`signup.spec.ts`:
```ts
it('registers and goes to group creation', ...)            // service.register called with (email, password, ''); navigates ['/groups/new']
it('sends whatever is in the trap field', ...)             // set the hidden input, expect register's third argument
it('says the email is taken and offers login', ...)
it('shows the LINE option only when the server offers a link', ...)
it('disables the button while sending', ...)
```

`line-signup.spec.ts` (stub `LiffClient` and `SignupService`, as `pages/slip-pay/slip-pay.spec.ts` stubs LIFF):
```ts
it('asks for LINE login when LIFF is not logged in', ...)
it('shows the form with the LINE name for a new LINE account', ...)
it('warns that the trial is used', ...)
it('sends a registered LINE account to login instead of the form', ...)
it('on success shows the trial end and offers to add the bot when not a friend', ...)
it('does not offer to add the bot when already a friend or unknown', ...)
it('continue re-checks the session and goes to group creation', ...)
it('offers a retry when LINE does not answer, without running init twice', ...)
it('says LINE sign-up is unavailable when no LIFF id is configured', ...)
```

`line-link.spec.ts`:
```ts
it('links and shows the trial end', ...)
it('links and shows no trial line when none started', ...)
it('shows the wrong-password line and keeps the form', ...)
it('says the account is already linked', ...)
it('never navigates and never calls auth.check', ...)
```

`line-share.spec.ts` (new cases beside the existing `liff.state` ones):
```ts
it('hands /line-share?liff.state=%2Fsignup over to the sign-up page', ...)
it('hands over with LIFF’s return query intact: liff.state=%2Fsignup%3Fliff.hback%3D2&code=abc', ...)
// navigates ['/line-share','signup'] with queryParams { code: 'abc' }; does not load a summary card for a session called "signup"
it('hands /line-share?liff.state=%2Flink over to the link page', ...)
```

- [ ] **Step 2: Run and see them fail**

Run (from `web/`): `npm test`
Expected: FAIL on the new specs (missing modules).

- [ ] **Step 3: Implement** the service, the three pages, the routes, the hand-over, the login link, and the trans-units in both locale files.

- [ ] **Step 4: Run and see them pass, then build**

Run: `npm test && npm run build`
Expected: PASS; the build reports no missing translations for the `en` locale.

- [ ] **Step 5: Commit**

```bash
git add web
git commit -m "feat(signup): website sign-up page and the LINE sign-up and link pages"
```

---

### Task 10: Web — the trial offer, and the admin list

**Files:**
- Modify: `web/src/app/core/plan.ts` (`MyPlan`), `web/src/app/core/plan.testing.ts` (defaults)
- Create: `web/src/app/shared/trial-offer/trial-offer.{ts,html,css,spec.ts}`
- Modify: `web/src/app/pages/landing/landing.{ts,html}` (+ spec), `web/src/app/shared/upgrade-sheet/upgrade-sheet.{ts,html}` (+ spec)
- Modify: `web/src/app/core/admin.service.ts` (`AdminUser`), `web/src/app/pages/admin/admin.{ts,html}` (+ spec)
- Modify: both locale files

**Interfaces:**
- Consumes: `GET /plans/me`'s `trialAvailable`, `linkUrl`; `GET /admin/users`'s `signupSource`, `trialUsed` (Task 8).
- Produces:
  - `MyPlan` gains `trialAvailable: boolean` and `linkUrl: string | null`; `plan.testing.ts`'s `answerMine` defaults them to `false` and `null`.
  - `TrialOffer` component, selector `app-trial-offer`, input `linkUrl: string` (required). Renders one line and one link-button (min-height 44px) that opens `linkUrl`.
  - `AdminUser` gains `signupSource: 'admin' | 'web' | 'line'` and `trialUsed: boolean`.

Behaviour:
- **Landing**: when `mine.trialAvailable && mine.linkUrl`, show `<app-trial-offer>` above the group list, below any plan notice. Never on the live session dashboard.
- **Upgrade sheet**: the same condition puts `<app-trial-offer>` first, above the existing "what Host adds" content and the contact.
- **Admin list**: each user row shows the source as a small label, and `ทดลองใช้แล้ว` when `trialUsed`.

Copy:

| id | Thai |
|---|---|
| `trialOffer.line` | ผูก LINE รับทดลองใช้ครบทุกฟีเจอร์ฟรี 30 วัน |
| `trialOffer.button` | ผูก LINE |
| `admin.sourceAdmin` | ผู้ดูแลสร้าง |
| `admin.sourceWeb` | สมัครทางเว็บ |
| `admin.sourceLine` | สมัครทาง LINE |
| `admin.trialUsed` | ทดลองใช้แล้ว |

- [ ] **Step 1: Write the failing tests**

```ts
// trial-offer.spec.ts
it('links to the given URL', ...)
// landing.spec.ts
it('shows the trial offer to a free host who can still earn it', ...)   // answerMine({ trialAvailable: true, linkUrl: 'https://liff.line.me/L1/link' })
it('hides it when the trial is not available or there is no link', ...)
it('hides it when the plan read fails', ...)                            // failMine()
// upgrade-sheet.spec.ts
it('leads with the trial offer when it is available', ...)
it('shows only the contact when it is not', ...)
// admin.spec.ts
it('labels each user with where they came from and a used trial', ...)
```

- [ ] **Step 2: Run and see them fail; implement; run and see them pass**

Run (from `web/`): `npm test`
Expected: FAIL on the new cases, then PASS.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: no missing translations.

- [ ] **Step 4: Commit**

```bash
git add web
git commit -m "feat(signup): offer the LINE trial to free hosts; admin list shows sign-up source"
```

---

### Task 11: Documentation and the full run

**Files:**
- Modify: `docs/overview.md`, `docs/2026-10-06-pricing-tiers.md`, `docs/line-liff-setup.md`, `CLAUDE.md`

No test cycle of its own; it rides with the full-suite run that closes the branch.

- [ ] **Step 1: Update `docs/overview.md`**
  - Decision table, "No LIFF / LINE Login" row: add a dated note (2026-11-16) that a verified LINE identity can now be recorded on a host account at sign-up or from the link page, and still never signs anyone in.
  - Decision table, "Per-user accounts for hosts" row: hosts can now create their own account; the admin can still create one.
  - "Explicitly out of scope": adjust the LIFF line to match.
  - "Plans": a short "Trial" part — the one rule, the three conditions, `TrialRecord`, `signupSource`, `trialAvailable`/`linkUrl` on `/plans/me`, and that `User.plan` still defaults to `club`.
  - "LINE bot": the guest rich menu (per user, never a default, `LINE_GUEST_RICHMENU_ID`), the guest replies, the two LIFF pages, link by password, and the roster switch defaults from the spec's "What gets linked" section.
  - The forgot-password comment's premise ("not a public signup surface") no longer holds; say so where the docs describe it, and update the comment on `AuthController.forgot` to match (behaviour unchanged).
- [ ] **Step 2: Update `docs/2026-10-06-pricing-tiers.md`** with the trial (Host plan, 30 days, earned by the first LINE link, once per LINE account and per JubBad account).
- [ ] **Step 3: Update `docs/line-liff-setup.md`**: the two new LIFF pages (no console change: same endpoint, same `profile` scope), the rich menu script (`npm run line:guest-menu`), the new env var, and a "Sign-up checks" list copied from the spec's deploy step 4.
- [ ] **Step 4: Update `CLAUDE.md`**'s route list with `/signup`, `/line-share/signup`, `/line-share/link`, and add `TrialRecord` to the data-model line.
- [ ] **Step 5: Run everything**

Run (repo root): `npm test`
Expected: engines, server and web all PASS.

Run (from `server/`): `npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add docs CLAUDE.md server/src/auth/auth.controller.ts
git commit -m "docs: host self sign-up, the LINE trial and the guest menu"
```

- [ ] **Step 7: Stop.** Report what was built and the deploy steps from the spec. Do not merge, push, deploy, or run the rich menu script against the real LINE channel; those are the owner's.
