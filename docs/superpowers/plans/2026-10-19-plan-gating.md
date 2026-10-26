# Plan Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate paid features by the group owner's plan (free / host / club), with the plan set by an admin only. There is no billing integration, so payment stays manual PromptPay.

**Architecture:** `User` gains `plan` and `planRenewsAt`. A pure `effectivePlan()` derives the live plan at read time, and a lapse is never stored. A `PlansService` resolves the plan of a group's *owner* and refuses with 403 `PLAN_REQUIRED`. Route gates sit in controllers, one line each, so the paid surface can be audited in two files. Body-dependent gates (bill fields, session-creation snapshots) sit in services. The work ships in three phases, and each phase can be deployed on its own. Phase 1 is dormant by construction: the DB default is `club` with no renewal date, so nobody changes tier until an admin changes them. (`club` rather than `host`, because `host` carries a 3-group cap that would refuse new groups for an existing host who already runs more.)

**Tech Stack:** NestJS + Prisma + SQLite (server, vitest), Angular standalone + signals (web, `ng test`), `@angular/localize` (Thai source, English target).

**Spec:** `docs/2026-10-06-pricing-tiers.md` (revised 2026-10-19).

## Global Constraints

- Work on branch `feat/plan-gating`. `main` runs real weekly nights and must stay deployable.
- Read `docs/overview.md` before touching anything in `server/src/sessions/` (CLAUDE.md rule).
- Plans: `'free' | 'host' | 'club'`. Thai labels are ฟรี / โฮสต์ / ก๊วนใหญ่ and English labels are Free / Host / Club. No prices appear in the app.
- Group limits: free **1**, host **3**, club **10**. A caller with role `admin` has no limit.
- Free archive window: the last **30** days (`FREE_ARCHIVE_DAYS = 30`).
- Gating is derived at read time from the owner's `{ role, plan, planRenewsAt }`. It is never stored per feature, and `User.disabled` is never touched by plan code.
- A plan lapses when `now > planRenewsAt`. `planRenewsAt === null` never lapses.
- An admin sets a renewal date as `YYYY-MM-DD`, which is stored as the end of that day in Bangkok: `new Date(`${d}T23:59:59.999+07:00`)`.
- Ownerless group → `club`. Production never has one (AuthBootstrapService fills `ownerId`), and existing specs rely on ownerless fixtures.
- Owner with role `admin` → `club`.
- Refusals:
  - 403 `{ code: 'PLAN_REQUIRED', requiredPlan: 'host' }`
  - 403 `{ code: 'GROUP_LIMIT', limit: <number> }`
- **Gate turning a paid thing on, never turning it off, and never a running session's state.** Free can always:
  - switch to `variety` or `custom`, or set a court to `custom` or target `auto`
  - disable shuttle tools or cross-session history
  - delete a rule, stop sharing, clear or delete lineups
- **Public routes are never gated:**
  - `GET /sessions/:code`, display, summary
  - `/d/:token` for an already-issued token
- **Elo always replays full history.** The 30-day filter applies only to the `listSessions` query. It never applies to `finishedMatches()` or to any `computeRatingTracks` input.
- **Level tags (C1) stay free.** Only paid modes read them. Roster-entry level chips and the player-level edit are not gated.
- **"Host roster page" is interpreted as its ratings, not the page itself.** Rename, aliases, level and contact edits stay free, and only rating, singles rating, win rate and rules are paid.
- Every new UI string is i18n'd: Thai `i18n="@@id"` / `$localize`. Run `npx ng extract-i18n --output-path src/locale` from `web/`, then add the English `<target>` by hand in `messages.en.xlf`.
- Tap targets stay at least 44px.
- Server tests keep `fileParallelism: false`.
- Out of scope:
  - The ก๊วนใหญ่ "5 managers" feature (the app has single-owner groups).
  - Any payment provider.
  - Hiding a lapsed group's existing `/d/:token`.

