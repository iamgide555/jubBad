# LINE Group "Roster Only" Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** A per-group checkbox that stops the bot pushing summary/payment cards into the linked LINE group, routing them to the host's DM when that is set up, and nowhere otherwise.

**Architecture:** One new `Group.lineGroupRosterOnly` column. The only routing change is in `LineSummaryService.resolve()`; every card path (summary send, payment `send`/`sendToHost`, both LIFF share endpoints, end dialog, summary page) already derives its target from it. Settings: one more field on the existing `GET`/`PATCH /groups/:code/line`, one checkbox on the LINE group card, and the DM panel's `summaryAvailable` widened.

**Tech Stack:** NestJS + Prisma + SQLite (vitest, supertest), Angular standalone + signals (ng test / vitest), XLIFF i18n edited by hand.

**Spec:** `docs/superpowers/specs/2026-11-04-line-group-card-switch-design.md`

## Global Constraints

- Branch `feat/line-roster-only`; main stays deployable.
- `lineGroupRosterOnly` default `false`: every existing group must behave byte-identically.
- Label exactly `ใช้บอทอ่านรายชื่ออย่างเดียว`; hint exactly `บอทจะไม่ส่งสรุปผลการแข่งหรือการจ่ายเงินเข้ากลุ่ม ถ้าเปิดแชตส่วนตัวไว้ บอทจะส่งให้คุณแทน แล้วกดส่งเข้ากลุ่มเองได้`.
- No host-facing text may mention the bot's quota or saving it.
- Roster-only on + DM not ready → no card at all (no fallback, no error).
- Roster reading, `/link` and bot replies unchanged.
- Server tests run serially (`fileParallelism: false`); don't change that.

## Review Focus

1. Summary already pushed to the group, then roster-only switched on → no second (DM) card that night. Test in Task 1.
2. Unlink and re-link the LINE group → roster-only keeps its value. Test in Task 2.
3. Roster-only on, owner later unlinks their LINE account → target `none`; payment panel offers no send. Test in Task 1.
4. Host flips roster-only on the settings page → the DM panel's summary switch appears without a reload. Test in Task 3.
5. Free/lapsed plan tries to set roster-only → 403, nothing saved. Test in Task 2.

---

### Task 1: Column + routing rule

**Files:**
- Modify: `server/prisma/schema.prisma` (Group, after `lineDmEnabled`)
- Create: `server/prisma/migrations/<timestamp>_line_group_roster_only/migration.sql` (via `prisma migrate dev`)
- Modify: `server/src/line/line-summary.service.ts` (`resolve()`, and the doc comment above it)
- Test: `server/src/line/line-summary.spec.ts`, `server/src/sessions/payment-card.spec.ts`

**Interfaces:**
- Produces: `Group.lineGroupRosterOnly: boolean` (Prisma), used by Tasks 2–3.

- [x] **Step 1: Write the failing tests** in `line-summary.spec.ts`. Add `rosterOnly?: boolean` (default `false`) to `setup()` options, written to `lineGroupRosterOnly`. In the `the host target` describe:

```ts
it('is the target for a group linked to a LINE group when roster-only is on and the DM is ready', async () => {
  const owner = await makeOwner('host');
  const { sessionCode } = await setup({ ownerId: owner.id, linked: true, dm: true, rosterOnly: true });
  expect(await summary.state(sessionCode)).toMatchObject({
    available: true, target: 'host', shareUrl: `https://liff.line.me/2001234567-AbCdEfGh/${sessionCode}`,
  });
});

it('has no target and pushes nothing when roster-only is on and the DM is not set up', async () => {
  const { sessionCode } = await setup({ linked: true, dm: false, rosterOnly: true });
  expect(await summary.state(sessionCode)).toMatchObject({ available: false, target: null });
  expect(await summary.send(sessionCode)).toBe('unavailable');
  expect(fakeClient.push).not.toHaveBeenCalled();   // use this file's push mock name
});

it('has no target when roster-only is on and the owner has no linked LINE account', async () => {
  const owner = await makeOwner('host', null);
  const { sessionCode } = await setup({ ownerId: owner.id, linked: true, dm: true, rosterOnly: true });
  expect(await summary.state(sessionCode)).toMatchObject({ available: false, target: null });
});

