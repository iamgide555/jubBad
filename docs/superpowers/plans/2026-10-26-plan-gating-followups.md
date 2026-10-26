# Plan Gating Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the gaps found by the 2026-10-26 critique of `feat/plan-gating` (22/40): give every lock an upgrade path, tell a host before and after their plan lapses, make paid effects actually stop on lapse, and clean up the confusing and noisy lock states.

**Architecture:** The server stays the only judge of a plan. Two new read-time rules: a lapsed owner's groups past the plan's cap are *paused* (no new session), and pair rules do nothing in a session created on the free plan. The web gets one shared upgrade sheet, opened from every lock, with the contact link served by the API from an env value. No schema change, no migration.

**Tech Stack:** NestJS + Prisma + SQLite (vitest), Angular standalone + signals (ng test), `$localize` with `messages.xlf` (th source) and `messages.en.xlf`.

**Spec:** the critique snapshot `.impeccable/critique/2026-10-26T07-03-06Z__web-src-app-shared-plan-lock-plan-lock-html.md` (main checkout, untracked) plus the owner's decisions of 2026-10-26, recorded under "Decisions" below. Existing behaviour is in `docs/overview.md` → "Plans" and `docs/2026-10-06-pricing-tiers.md`.

## Decisions (owner, 2026-10-26)

1. **Upgrade contact:** a configurable link. The server reads `UPGRADE_CONTACT_URL`. If it is unset, or not an `https://` URL, the sheet shows text only and no link.
2. **Paid effects stop on lapse** (this reverses "never trap" for these two cases):
   - **Groups past the cap are paused.** The owner's groups are ranked by newest session, then by newest group. The top `GROUP_LIMIT[plan]` stay usable; the rest cannot start a new session. A paused group can still be viewed, exported, renamed, deleted and cleaned up, and a session already running in it carries on.
   - **Rules stop for sessions created on free.** Judged by `effectivePlan(owner, session.createdAt)`, the same way as the shuttle-tools and bill snapshots. A session created while paid keeps its rules even if the plan lapses mid-night.
   - **The shared `/d/` link stays live.** Only new shares are blocked, which is already built.
3. **The lapse notice is not on the live dashboard.** It goes on group home and the roster-entry page only, because the dashboard is used courtside and the notice is not actionable mid-night. (This changes what the critique reply first proposed.)

## Global Constraints

- Every new user-facing string uses `$localize`/`i18n` with an `@@id`, a Thai source, and an English `<target>` in `web/src/locale/messages.en.xlf`. Re-run extraction (`cd web && npx ng extract-i18n --output-path src/locale`) so `messages.xlf` matches.
- In Thai copy, write "แพ็ก⁠เกจ" (U+2060 WORD JOINER inside the word) so the browser never breaks it mid-word.
- Keep tap targets at least 44px. The web keeps no localStorage state. No new npm dependencies.
- Gating is derived at read time, never stored per feature. Public routes are never gated. A running session's state is never changed by a plan.
- Server tests run with `fileParallelism: false`; leave it that way.
- Refusal codes are 403 with a body code. New: `GROUP_PAUSED` (with `limit`).
- No price appears anywhere in the app.

## Review Focus

1. **A session running in a group that becomes paused, or whose plan lapses mid-night,** keeps proposing and confirming, and its rules keep applying. Test owner: Tasks 2 and 3.
2. **The host deletes their one usable group:** the next-ranked group unpauses at once, because the ranking is re-read every time. Test owner: Task 1.
3. **An owner with no sessions in any group:** the ranking falls back to the newest group, so exactly `limit` groups stay usable. Test owner: Task 1.
4. **`UPGRADE_CONTACT_URL` unset, or set to `javascript:`/`http:`:** the API returns `null` and the sheet still opens, text only. Test owner: Tasks 1 and 4.
5. **An admin opening a free host's paused group** is refused a new session as that host (the existing rule: an admin is gated by the owner's plan), and group home shows the paused state. Test owner: Task 2.

---

### Task 1: Server: paused groups, lapse facts, caller plan, contact URL

**Files:**
- Modify: `server/src/plans/plan.ts`
- Modify: `server/src/plans/plans.service.ts`
- Create: `server/src/plans/plans.controller.ts` (register in `plans.module.ts`)
- Modify: `server/src/groups/groups.controller.ts` (`getPlan`)
- Test: `server/src/plans/plan.spec.ts`, `server/src/plans/plans.service.spec.ts`, `server/src/plans/plans.controller.spec.ts`