## Review Focus

1. **Host lapses mid-session.** A session already in สูสี, with shuttle tools on or with a per-court ระดับ, keeps proposing and confirming. Only new switches are refused. Test in Task 8.
2. **Turning paid things off on free must succeed.** If it didn't, a lapsed host could get stuck with a switch on that they can no longer change. Tests in Tasks 5 and 8.
3. **An admin opening a free host's group sees and is gated by the owner's plan,** not the admin's own `club`. Test in Task 2 (plan endpoint returns the owner's plan when the caller is an admin).
4. **Bill prefill from an earlier paid session must not carry the host fee or walk-in fee into a free session.** Test in Task 9.
5. **A session older than 30 days on free disappears from the archive list,** but its public summary still returns 200 and ratings on upgrade still include it. Test in Task 6.

---

## Phase 1: dormant plumbing (deployable, changes nothing for anyone)

### Task 1: Plan fields and pure plan rules

**Files:**
- Modify: `server/prisma/schema.prisma` (`model User`)
- Create: `server/prisma/migrations/20261020000000_user_plan/migration.sql`
- Create: `server/src/plans/plan.ts`
- Test: `server/src/plans/plan.spec.ts`

**Interfaces:**
- Produces:
  - `PLANS: readonly ['free','host','club']`
  - `type Plan`
  - `type PaidPlan = Exclude<Plan,'free'>`
  - `interface PlanOwner { role: string; plan: string; planRenewsAt: Date | null }`
  - `effectivePlan(owner: PlanOwner | null, now: Date): Plan`
  - `planAtLeast(plan: Plan, required: PaidPlan): boolean`
  - `GROUP_LIMIT: Record<Plan, number>`
  - `FREE_ARCHIVE_DAYS = 30`

- [ ] **Step 1: Write the failing test** in `server/src/plans/plan.spec.ts`

```ts
const now = new Date('2026-10-20T12:00:00+07:00');
const host = (plan: string, planRenewsAt: Date | null) => ({ role: 'host', plan, planRenewsAt });

it('treats an ownerless group as club', () => expect(effectivePlan(null, now)).toBe('club'));
it('treats an admin owner as club whatever the column says', () =>
  expect(effectivePlan({ role: 'admin', plan: 'free', planRenewsAt: null }, now)).toBe('club'));
it('keeps a paid plan with no renewal date', () => expect(effectivePlan(host('host', null), now)).toBe('host'));
it('keeps a paid plan until the instant after renewal', () =>
  expect(effectivePlan(host('club', now), now)).toBe('club'));
it('drops a lapsed plan to free', () =>
  expect(effectivePlan(host('host', new Date(now.getTime() - 1)), now)).toBe('free'));
it('reads an unknown plan string as free', () => expect(effectivePlan(host('gold', null), now)).toBe('free'));
it('orders plans', () => {
  expect(planAtLeast('club', 'host')).toBe(true);
  expect(planAtLeast('host', 'host')).toBe(true);
  expect(planAtLeast('free', 'host')).toBe(false);
  expect(planAtLeast('host', 'club')).toBe(false);
});
it('pins the group limits', () => expect(GROUP_LIMIT).toEqual({ free: 1, host: 3, club: 10 }));
```

- [ ] **Step 2: Run it and confirm it fails.** Run `cd server && npx vitest run src/plans/plan.spec.ts`. Expected: FAIL, cannot resolve `./plan.js`.

- [ ] **Step 3: Add the schema fields and migration.** In `model User`, add:
  - `plan String @default("club")`, with a `///` comment saying the default `club` is what makes this deploy dormant (no group cap, every feature) and that new users are set by an admin.
  - `planRenewsAt DateTime?`, with a comment saying null means it never lapses.

  The migration is plain `ADD COLUMN`, never a table redefine (same reason as `20261002100000_group_share_token`):