it('stays sent when roster-only is switched on after the card went to the group', async () => {
  const owner = await makeOwner('host');
  const { groupCode, sessionCode } = await setup({ ownerId: owner.id, linked: true, dm: true });
  expect(await summary.send(sessionCode)).toBe('sent');
  await prisma.group.update({ where: { code: groupCode }, data: { lineGroupRosterOnly: true } });
  expect(await summary.send(sessionCode)).toBe('already-sent');
  expect(fakeClient.push).toHaveBeenCalledTimes(1);
});
```

Keep the existing `'is not the target when the group is linked to a LINE group, even with the DM switch on'` test (it now pins roster-only **off**); rename it to `... with the DM switch on and roster-only off`.

In `payment-card.spec.ts`, add `rosterOnly?: boolean` to `setup()` (writes `lineGroupRosterOnly`) and allow `target: 'host'` with a group link via a new option `alsoLinked?: boolean` (sets `lineGroupId` even for `host`). Tests in `sendToHost`:

```ts
it('DMs the host for a group linked to a LINE group when roster-only is on', async () => {
  const { code } = await setup({ target: 'host', alsoLinked: true, rosterOnly: true });
  const panel = (await confirm(code).expect(200)).body as PaymentPanel;
  expect(panel.target).toBe('host');
  expect((await dm(code).expect(200)).body).toEqual({ outcome: 'sent' });
  expect((await send(code).expect(200)).body).toEqual({ outcome: 'unavailable' });
});
```

- [x] **Step 2: Run to verify they fail**

Run (from `server/`): `npx vitest run src/line/line-summary.spec.ts src/sessions/payment-card.spec.ts`
Expected: FAIL — Prisma rejects unknown field `lineGroupRosterOnly`.

- [x] **Step 3: Add the column.** In `schema.prisma` Group, after `lineDmEnabled`:

```prisma
  /// When true the bot only reads rosters in the linked LINE group and never pushes a card into it;
  /// cards go to the host DM if that route is ready, else nowhere.
  /// docs/superpowers/specs/2026-11-04-line-group-card-switch-design.md
  lineGroupRosterOnly Boolean @default(false)