**Interfaces:**
- Produces (pure, `plan.ts`):
  - `rankForCap(groups: { code: string; createdAt: Date; lastSessionAt: Date | null }[]): string[]`. Codes ordered by `lastSessionAt` desc (nulls last), then `createdAt` desc, then `code` asc.
  - `lapsedAt(owner: PlanOwner | null, now: Date): Date | null`. Returns `owner.planRenewsAt` when the role is not admin, the stored plan is `host` or `club`, and `now > planRenewsAt`. Otherwise `null`.
  - `upgradeContactUrl(raw: string | undefined): string | null`. Returns the URL only when `new URL(raw)` parses with protocol `https:`.
- Produces (`PlansService`):
  - `pausedGroupCodes(ownerId: string, now?: Date): Promise<Set<string>>`. Empty for an admin owner. Otherwise `rankForCap(...)` with the first `GROUP_LIMIT[effectivePlan]` codes removed.
  - `isGroupPaused(groupCode: string, now?: Date): Promise<boolean>`. False for an ownerless group.
  - `describeGroup` adds `lapsedAt: string | null`, `paused: boolean` and `archiveHidden: number` (sessions older than `FREE_ARCHIVE_DAYS` when the plan is free, else 0).
  - `describeCaller(caller: { id: string; role: string }, now?: Date): Promise<{ plan: Plan; renewsAt: string | null; lapsedAt: string | null; groupCount: number; groupLimit: number | null; upgradeUrl: string | null }>`. `groupLimit` is null for an admin.
- Produces (HTTP):
  - `GET /plans/me` returns `describeCaller` for the signed-in user. Not `@Public`; there is no group in the route, so there is no ownership check.
  - `GET /groups/:code/plan` returns the extended `describeGroup`.

- [ ] **Step 1: Write failing pure tests in `plan.spec.ts`**
  - `rankForCap`: the newest session wins; a group with no session ranks below any group with one; ties fall to the newer `createdAt`, then the code.
  - `lapsedAt`: `host` with a renewal date in the past returns that date; `free` with a past date returns `null`; an admin returns `null`; `planRenewsAt = null` returns `null`.
  - `upgradeContactUrl`: `'https://line.me/R/ti/p/@jubbad'` comes back as is; `undefined`, `''`, `'http://x'`, `'javascript:alert(1)'` and `'line.me/x'` return `null`.
- [ ] **Step 2: Run** `cd server && npx vitest run src/plans/plan.spec.ts`. Expected: FAIL (not exported).
- [ ] **Step 3: Implement the three pure functions in `plan.ts`.**
- [ ] **Step 4: Write failing service tests in `plans.service.spec.ts`**
  - A free owner with 2 groups, sessions on 01/10 (A) and 05/10 (B): `pausedGroupCodes` is `{A}`.
  - After group B is deleted: `{}`. This is Review Focus 2.
  - A free owner with 2 groups and no sessions: only the older group is paused. This is Review Focus 3.
  - A host owner with 2 groups: `{}`. An admin owner with 12 groups: `{}`.
  - `describeGroup` on a lapsed host's group returns `lapsedAt` equal to the stored date, and `archiveHidden` counts only sessions older than 30 days.
  - `describeCaller` for a free user with 2 groups returns `groupCount: 2, groupLimit: 1`. For an admin, `groupLimit` is `null`.
  - `upgradeUrl` comes from `process.env.UPGRADE_CONTACT_URL`. Set and restore it in the test.
- [ ] **Step 5: Implement the service methods.** Read `UPGRADE_CONTACT_URL` at call time, not at import, so tests can set it.
- [ ] **Step 6: Add `PlansController` with `@Get('me')` under `@Controller('plans')`, and extend `getPlan`.** Add a controller spec: an unauthenticated call returns 401, and a signed-in free user gets the `describeCaller` shape.
- [ ] **Step 7: Run** `cd server && npx vitest run src/plans`. Expected: PASS.
- [ ] **Step 8: Commit** with message `feat(server): paused groups, lapse facts and caller plan`

### Task 2: Server: a paused group cannot start a session; group list shows paused