```sql
ALTER TABLE "User" ADD COLUMN "plan" TEXT NOT NULL DEFAULT 'club';
ALTER TABLE "User" ADD COLUMN "planRenewsAt" DATETIME;
```

  Run `npx prisma migrate deploy && npx prisma generate`.

- [ ] **Step 4: Implement `server/src/plans/plan.ts`** to the interfaces above. Add a header comment pointing at `docs/2026-10-06-pricing-tiers.md`, and comments for the ownerless and admin → `club` rules.

- [ ] **Step 5: Run the tests.** Run `npx vitest run src/plans/plan.spec.ts`, then `npm test`. Expected: all pass, and no existing spec changes behaviour.

- [ ] **Step 6: Commit.** `git commit -m "feat(server): user plan fields and pure plan rules"`

### Task 2: PlansService and the group plan endpoint

**Files:**
- Create: `server/src/plans/plans.service.ts`, `server/src/plans/plans.module.ts`
- Modify: `server/src/groups/groups.module.ts` (import `PlansModule`), `server/src/groups/groups.controller.ts` (new route)
- Test: `server/src/plans/plans.service.spec.ts`

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: `PlansService`, with
  - `planForGroup(groupCode: string, now?: Date): Promise<Plan>`
  - `planForSession(sessionCode: string, now?: Date): Promise<Plan>`
  - `requireGroupPlan(groupCode: string, required: PaidPlan): Promise<void>`
  - `requireSessionPlan(sessionCode: string, required: PaidPlan): Promise<void>`
- A missing group or session resolves to `club`, so the caller's own 404 still decides.
- `GET /groups/:code/plan` → `{ plan: Plan; renewsAt: string | null }`, where `renewsAt` is the owner's `planRenewsAt` as ISO. It returns 404 when the group does not exist, the same as `getShuttleTools`.
- `PlansModule` exports `PlansService`.

- [ ] **Step 1: Write the failing tests.** Use the supertest harness from `group-share.controller.spec.ts` (fake `req.user` as an admin), importing `PrismaModule, GroupsModule`.
  - `planForGroup` returns `'free'` for a group owned by `{ role:'host', plan:'free' }`.
  - It returns `'free'` for a host-plan owner whose `planRenewsAt` is yesterday.
  - It returns `'club'` for an admin-owned group and for an ownerless group.
  - `requireGroupPlan(freeGroup, 'host')` rejects with `ForbiddenException`, and its `getResponse()` equals `{ code: 'PLAN_REQUIRED', requiredPlan: 'host' }`.
  - `requireSessionPlan` resolves through the session's `groupId`.
  - `GET /groups/:code/plan` on the free host's group, with the request user being the **admin**, returns `200 { plan: 'free', renewsAt: null }` (Review Focus 3). On an unknown code it returns 404.

- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run src/plans/plans.service.spec.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the service, the module and the route.** The route sits next to `getShuttleTools` and needs no ownership change, because `/groups/:code/*` is already covered by `OwnershipGuard`.

- [ ] **Step 4: Run the tests.** Run `npx vitest run src/plans/plans.service.spec.ts && npm test`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(server): resolve a group's plan from its owner"`

### Task 3: Admin sets a user's plan (server)

**Files:**
- Create: `server/src/admin/dto/set-plan.dto.ts`
- Modify: `server/src/admin/admin.controller.ts`, `server/src/admin/admin.service.ts` (`listUsers`, new `setPlan`), `docs/overview.md` (new "Plans" section)
- Test: `server/src/admin/admin.spec.ts`

**Interfaces:**
- Produces:
  - `SetPlanDto { plan: Plan; renewsAt: string | null }`: `@IsIn(PLANS)`, and `@ValidateIf(v !== null) @Matches(/^\d{4}-\d{2}-\d{2}$/)`.
  - `PUT /admin/users/:id/plan` → `{ id, plan, planRenewsAt: string | null, effectivePlan: Plan }`.
  - `listUsers()` rows gain `plan`, `planRenewsAt`, `effectivePlan`.