```

Run (from `server/`): `npx prisma migrate dev --name line_group_roster_only`
Expected: one new migration folder; `prisma generate` runs.

- [x] **Step 4: Change `resolve()`** — group branch condition becomes `group.lineGroupId !== null && !group.lineGroupRosterOnly`; the `else if` host branch and `else return null` stay as they are. Update the doc comment ("A group linked to a LINE group posts there, whether or not its host DM switch is on") to state the new rule.

- [x] **Step 5: Run to verify they pass**

Run: `npx vitest run src/line/line-summary.spec.ts src/sessions/payment-card.spec.ts`
Expected: PASS, including all pre-existing tests.

- [x] **Step 6: Commit**

```bash
git add server/prisma server/src/line/line-summary.service.ts server/src/line/line-summary.spec.ts server/src/sessions/payment-card.spec.ts
git commit -m "feat(line): roster-only groups send cards to the host DM, not the group"
```

---

### Task 2: Status + PATCH for roster-only; DM panel availability

**Files:**
- Modify: `server/src/line/line-link.service.ts` (`LineStatus`, `status()`, new `setRosterOnly()`)
- Rename/modify: `server/src/line/set-summary-default.dto.ts` → `update-line-settings.dto.ts`
- Modify: `server/src/line/line.controller.ts` (PATCH handler)
- Modify: `server/src/line/line-host.service.ts` (`ownerOf()` selects `lineGroupRosterOnly`; `summaryAvailable`)
- Test: `server/src/line/line-link.spec.ts`, `server/src/line/line-host.spec.ts`

**Interfaces:**
- Consumes: `Group.lineGroupRosterOnly` (Task 1).
- Produces:
  - `LineStatus.rosterOnly: boolean` (GET `/groups/:code/line`).
  - `LineLinkService.setRosterOnly(groupCode: string, on: boolean): Promise<boolean>`.
  - `PATCH /groups/:code/line` body `{ summaryDefault?: boolean; rosterOnly?: boolean }` (at least one; else 400), answers `{ summaryDefault: boolean; rosterOnly: boolean }` read back after the writes.
  - `LineHostStatus.summaryAvailable` = `publicAppUrl !== null && liffId !== null && (!botLinked || rosterOnly)`.

- [x] **Step 1: Write the failing tests.** In `line-link.spec.ts`:
  - `status` → the existing `toEqual` for an unlinked group gains `rosterOnly: false`.
  - New `describe('roster only')`:

```ts
it('is saved for a linked group on a paid plan and shown in the status', async () => {
  const code = await makeGroup(hostId, { lineGroupId: lineId() });
  expect(await link.setRosterOnly(code, true)).toBe(true);
  expect((await link.status(code)).rosterOnly).toBe(true);
});
it('is refused on a free plan with the plan error, and nothing is saved', async () => {
  const code = await makeGroup(freeId, { lineGroupId: lineId() });
  await expect(link.setRosterOnly(code, true)).rejects.toMatchObject({ status: 403 });
  expect((await prisma.group.findUniqueOrThrow({ where: { code } })).lineGroupRosterOnly).toBe(false);
});
it('is refused when the group is not linked to a LINE group, even with the host DM on', async () => {
  const code = await makeGroup(hostId, { lineDmEnabled: true });
  await expect(link.setRosterOnly(code, true)).rejects.toMatchObject({ response: { code: 'LINE_NOT_LINKED' } });
});
it('survives an unlink and a re-link', async () => {
  const code = await makeGroup(hostId);
  await link.redeem(lineId(), (await link.createCode(code)).code);
  await link.setRosterOnly(code, true);
  await link.unlink(code);
  await link.redeem(lineId(), (await link.createCode(code)).code);
  expect((await link.status(code)).rosterOnly).toBe(true);
});
```

  - `owner routes`: PATCH `{ rosterOnly: true }` → 200 `{ summaryDefault: true, rosterOnly: true }`; PATCH `{}` → 400; PATCH `{ rosterOnly: 'yes' }` → 400. The existing `{ summaryDefault: false }` PATCH test keeps passing (assert with `toMatchObject`).

  In `line-host.spec.ts`, next to `'hides the host switch for a bot-linked group even with both settings present'`:

```ts
it('offers the host switch for a bot-linked group once roster-only is on', async () => {
  process.env.PUBLIC_APP_URL = 'https://jubbad.test';
  process.env.LINE_LIFF_ID = '1234567890-AbCdEfGh';
  const { code } = await makeOwner();
  await prisma.group.update({ where: { code }, data: { lineGroupId: `C${randomUUID().replace(/-/g, '')}`, lineGroupRosterOnly: true } });
  expect((await host.status(code)).summaryAvailable).toBe(true);
});
```

- [x] **Step 2: Run to verify they fail**

Run: `npx vitest run src/line/line-link.spec.ts src/line/line-host.spec.ts`
Expected: FAIL — `setRosterOnly` is not a function; `rosterOnly` missing from status.

- [x] **Step 3: Implement.**
  - `status()`: `rosterOnly: group?.lineGroupRosterOnly ?? false`.
  - `setRosterOnly`: `plans.requireGroupPlan(groupCode, 'host')` first, then `NotFoundException` if no group, `ConflictException({ code: 'LINE_NOT_LINKED' })` if `lineGroupId === null`, then update. Same shape as `setSummaryDefault`, without its DM branch.
  - DTO `UpdateLineSettingsDto`: both fields `@IsOptional() @IsBoolean()`. Delete the old DTO file and fix its imports.
  - Controller PATCH: `BadRequestException` when both fields are `undefined`; call `setSummaryDefault` / `setRosterOnly` for whichever are present; answer from `link.status(code)` (`{ summaryDefault, rosterOnly }`).
  - `line-host.service.ts`: `ownerOf()` also selects and returns `rosterOnly`; `summaryAvailable` per the Interfaces line above.

- [x] **Step 4: Run to verify they pass**

Run: `npx vitest run src/line/` then `npm run lint`
Expected: PASS; lint clean.

- [x] **Step 5: Commit**

```bash
git add server/src/line
git commit -m "feat(line): roster-only setting on the group LINE status and PATCH"
```

---

### Task 3: Settings UI

**Files:**
- Modify: `web/src/app/core/line.model.ts` (`LineStatus.rosterOnly: boolean`)
- Modify: `web/src/app/core/line.service.ts` (new `setRosterOnly`)
- Modify: `web/src/app/pages/group-settings-detail/group-settings-detail.{html,ts}`
- Modify: `web/src/app/pages/group-settings-detail/line-host-link-panel.ts` (`load()` becomes public)
- Modify: `web/src/locale/messages.xlf`, `web/src/locale/messages.en.xlf`
- Test: `web/src/app/core/line.service.spec.ts`, `web/src/app/pages/group-settings-detail/group-settings-detail.spec.ts`

**Interfaces:**
- Consumes: GET `rosterOnly`, PATCH `{ rosterOnly }` → `{ summaryDefault, rosterOnly }` (Task 2).
- Produces: `LineService.setRosterOnly(groupCode: string, on: boolean): Observable<{ summaryDefault: boolean; rosterOnly: boolean }>`; `GroupSettingsDetail.setRosterOnly(input: HTMLInputElement): void`; `LineHostLinkPanel.load(): void` (public).

- [x] **Step 1: Write the failing tests.** `line.service.spec.ts`: `setRosterOnly('g1', true)` PATCHes `${B}/groups/g1/line` with body `{ rosterOnly: true }`. In `group-settings-detail.spec.ts` add `rosterOnly: false` to `STATUS`, and a `describe('roster-only checkbox')` using `openLine`, with `box = () => q('[data-roster-only]') as HTMLInputElement | null`:
  - unticked by default; label text contains `ใช้บอทอ่านรายชื่ออย่างเดียว`; hint contains `บอทจะไม่ส่งสรุปผลการแข่งหรือการจ่ายเงินเข้ากลุ่ม`.
  - click → PATCH body `{ rosterOnly: true }`; flush `{ summaryDefault: true, rosterOnly: true }` → box checked, `q('[data-summary-default]')` is null, and a new `GET ${B}/groups/group1/line/host` is issued (the DM panel reloads — Review Focus 4).
  - `openLine({ ...LINKED, rosterOnly: true })` → box checked, `[data-summary-default]` absent.
  - PATCH fails (500) → box snaps back to unchecked, `[data-error]` shown.
  - absent when unlinked, and when `openLine(LINKED, 'free')`.
  - no element on the LINE page contains `โควตา`.

- [x] **Step 2: Run to verify they fail**

Run (from `web/`): `npx ng test --watch=false`
Expected: FAIL — `[data-roster-only]` not found; `setRosterOnly` not a function.

- [x] **Step 3: Implement.**
  - Template, linked + paid branch, before the summary-default `@if`: a `label.switch-row` like the summary one, `input type="checkbox" name="lineGroupRosterOnly" data-roster-only [checked]="line.rosterOnly" (change)="setRosterOnly($any($event.target))"`, title `i18n="@@line.rosterOnly"`, hint `i18n="@@line.rosterOnlyHint"` with the Global Constraints copy. Shown regardless of `summaryAvailable` (it also governs the payment card). Summary-default `@if` becomes `line.summaryAvailable && !line.rosterOnly`.
  - `setRosterOnly`: same optimistic snap-back pattern as `setSummaryDefault` (error copy reuses `@@line.summaryDefaultFailed`); on success set `lineStatus` from the answer and call `hostPanel()?.load()` where `hostPanel = viewChild(LineHostLinkPanel)`.
  - XLIFF: add `line.rosterOnly` and `line.rosterOnlyHint` to both files. English targets: `Bot only reads rosters` / `The bot won't post the match summary or payments to the group. If the private chat is on, the bot sends them to you instead, and you can share them to the group yourself.`

- [x] **Step 4: Run to verify they pass**

Run (from `web/`): `npx ng test --watch=false` then `npm run build`
Expected: PASS; build has no missing-translation warnings for the new ids.

- [x] **Step 5: Commit**

```bash
git add web/src
git commit -m "feat(web): roster-only checkbox on the LINE group settings card"
```

---

### Task 4: Docs and full suite

**Files:**
- Modify: `docs/overview.md` (host share card section, ~line 1444)

- [ ] **Step 1:** Replace "**Group wins when both apply**: one card, one place." with the new rule: group target only when linked and `lineGroupRosterOnly` is off; roster-only on → host target if ready, else none; owner decision 2026-11-04; link the spec. Add one line that any future bot post into the group must respect `lineGroupRosterOnly`.

- [ ] **Step 2: Run everything**

Run (repo root): `npm test`
Expected: engines, server, web all PASS.

- [ ] **Step 3: Commit**

```bash
git add docs/overview.md
git commit -m "docs: roster-only LINE groups route cards to the host DM"
```

Deploy and the real-LINE check (spec "Done when") are owner-run after merge: the new migration must be applied on the server before the rebuild.