**Files:**
- Modify: `server/src/sessions/sessions.service.ts` (`createSession`, around line 477)
- Modify: `server/src/groups/groups.service.ts` (`listGroups`)
- Test: `server/src/plans/plan-gates.sessions.spec.ts`, `server/src/groups/list-groups.spec.ts`

**Interfaces:**
- Consumes: `PlansService.isGroupPaused`, `PlansService.pausedGroupCodes` (Task 1).
- Produces: `POST /sessions` on a paused group returns 403 `{ code: 'GROUP_PAUSED', limit }`. Each `listGroups` row gains `paused: boolean`. Admin callers get it for every group, judged by each group's owner.

- [ ] **Step 1: Write failing tests**
  - A free owner's older-ranked group: `createSession` throws `ForbiddenException` whose body has code `GROUP_PAUSED`, `limit: 1`. Their newest group creates normally.
  - The same refusal when the caller is an admin creating in that host's paused group. This is Review Focus 5.
  - A session already open in the paused group still proposes and confirms a court. This is Review Focus 1.
  - `listGroups` for the free owner marks only the older group `paused: true`.
- [ ] **Step 2: Run** `cd server && npx vitest run src/plans/plan-gates.sessions.spec.ts src/groups/list-groups.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Check `isGroupPaused(dto.groupCode)` before the transaction, next to the existing `paid` lookup, and throw `ForbiddenException({ code: 'GROUP_PAUSED', limit })`. In `listGroups`, resolve `pausedGroupCodes` once per distinct owner.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(server): pause groups past the plan cap`

### Task 3: Server: pair rules do nothing in a session created on free

**Files:**
- Modify: `server/src/plans/plans.service.ts`
- Modify: `server/src/sessions/sessions.service.ts` (`loadEnabledRules` around line 236, `getSessionRules` around line 2819)
- Test: `server/src/plans/plan-gates.sessions.spec.ts`

**Interfaces:**
- Produces: `PlansService.planAtSessionCreation(sessionCode: string): Promise<Plan>`, which is `effectivePlan(owner, session.createdAt)` and returns `club` for a missing session.
- Produces: the `getSessionRules` response gains `rulesActive: boolean`.
- `loadEnabledRules` takes `{ code: string; groupId: string; disabledRuleIds: string | null }` and returns `[]` when `planAtSessionCreation` is free. Every caller passes the full session row, so callers do not change.

- [ ] **Step 1: Write failing tests**
  - A lapsed host's group has a `never-teammates` rule between P1 and P2. In a session created after the lapse, proposing on a 4-player roster can pair P1 with P2 (seed the engine so the rule-free result pairs them), and `getSessionRules` returns `rulesActive: false` with the rule still listed.
  - The same group in a session created before the lapse date (set `createdAt` explicitly) still honours the rule, and returns `rulesActive: true`. This is Review Focus 1.
- [ ] **Step 2: Run** `cd server && npx vitest run src/plans/plan-gates.sessions.spec.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `planAtSessionCreation`, the early return in `loadEnabledRules`, and `rulesActive`.**
- [ ] **Step 4: Run** `cd server && npx vitest run`. Expected: PASS, with no other spec regressing.
- [ ] **Step 5: Commit** with message `feat(server): rules stop in sessions created on free`

### Task 4: Server and web: admin user list carries the cap

**Files:**
- Modify: `server/src/admin/admin.service.ts` (list around line 41, plan update around line 103)
- Test: `server/src/admin/admin.spec.ts`

**Interfaces:**
- Produces: each admin user row gains `groupLimit: number | null` (`GROUP_LIMIT[effectivePlan]`, null for admins). Task 12 uses it.

- [ ] **Step 1: Write a failing test.** A free user owning 2 groups returns `groupLimit: 1`; an admin returns `null`.
- [ ] **Step 2: Run** `cd server && npx vitest run src/admin`. Expected: FAIL.
- [ ] **Step 3: Implement it in both the list and the plan-update responses.**
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(server): admin rows carry the group cap`

### Task 5: Web: plan model, upgrade sheet, one-line lock

**Files:**
- Modify: `web/src/app/core/plan.ts`, `web/src/app/core/plan.service.ts`, `web/src/app/core/plan.testing.ts`
- Create: `web/src/app/shared/upgrade-sheet/upgrade-sheet.{ts,html,css,spec.ts}`
- Create: `web/src/app/core/upgrade-sheet.service.ts` (+ spec)
- Modify: `web/src/app/shared/app-shell/` (mount `<app-upgrade-sheet />` once)
- Modify: `web/src/app/shared/plan-lock/plan-lock.{ts,html,css,spec.ts}`
- Modify: `web/src/locale/messages.xlf`, `web/src/locale/messages.en.xlf`