- [ ] **Step 1: Write the failing tests** in `admin.spec.ts`, following its existing style.
  - PUT `{ plan: 'free', renewsAt: null }` → 200, `effectivePlan: 'free'`.
  - PUT `{ plan: 'host', renewsAt: '2026-11-19' }` stores `planRenewsAt` as `2026-11-19T16:59:59.999Z`.
  - PUT with plan `'gold'` → 400.
  - PUT on an unknown id → 404.
  - After setting `renewsAt` to a past date, `GET /admin/users` shows `plan: 'host', effectivePlan: 'free'`.
  - A non-admin caller gets 404 on the route. The existing `/admin` prefix refusal covers this; add one assertion.

- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run src/admin/admin.spec.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `setPlan(id: string, dto: SetPlanDto)` and the route.** Store `planRenewsAt` per Global Constraints.

- [ ] **Step 4: Document it.** Add a short "Plans" section to `docs/overview.md`: fields, the `effectivePlan` rules, the dormant default, that the 403 codes are the ones listed above, and a pointer to the tier doc.

- [ ] **Step 5: Run the tests.** Run `npx vitest run src/admin/admin.spec.ts && npm test && npm run lint`. Expected: PASS.

- [ ] **Step 6: Commit.** `git commit -m "feat(server): admin sets a user's plan and renewal date"`

### Task 4: Admin plan control (web)

**Files:**
- Create: `web/src/app/core/plan.ts` (the `Plan` type and its labels only)
- Modify: `web/src/app/core/admin.service.ts` (`AdminUser` fields, `setPlan`), `web/src/app/pages/admin/admin.ts`, `admin.html`, `admin.css`, `web/src/locale/messages*.xlf`
- Test: `web/src/app/core/admin.service.spec.ts`, `web/src/app/pages/admin/admin.spec.ts` (create if absent)

**Interfaces:**
- Consumes: Task 3 route.
- Produces:
  - `type Plan = 'free' | 'host' | 'club'`, exported from `web/src/app/core/plan.ts`. Task 10 reuses it.
  - `AdminService.setPlan(id: string, plan: Plan, renewsAt: string | null): Observable<unknown>`.

- [ ] **Step 1: Write the failing tests.**
  - The service sends `PUT ${B}/admin/users/u1/plan` with body `{ plan: 'free', renewsAt: null }`.
  - In the component, a user row shows the effective plan label. Choosing `ฟรี` and saving calls `setPlan('u1','free',null)`. A row whose `plan !== effectivePlan` shows a lapsed marker (`data-plan-lapsed`).

- [ ] **Step 2: Run them and confirm they fail.** Run `cd web && npx ng test --watch=false`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement.** Each user row gets:
  - a plan `<select>` (3 options)
  - an optional `<input type="date">` for the renewal date
  - a save button

  Labels come from Global Constraints. Lapsed copy: `หมดอายุ — ใช้แบบฟรีอยู่` / `Lapsed: on Free`. Extract i18n and add English targets.

- [ ] **Step 4: Run the tests.** Run `npx ng test --watch=false && npm run build`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(web): admin sets a host's plan"`

> **Phase 1 checkpoint:** deployable. Every existing user reads `club` with no expiry, so no behaviour changes. Before rebuilding the container, confirm the server runs the `20261020000000_user_plan` migration (see the 2026-09-21 deploy lesson in memory).

---

## Phase 2: server enforcement

### Task 5: Paid group routes

**Files:**
- Modify: `server/src/groups/groups.controller.ts` (inject `PlansService`)
- Test: `server/src/plans/plan-gates.groups.spec.ts`

**Interfaces:**
- Consumes: `PlansService.requireGroupPlan`.

Each gate is one `await this.plans.requireGroupPlan(code, 'host')` line at the top of the handler. The handlers become `async`.