**Interfaces:**
- Produces (`plan.ts`):
  - `GroupPlan` gains `lapsedAt: string | null`, `paused: boolean` and `archiveHidden: number`.
  - New `MyPlan { plan: Plan; renewsAt: string | null; lapsedAt: string | null; groupCount: number; groupLimit: number | null; upgradeUrl: string | null }`.
  - `planErrorMessage` also maps `GROUP_PAUSED`.
  - `expiresSoon(p: GroupPlan, now: Date): boolean` is true when `p.plan !== 'free'`, `renewsAt` is set, and `0 < renewsAt - now <= 5 × 24h`.
- Produces: `PlanService.mine(): Observable<MyPlan>` (`GET /plans/me`).
- Produces: `UpgradeSheetService` (root) with `open(): void`, `close(): void`, `readonly isOpen: Signal<boolean>` and `readonly contactUrl: Signal<string | null>`. It loads `mine()` once, on first open. A failed load leaves `contactUrl` null and still opens.
- Produces: `<app-plan-lock [hint]>` renders one line: the hint, then a "ดูแพ็กเกจ" text button that calls `UpgradeSheetService.open()`. The `plan.lock.sub` id is deleted.

Copy (Thai source, English target):

| id | th | en |
|---|---|---|
| `plan.lock.more` | ดูแพ็ก⁠เกจ | See plan |
| `plan.required` | ฟีเจอร์นี้ใช้ได้ในแพ็ก⁠เกจโฮสต์ | This feature needs the Host plan |
| `plan.groupLimit` | แพ็ก⁠เกจฟรีสร้างได้ {limit} ก๊วน | The free plan allows {limit} group(s) |
| `plan.groupPaused` | ก๊วนนี้พักไว้ — แพ็ก⁠เกจฟรีเปิดรอบได้ {limit} ก๊วน (ก๊วนที่เล่นล่าสุด) | This group is paused: the free plan runs {limit} group(s), the most recently played |
| `upgrade.title` | แพ็ก⁠เกจโฮสต์ | Host plan |
| `upgrade.b1` | สูสีและตามระดับ จัดคู่ตามฝีมือ | Balanced and level modes |
| `upgrade.b2` | กฎจับคู่ คิวล่วงหน้า และโหมดแยกคอร์ท | Pair rules, lineup queue, per-court modes |
| `upgrade.b3` | ค่าโฮสต์ ค่า walk-in และไม่มา ในบิล | Host fee, walk-in fee and no-shows in the bill |
| `upgrade.b4` | ดูย้อนหลังทั้งหมด เรตติ้ง และหน้าสรุปก๊วน | Full history, ratings and the group dashboard |
| `upgrade.b5` | สร้างได้ 3 ก๊วน | Up to 3 groups |
| `upgrade.contact` | ติดต่อทาง LINE | Contact on LINE |
| `upgrade.contactText` | ติดต่อทีม JubBad เพื่ออัปเกรด | Contact the JubBad team to upgrade |
| `upgrade.close` | ปิด | Close |

Every other existing plan string that contains แพ็กเกจ gets the U+2060 too.

- [ ] **Step 1: Write failing tests**
  - `plan.spec.ts`: `expiresSoon` is true at 4 days 23h left; false at 5 days 1h; false when `renewsAt` is in the past; false on `free`.
  - `planErrorMessage` on a 403 `GROUP_PAUSED` with `limit: 1` returns the `plan.groupPaused` text.
  - `modesLockHint()` contains `'แพ็ก⁠เกจ'`.
  - `upgrade-sheet.spec.ts`: with `contactUrl` set, an `<a>` with that `href`, `target="_blank"` and `rel="noopener"`; with `null` (Review Focus 4), no `<a>` and the `upgrade.contactText` line instead; Escape and the close button both close it.
  - `plan-lock.spec.ts`: clicking "ดูแพ็กเกจ" calls `open()`, and no `.lock-sub` element remains.
- [ ] **Step 2: Run** `cd web && npm test`. Expected: the new specs FAIL.
- [ ] **Step 3: Implement.** The sheet uses the existing `<dialog class="sheet-dialog">` pattern from `add-rule-dialog`, with `showModal()` on open. Plain list, one primary button, close as ghost.
- [ ] **Step 4: Extract i18n and add the English targets.** Then run `cd web && npm test && npm run build`. Expected: PASS, and the build reports no missing translations.
- [ ] **Step 5: Commit** with message `feat(web): upgrade sheet and one-line plan lock`

### Task 6: Web: group home and roster entry (lapse notice, paused group, honest rows)

**Files:**
- Create: `web/src/app/shared/plan-notice/plan-notice.{ts,html,css,spec.ts}`
- Modify: `web/src/app/pages/group-home/group-home.{ts,html,css,spec.ts}`
- Modify: `web/src/app/pages/group-entry/group-entry.{ts,html,spec.ts}`

**Interfaces:**
- Consumes: `GroupPlan` (with `lapsedAt`, `paused`, `archiveHidden`), `expiresSoon`, and `UpgradeSheetService.open()` (Task 5).
- Produces: `<app-plan-notice [plan]="GroupPlan | null" />` renders nothing for `null`. Otherwise it renders exactly one line, in this order of precedence: paused, then lapsed, then expiring. Each line carries a "ต่ออายุ" button that opens the sheet.

Copy:

| id | th | en |
|---|---|---|
| `plan.notice.lapsed` | แพ็ก⁠เกจโฮสต์หมดเมื่อ {date} — รอบใหม่ใช้แบบฟรี | Host plan ended {date}; new rounds use the free plan |
| `plan.notice.expiring` | แพ็ก⁠เกจโฮสต์หมด {date} | Host plan ends {date} |
| `plan.notice.renew` | ต่ออายุ | Renew |
| `group.row.inactiveBadge` | ปิดในแพ็ก⁠เกจฟรี | Off on the free plan |

`{date}` is `bangkokDisplayDate`.

- [ ] **Step 1: Write failing tests**
  - `plan-notice.spec.ts`: lapsed shows the lapsed line; renewing in 3 days shows the expiring line; paused shows `plan.groupPaused`; a plan with 10 days left shows nothing; the button calls `open()`.
  - `group-home.spec.ts`:
    - On a paused group the start link is gone and the notice shows.
    - A locked row is a `<button>` (not `<a role="link" aria-disabled>`) that calls `open()` when tapped.
    - The archive note shows only when `archiveHidden > 0`.
    - On free, with shuttle tools stored ON, the advanced row badge reads `group.row.inactiveBadge` without the `.on` class.
  - `group-entry.spec.ts`: on a paused group the paste form is replaced by the notice. On a lapsed plan the notice shows above the form, and the form still works.
- [ ] **Step 2: Run** `cd web && npm test`. Expected: the new specs FAIL.
- [ ] **Step 3: Implement.**
  - Group home puts the notice directly under the title. `planLine` stays as is.
  - Roster entry loads `PlanService.forGroup` like group home does. A failed load shows no notice and blocks nothing (the existing fail-open rule).
- [ ] **Step 4: Run** `cd web && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(web): lapse notice and paused groups on group home and roster entry`

### Task 7: Web: advanced settings show a stored-but-inactive switch as off-looking

**Files:**
- Modify: `web/src/app/pages/group-settings-detail/group-settings-detail.{html,css,spec.ts}`

**Interfaces:**
- Consumes: the existing `onButInactiveLockHint()` and `isPaid`. Nothing new is exported.

- [ ] **Step 1: Write a failing test.** On free, with shuttle tools ON, the checkbox has class `inactive` and stays checked and enabled (it can still be turned off). The hint line reads `plan.lock.onInactive` and is followed by a single plan-lock, so the upgrade line appears once on the page and not once per switch.
- [ ] **Step 2: Run** `cd web && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** `.inactive` swaps the accent fill for `--ink-faint` on the check, in light and dark. Show one `<app-plan-lock>` under both switches instead of one per switch.
- [ ] **Step 4: Run** `cd web && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with message `fix(web): inactive paid switch no longer looks on`

### Task 8: Web: dashboard mode area and tonight's rules

**Files:**
- Modify: `web/src/app/pages/session-dashboard/session-dashboard.{ts,html,css,spec.ts}`
- Modify: `web/src/app/core/pair-rule.model.ts` (session rules response gains `rulesActive: boolean`)

**Interfaces:**
- Consumes: `rulesActive` (Task 3).