| Route | Gated when |
|---|---|
| `PUT :code/levels` (custom ladder) | always |
| `POST :code/share` | always (GET and DELETE stay open) |
| `POST :code/shuttle-tools` | `dto.enabled === true` |
| `POST :code/cross-session-history` | `dto.enabled === true` |
| `POST :code/rules`, `PUT :code/rules/:ruleId` | always (DELETE stays open) |
| `GET :code/players/:playerId/stats` | always |
| `GET :code/export` | always |

- [ ] **Step 1: Write the failing tests.** Fixtures: a free host owns group F, a host-plan host owns group H, and the request user is the free host (`{ id, role: 'host' }`). Use `it.each` over the table.
  - Each gated call on F → 403 with body `{ code: 'PLAN_REQUIRED', requiredPlan: 'host' }`.
  - The same call on H (request user switched to H's owner) does not return 403.
  - On F, these all return 2xx (Review Focus 2):
    - `POST shuttle-tools {enabled:false}`
    - `POST cross-session-history {enabled:false}`
    - `DELETE share`
    - `DELETE rules/:id`, on a rule seeded directly with Prisma
    - `PUT players/:id/level`

- [ ] **Step 2: Run them and confirm they fail.** Run `npx vitest run src/plans/plan-gates.groups.spec.ts`. Expected: FAIL (the gated calls return 2xx).

- [ ] **Step 3: Implement the gates per the table.**

- [ ] **Step 4: Run the tests.** Run the spec, then `npm test`. Expected: PASS. Existing specs stay green because their owners are admin, ownerless or default `club`.

- [ ] **Step 5: Commit.** `git commit -m "feat(server): gate paid group routes by plan"`

### Task 6: Free-plan data shaping (ratings and archive window)

**Files:**
- Modify: `server/src/groups/groups.service.ts` (`listPlayersManage`, `listSessions`, inject `PlansService`)
- Test: `server/src/plans/plan-gates.groups.spec.ts`

**Interfaces:**
- Consumes: `PlansService.planForGroup`, `FREE_ARCHIVE_DAYS`.
- Produces:
  - `listSessions(code: string, now?: Date)`: on free it adds `createdAt: { gte: now − 30 days }` to the `where`.
  - `listPlayersManage(code)`: on free it returns `rating: null`, `singlesRating: null`, `winRate: null`. The web type already allows null for `singlesRating` and `winRate`; widen `rating` to `number | null` in Task 12.

- [ ] **Step 1: Write the failing tests.**
  - Players with finished matches: on F, `GET players/manage` returns `rating`, `singlesRating` and `winRate` all `null`. On H the same data gives a number for `rating`.
  - Sessions created 40 days and 2 days ago: on F, `GET :code/sessions` lists only the 2-day one. On H it lists both.
  - On F, `GET /sessions/<40-day code>/summary` → 200 (Review Focus 5). Import `SessionsModule` in this spec.
  - After switching F's owner to `host`, `players/manage` ratings reflect matches from the 40-day session. Assert the rating differs from 1200 for a player who only played there.

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement.** Do **not** filter `finishedMatches()` (Global Constraints).

- [ ] **Step 4: Run the tests.** Run the spec, then `npm test`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(server): hide ratings and old archive on the free plan"`

### Task 7: Group limit

**Files:**
- Modify: `server/src/plans/plans.service.ts`, `server/src/groups/groups.service.ts` (`create`, `parse`)
- Test: `server/src/plans/group-limit.spec.ts`

**Interfaces:**
- Produces: `PlansService.assertCanCreateGroup(caller: { id: string; role: string }, now?: Date): Promise<void>`.
  - Admin → no-op.
  - Otherwise it reads the caller's own `User` row, gets the plan via `effectivePlan`, and counts `group.count({ where: { ownerId } })`.
  - When the count is at or above `GROUP_LIMIT[plan]`, it throws 403 `{ code: 'GROUP_LIMIT', limit }`.
- `create` and `parse` call it only when no group exists at `dto.code` / `code`, before the upsert. A retry on an existing own code is never refused.

- [ ] **Step 1: Write the failing tests.**
  - A free host owning 1 group: `POST /groups` with a new code → 403 `{ code:'GROUP_LIMIT', limit: 1 }`.
  - The same host re-POSTing their existing code → 2xx and unchanged.
  - A free host: `POST /groups/<new>/parse` → 403 GROUP_LIMIT.
  - A host plan owning 3 groups: a 4th is refused with `limit: 3`. A club plan with 3 is allowed.
  - An admin caller with 12 groups is allowed.
  - A host plan lapsed to free with 3 groups: a new one is refused with `limit: 1`. Existing groups still read with `GET /groups/:code` → 200.

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement.** Add a comment that two concurrent creates can both pass the count. That is accepted for manual billing, not a security boundary.

- [ ] **Step 4: Run the tests.** Run the spec, then `npm test`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(server): cap groups per plan"`

### Task 8: Paid session controls and creation snapshots

**Files:**
- Modify: `server/src/sessions/sessions.module.ts` (import `PlansModule`), `server/src/sessions/sessions.controller.ts`, `server/src/sessions/sessions.service.ts` (`createSessionExclusively` snapshot)
- Test: `server/src/plans/plan-gates.sessions.spec.ts`

**Interfaces:**
- Consumes: `PlansService.requireSessionPlan`, `planForGroup`, `planAtLeast`.

| Route | Gated when |
|---|---|
| `POST :code/mode` | `dto.mode` is `'balanced'` or `'level'` |
| `POST :code/courts/:n/mode` | `dto.mode !== 'custom'` |
| `POST :code/courts/:n/target` | `dto.target !== 'auto'` |
| `POST :code/queue`, `POST :code/queue/:id` | always (move and both DELETEs stay open) |

At session creation, the snapshot becomes `shuttleToolsEnabled: group.shuttleToolsEnabled && paid` and `crossSessionHistory: group.crossSessionHistory && paid`, where `paid = planAtLeast(await plans.planForGroup(dto.groupCode), 'host')`. Resolve the plan before the transaction.

- [ ] **Step 1: Write the failing tests.** Use the fixture shape from `court-targets.controller.spec.ts`, with the group owned by a free host.
  - `mode balanced` → 403 PLAN_REQUIRED, and `mode level` → 403.
  - `mode variety` → 2xx, and `mode custom` → 2xx.
  - Court mode `level` → 403, and court mode `custom` → 2xx.
  - Target `low` → 403, and target `auto` → 2xx.
  - `POST queue` → 403.
  - **Running state (Review Focus 1):** a free group's session seeded with `mode: 'balanced'` and 4 roster players → `POST courts/1/propose` → 2xx.
  - Snapshot: the group has `shuttleToolsEnabled: true, crossSessionHistory: true` and a free owner. Calling `SessionsService.createSession` with the minimal DTO used in `groups/custom-level-assignment.spec.ts` gives a stored session with both flags `false`. The same setup with a host owner keeps both `true`.

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement per the table and the snapshot rule.**

- [ ] **Step 4: Run the tests.** Run the spec, then `npm test`, then `npm run test:e2e`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(server): gate paid session controls and snapshots by plan"`

### Task 9: Bill extras

**Files:**
- Modify: `server/src/sessions/bill-config.ts` (new helper), `server/src/sessions/bill.service.ts` (`setBillConfigExclusively`, `getBill`), `docs/overview.md` (extend "Plans" with the gate list)
- Test: `server/src/plans/plan-gates.bill.spec.ts`

**Interfaces:**
- Produces:
  - `withoutPaidExtras(c: BillConfig): BillConfig`, which returns `{ ...c, hostFeeSatang: 0, walkInFeeSatang: 0, absentIds: [] }`.
  - `perShuttle` and `shuttleCharge` are already covered, because they ride on the session's `shuttleToolsEnabled` snapshot from Task 8.
- `setBillConfig` on a free session refuses 403 PLAN_REQUIRED when `hostFeeSatang > 0`, `walkInFeeSatang > 0`, or `(dto.absentIds ?? []).length > 0`.
- `getBill` on a free session applies `withoutPaidExtras` when `configSource !== 'saved'`. A saved config is running state and is left alone.

- [ ] **Step 1: Write the failing tests.**
  - Free session: POST bill-config with `hostFeeSatang: 2000` → 403. With `walkInFeeSatang: 1000` → 403. With `absentIds: [p1]` → 403.
  - Free session: POST with all three zero or empty and `model: 'fair'` → 2xx.
  - **Prefill (Review Focus 4):** an earlier session in the same group has a saved config with `hostFeeSatang: 2000`, and the owner is now free. A new session's `GET :code/bill` has `config.hostFeeSatang === 0` and `configSource === 'previous'`. With a host owner it stays 2000.
  - Free group with a session that already has a saved host fee: `GET bill` still shows 2000 (running state).

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement. Extend the "Plans" section of `docs/overview.md`** with the full gate list from Tasks 5–9.

- [ ] **Step 4: Run the tests.** Run the spec, then `npm test && npm run lint`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(server): gate bill extras by plan"`

> **Phase 2 checkpoint:** deployable. Still dormant until an admin sets someone to `free` or a renewal date lapses.

---

## Phase 3: web

### Task 10: Plan state, lock hint and refusal messages

**Files:**
- Create: `web/src/app/core/plan.service.ts`, `web/src/app/shared/plan-lock/plan-lock.ts` (+ `.html`, `.css`)
- Modify: `web/src/app/core/plan.ts` (from Task 4: add `GroupPlan`, `isPaid`, `planErrorMessage`), `web/src/app/core/live-session.service.ts` (`messageForCode`), `web/src/locale/messages*.xlf`
- Test: `web/src/app/core/plan.service.spec.ts`, `web/src/app/shared/plan-lock/plan-lock.spec.ts`, `web/src/app/core/live-session.service.spec.ts`

**Interfaces:**
- Produces:
  - `interface GroupPlan { plan: Plan; renewsAt: string | null }`
  - `PlanService.forGroup(groupCode: string): Observable<GroupPlan>`
  - `isPaid(plan: Plan | null): boolean`. `null` (not loaded or failed) → `true`: a failed load must never lock the host out courtside, because the server still refuses.
  - `planErrorMessage(err: unknown): string | null`, which maps 403 `PLAN_REQUIRED` and `GROUP_LIMIT` (with `limit`) to copy.
  - `<app-plan-lock />`, a muted inline hint.
- Copy:
  - Lock hint: `ใช้ได้ในแพ็กเกจโฮสต์` / `Available on the Host plan`, with the sub-line `ติดต่อผู้ดูแลเพื่ออัปเกรด` / `Contact the admin to upgrade`.
  - PLAN_REQUIRED: `ฟีเจอร์นี้ใช้ได้ในแพ็กเกจโฮสต์ ติดต่อผู้ดูแลเพื่ออัปเกรด` / `This feature needs the Host plan. Contact the admin to upgrade.`
  - GROUP_LIMIT: `แพ็กเกจของคุณสร้างก๊วนได้สูงสุด {limit} ก๊วน` / `Your plan allows up to {limit} groups`.

- [ ] **Step 1: Write the failing tests.**
  - `forGroup('G1')` GETs `${B}/groups/G1/plan`.
  - `isPaid(null) === true`, `isPaid('free') === false`, `isPaid('club') === true`.
  - `planErrorMessage` on an `HttpErrorResponse` with status 403 and body `{code:'GROUP_LIMIT',limit:3}` contains `3`.
  - `messageForCode('PLAN_REQUIRED')` returns the PLAN_REQUIRED copy.
  - `<app-plan-lock>` renders both lines.

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement. Extract i18n and add English targets.**

- [ ] **Step 4: Run the tests.** Run `npx ng test --watch=false`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(web): plan state, lock hint and refusal copy"`

### Task 11: Session dashboard and bill locks

**Files:**
- Modify: `web/src/app/pages/session-dashboard/session-dashboard.ts`/`.html` (load the plan from `session().groupCode`; mode buttons), `pages/session-dashboard/court-panel/*` (new `paid` input; court mode and target controls), `pages/session-dashboard/lineup-queue/*` (`paid` input; add and replace), `shared/bill-settings/*` (`paid` input; host fee and walk-in inputs), `pages/session-bill/*` (pass `paid`; ไม่มา control)
- Test: the matching `*.spec.ts` files

**Interfaces:**
- Consumes: `PlanService.forGroup`, `isPaid`, `<app-plan-lock>`.
- Every gated control is shown but **disabled** with `<app-plan-lock>` beside it, never removed. A free host should see what upgrading gets them.
- A control whose *current* value is already a paid one stays enabled, so the host can switch it back (Global Constraints). For example, the mode toggle in a session already on `balanced` keeps `variety` and `custom` enabled.

- [ ] **Step 1: Write the failing tests.** With the plan flushed as `free`:
  - The `balanced` and `level` mode buttons are `disabled`, and `variety` and `custom` are not.
  - The court-panel mode and target controls are disabled.
  - The lineup "add" control is disabled.
  - The bill-settings `[data-rate="hostFee"]` and `[data-rate="walkInFee"]` inputs are disabled.
  - The ไม่มา control is disabled.
  - With the plan as `host`, all of these are enabled.
  - With the plan request erroring, all are enabled.

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests.** Run `npx ng test --watch=false && npm run build`. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(web): lock paid session and bill controls on the free plan"`

### Task 12: Group pages locks and archive note

**Files:**
- Modify: `pages/group-settings-detail/*` (advanced switches, share section, export), `pages/group-levels/*` (save ladder), `pages/player-roster/*` (rating columns, add-rule, share-player link), `core/roster.service.ts` (`ManagedPlayer.rating: number | null`), `pages/group-home/*` (archive note), `pages/group-create/*` (GROUP_LIMIT message), `docs/2026-10-06-pricing-tiers.md` (status line)
- Test: the matching `*.spec.ts` files

**Interfaces:**
- Consumes: Task 10.
- Archive note on group-home when the plan is free: `แสดงเฉพาะรอบใน 30 วันล่าสุด` / `Showing the last 30 days only`.

- [ ] **Step 1: Write the failing tests.** With the plan as `free`:
  - The shuttle-tools and cross-session switches are disabled when off and enabled when on (so the host can turn them off).
  - Share with no token shows `<app-plan-lock>` instead of the enable button. Share with a token still shows stop-sharing.
  - The export button is disabled.
  - The ladder save is disabled.
  - The roster hides the rating, singles-rating and win-rate sort heads and cells, disables add-rule, and hides `[data-share-player]`.
  - group-home shows the archive note.
  - group-create, given a 403 GROUP_LIMIT `limit:1` response, shows the GROUP_LIMIT copy with `1`.
  - With the plan as `host`, none of the locks or the note appear.

- [ ] **Step 2: Run them and confirm they fail.**

- [ ] **Step 3: Implement. Update the tier doc status line** to "built behind admin-set plans, dormant until a host is set to free".

- [ ] **Step 4: Run the full suite.** Run `npm test` from the repo root (engines + server + web). Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -m "feat(web): lock paid group features on the free plan"`

> **Phase 3 checkpoint:** feature complete and still dormant. Going live for one host is just an admin action: set their plan to `free`, or give them a renewal date.