Copy:

| id | th | en |
|---|---|---|
| `dashboard.modeOneWay` | เปลี่ยนแล้วจะกลับมาใช้{mode}ไม่ได้ในแพ็ก⁠เกจนี้ | After switching you can't return to {mode} on this plan |
| `dashboard.rulesInactive` | กฎไม่ใช้ในรอบนี้ — รอบนี้เริ่มในแพ็ก⁠เกจฟรี | Rules are off this round: it started on the free plan |

`{mode}` is the label of the mode being switched away from (สูสี / ตามระดับ).

- [ ] **Step 1: Write failing tests**
  - DOM order under the toggle: `.mode-hint` comes directly after `.scope-toggle`, then `app-plan-lock`, then `[data-mode-confirm]`.
  - Starting from `balanced`, requesting `variety` shows confirm text containing "สูสี".
  - With `rulesActive: false`, the rules disclosure shows `dashboard.rulesInactive` and its per-rule switches are disabled.
- [ ] **Step 2: Run** `cd web && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Reorder the template. Mode lock and hint use `text-align: start` and the same muted size as `.mode-hint`. No other layout change.
- [ ] **Step 4: Run** `cd web && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with message `fix(web): mode lock below its hint; name the mode; show inactive rules`

### Task 9: Web: bill, one lock per group of extras

**Files:**
- Modify: `web/src/app/shared/bill-settings/bill-settings.{html,css}`, `web/src/app/pages/session-bill/session-bill.{html,spec.ts}`

- [ ] **Step 1: Write a failing test.** On free, the bill renders exactly one `app-plan-lock` for host fee and walk-in fee together, and one for the ไม่มา chips. The fields stay disabled.
- [ ] **Step 2: Run** `cd web && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Move the lock below the last extra field of each group.
- [ ] **Step 4: Run** `cd web && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with message `fix(web): one plan lock per bill group`

### Task 10: Web: landing and group creation show the cap up front

**Files:**
- Modify: `web/src/app/pages/landing/landing.{ts,html,css,spec.ts}`
- Modify: `web/src/app/pages/group-create/group-create.{ts,html,css,spec.ts}`

**Interfaces:**
- Consumes: `PlanService.mine()`, `UpgradeSheetService.open()` (Task 5), and `listGroups` rows with `paused` (Task 2).

Copy:

| id | th | en |
|---|---|---|
| `landing.groupCount` | ก๊วน {n}/{limit} | Groups {n}/{limit} |
| `landing.paused` | พักไว้ | Paused |

- [ ] **Step 1: Write failing tests**
  - Landing with `groupCount: 2, groupLimit: 1`: the create control is a button showing `landing.groupCount` plus a plan-lock with `plan.groupLimit`, and tapping it opens the sheet instead of navigating. At `groupCount: 0, groupLimit: 1` the create link works as today. When `mine()` fails, it behaves as today (fail open).
  - A paused row shows the `landing.paused` badge and no "เริ่มรอบ" link.
  - `group-create` opened directly at the cap shows the plan-lock instead of the form. A late `GROUP_LIMIT` refusal renders in the `.notice` class, not `.error`.
- [ ] **Step 2: Run** `cd web && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd web && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(web): show the group cap before the host types a name`

### Task 11: Web: minor fixes (levels link, disabled look, levels copy, profile copy)

**Files:**
- Modify: `web/src/app/pages/player-roster/player-roster.{html,spec.ts}`
- Modify: `web/src/styles.css`
- Modify: `web/src/app/pages/group-levels/group-levels.{html,spec.ts}`
- Modify: `web/src/app/pages/player-profile/player-profile.html`, locale files

- [ ] **Step 1: Write failing tests**
  - The players page hides the "ตั้งชื่อระดับของก๊วน →" link when `!paid()` and `ladder()?.mode === 'standard'`, and keeps it on free with a custom ladder (so it can still be cleaned up).
  - The levels page on free hides the Elo intro paragraph and the seed numbers (but keeps level names and counts); on paid both show.
- [ ] **Step 2: Run** `cd web && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - In `styles.css`: `select:disabled, button.chip:disabled { opacity: .55; cursor: not-allowed; }`, checked in light and dark so a disabled control reads as disabled.
  - Change the source of `profile.planLockedHint` to "ยังไม่เปิดหน้าสถิติของก๊วนนี้", with English "Stats aren't available for this group".
- [ ] **Step 4: Run** `cd web && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with message `fix(web): plan gating minor fixes`

### Task 12: Web: admin plan editing

**Files:**
- Modify: `web/src/app/pages/admin/admin.{ts,html,css,spec.ts}`, `web/src/app/core/admin.service.ts` (row type gains `groupLimit`)

**Interfaces:**
- Consumes: `groupLimit` (Task 4).
- Produces: `addMonth(ymd: string, today: string): string` in `admin.ts`. It takes the later of `ymd` and `today`, adds one calendar month, and clamps to the last day of that month (31/01 becomes 28/02 or 29/02). It returns `YYYY-MM-DD`.

Copy:

| id | th | en |
|---|---|---|
| `admin.planAddMonth` | +1 เดือน | +1 month |
| `admin.planEnded` | หมดเมื่อ {date} — ใช้แบบฟรีอยู่ | Ended {date}, on free |
| `admin.overCap` | เกินโควตา {n}/{limit} | Over cap {n}/{limit} |

- [ ] **Step 1: Write failing tests**
  - `addMonth('2026-10-10', '2026-10-26')` returns `'2026-11-26'`. `addMonth('2026-11-30', '2026-10-26')` returns `'2026-12-30'`. `addMonth('2027-01-31', '2026-10-26')` returns `'2027-02-28'`. `addMonth('', '2026-10-26')` returns `'2026-11-26'`.
  - The edit row has one save button. Saving with a changed plan calls both the user update and `setPlan`; saving with an unchanged plan calls only the user update. `บันทึกแพ็กเกจ` is gone.
  - A free user owning 2 groups shows `admin.overCap`.
  - A free user with a renewal date shows no "ถึง" text.
  - A lapsed user shows `admin.planEnded` with the date.
- [ ] **Step 2: Run** `cd web && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** The `+1 เดือน` button sits next to the date input and writes into `renewDraft`.
- [ ] **Step 4: Run** `cd web && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(web): admin renews by a month and saves once`

### Task 13: Docs and full verification

**Files:**
- Modify: `docs/overview.md` ("Plans" section)
- Modify: `docs/2026-10-06-pricing-tiers.md` ("Rules that must hold")
- Move: this plan to `docs/archive/plans/` once every box is checked

- [ ] **Step 1: Update `docs/overview.md` → Plans.**
  - Add "Paused groups" with the ranking rule and `GROUP_PAUSED`.
  - Add "Rules stop in sessions created on free".
  - Add `GET /plans/me`, `UPGRADE_CONTACT_URL`, the lapse and expiring notice (group home and roster entry only, and why not the dashboard), and `archiveHidden`.
  - Keep "deleting a rule" in the never-gated list (deleting stays free). Reword "Gating only ever blocks turning a paid thing on" to name the two lapse exceptions: paused groups and inactive rules.
  - Rewrite "What a free host sees (web)" to describe the upgrade sheet and the one-line locks.
- [ ] **Step 2: Update the pricing doc.** Add the two lapse rules under "Rules that must hold", and note that the `/d/` link stays live.
- [ ] **Step 3: Run** `npm test` from the repo root. Expected: engines, server and web all pass. Then `cd server && npm run lint`. Expected: clean.
- [ ] **Step 4: Browser walk** on an isolated scratch DB and own ports (memory `reference-e2e-browser-setup`), at 390px:
  - Free user with 2 groups: landing cap, paused badge, the paused group's home, the sheet with and without `UPGRADE_CONTACT_URL`.
  - Lapsed host: group home notice, roster entry notice, a new session's rules shown as inactive.
  - Host renewing in 2 days: expiring notice.
  - Dashboard mode area at 390px with no Thai mid-word break.
  - Admin: +1 month, single save, over-cap flag.
- [ ] **Step 5: Archive this plan** to `docs/archive/plans/`, then commit with message `docs: plan gating follow-ups`

## Out of scope

- Payment integration and price display.
- Revoking an issued `/d/` token on lapse (decided: it stays live).
- Reverting a custom level ladder on lapse. `PUT /levels` is still gated whole; a free host's ladder only affects paid modes, which they cannot use.
- Pre-existing issues seen during the critique but not caused by gating: English parser warnings on the Thai roster screen, stale wait times on old sessions, and the cramped admin table at phone width.
