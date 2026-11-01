# LINE Accounts and Per-Player Link/Unlink Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-group directory of LINE accounts JubBad has seen (name + avatar), and link/unlink of those accounts to players from จัดการผู้เล่น.

**Architecture:** A global `LineAccount` row per LINE user id, a `LineAccountGroup` join row per group it was seen in, and the existing `PlayerLineAccount` link now foreign-keyed to `LineAccount`. One server service (`LineAccountsService`, in `LineModule`) owns every write; the roster capture, the slip flow and the new group routes all call it. The web roster page shows each player's account and a sub-route lists every account in the group.

**Tech Stack:** NestJS + Prisma 7 (better-sqlite3 adapter) + SQLite, vitest; Angular standalone components with signals, Angular i18n (Thai source, English xlf).

**Spec:** `docs/superpowers/specs/2026-11-01-line-accounts-design.md`

## Global Constraints

- Work on branch `feat/line-accounts`; `main` runs real weekly sessions and must stay deployable.
- Never show across groups: every account query filters through `LineAccountGroup.groupId`; no response carries data or counts from another group.
- Raw LINE user ids and avatars never appear in an `@Public` response; the browser addresses an account by `LineAccount.id`, never `lineUserId`.
- Never auto-link. A link is created only by a host tap or the player's own pay-page claim.
- Unlink deletes only the `PlayerLineAccount` row; the account stays listed in the group.
- One account per player per group and one player per account per group (existing uniques kept).
- `touch` never blanks a stored `displayName` or `pictureUrl`.
- View / link / unlink are not plan-gated; capture keeps today's paid-plan gate.
- Retention: a linked account is never swept; an unlinked `LineAccountGroup` with `lastSeenAt` older than 365 days is deleted; a `LineAccount` with no `LineAccountGroup` and no `PlayerLineAccount` is deleted.
- Owner mismatch on a group route is 404 (existing `OwnershipGuard`), never 403.
- UI: Thai source strings with `i18n="@@..."` ids, English targets in `web/src/locale/messages.en.xlf`; 44px tap targets; avatars use `referrerpolicy="no-referrer"` with an initial-letter fallback.
- Server tests run with `fileParallelism: false`; do not change that.

## Plan-level decisions (deviations from the spec's letter, same intent)

- `PlayerLineAccount` keeps its `lineUserId` column and gains a relation `lineAccount` that references `LineAccount.lineUserId` (a unique field), instead of a new `lineAccountId` column. Same guarantee (the link points at a `LineAccount`, FK-enforced) with the existing `groupId_lineUserId` unique key and ~30 call sites untouched. `PlayerLineAccount.displayName` is dropped; the name comes from `LineAccount`.
- Disconnecting the LINE group (`LineLinkService.unlink` / `markLeft`) already wipes that group's links and slips; it now also deletes that group's `LineAccountGroup` rows. Recorded in the spec in Task 1.
- The account list is a sub-route `g/:groupCode/players/line`, so the phone back button closes it.

## Review Focus

1. Two webhook deliveries for the same new sender arriving at once → one `LineAccount`, one membership, no 500 (unique-violation retry in `touch`). Test in Task 1.
2. A roster post whose profile lookup fails after a slip already stored a name and avatar → name and avatar unchanged. Test in Task 1 (`touch` with nulls) and Task 2 (capture with `memberProfile` → null).
3. A host links an account that a player claimed a moment earlier in a different session → 409 `ACCOUNT_ALREADY_LINKED`, nothing changed. Test in Task 4.
4. An owner of groups A and B: an account seen only in A, requested through B's routes by its id → 404, and B's list omits it. Test in Task 4.
5. Player deleted while linked → link row gone (existing `Player` cascade), account still listed as unlinked. Test in Task 4.

---

### Task 1: Data model, migration, `LineAccountsService`, existing link writers

**Files:**
- Modify: `server/prisma/schema.prisma` (add `LineAccount`, `LineAccountGroup`; relation on `PlayerLineAccount`; back-relations on `Group`)
- Create: `server/prisma/migrations/20261101000000_line_accounts/migration.sql`
- Create: `server/src/line/line-accounts.service.ts`
- Modify: `server/src/line/line.module.ts` (provide + export `LineAccountsService`)
- Modify: `server/src/sessions/slips/slip-payments.service.ts` (`claimPlayer` ~L314, `listLinks` ~L351, `setLink` ~L362, `linkWrites` ~L679)
- Modify: `server/src/line/line-link.service.ts` (`unlink` ~L142, `markLeft` ~L164)
- Modify: specs that create `PlayerLineAccount` directly: `line-link.spec.ts`, `slip-pay-view.spec.ts`, `slip-pay.controller.spec.ts`, `slip-payments.links.spec.ts`, `slip-payments.resolve.spec.ts`, `slip-payments.submit.spec.ts`, `slip-schema.spec.ts`, `server/test/slip-http.fixture.ts`
- Test: `server/src/line/line-accounts.service.spec.ts`, `server/src/line/line-accounts-migration.spec.ts`
- Docs: `docs/overview.md`, `CLAUDE.md` (data-model line), the spec

**Interfaces:**
- Produces:
  ```ts
  export type LineAccountSource = 'roster' | 'slip' | 'claim' | 'host';
  export interface LineProfile { lineUserId: string; displayName: string | null; pictureUrl: string | null }
  class LineAccountsService {
    /** Upserts LineAccount + LineAccountGroup(lastSeenAt = now). Returns LineAccount.id. */
    touch(groupId: string, profile: LineProfile, source: LineAccountSource, now?: Date): Promise<string>;
  }
  ```
  Schema:
  ```prisma
  model LineAccount {
    id          String    @id @default(cuid())
    lineUserId  String    @unique
    displayName String?
    pictureUrl  String?
    profileAt   DateTime?
    createdAt   DateTime  @default(now())
    updatedAt   DateTime  @updatedAt
    groups      LineAccountGroup[]
    links       PlayerLineAccount[]
  }
  model LineAccountGroup {
    id            String      @id @default(cuid())
    groupId       String
    group         Group       @relation(fields: [groupId], references: [code], onDelete: Cascade)
    lineAccountId String
    lineAccount   LineAccount @relation(fields: [lineAccountId], references: [id], onDelete: Cascade)
    /// 'roster' | 'slip' | 'claim' | 'host': the first source that created the row.
    source        String
    firstSeenAt   DateTime    @default(now())
    lastSeenAt    DateTime    @default(now())
    @@unique([groupId, lineAccountId])
    @@index([lastSeenAt])
  }
  // PlayerLineAccount: drop displayName; add
  //   lineAccount LineAccount @relation(fields: [lineUserId], references: [lineUserId], onDelete: Cascade)
  ```

- [ ] **Step 1: Branch.** `git switch -c feat/line-accounts`.

- [ ] **Step 2: Write the failing migration test** `server/src/line/line-accounts-migration.spec.ts`, modelled on `server/src/groups/level-ladder-migration.spec.ts` (apply every migration before `*_line_accounts` to a temp DB, insert legacy rows, apply `*_line_accounts`). Fixture: group `g1` with players `p1`, `p2`; group `g2`; `PlayerLineAccount(g1, p1, 'U1', displayName 'Old', linkedBy 'self')`; `PendingSlip(g1, 'U1', displayName 'Slip', pictureUrl 'https://x/1')` and `PendingSlip(g1, 'U2', displayName 'Two', pictureUrl null)`; `LineRosterMessage(g2, senderUserId 'U1', senderName 'Roster', direct 0)`; `LineRosterMessage(g1, senderUserId 'U9', direct 1)`. Assertions:
  - `LineAccount` has exactly `U1`, `U2` (U9 is DM-only, excluded); `U1` has `displayName 'Slip'`, `pictureUrl 'https://x/1'` (a pending slip's profile wins, then the link's name, then the roster sender name).
  - `LineAccountGroup` rows: `(g1,U1)` with `source 'claim'` (earliest row's source; a link maps `self`→`claim`, `host`→`host`), `(g1,U2,'slip')`, `(g2,U1,'roster')`; `firstSeenAt` = min and `lastSeenAt` = max of the source rows' timestamps (`createdAt`, or `postedAt` for roster messages).
  - `PlayerLineAccount(g1,p1,'U1')` still exists with `linkedBy 'self'`; `PRAGMA foreign_key_check` returns no rows.

- [ ] **Step 3: Run it.** `cd server && npx vitest run src/line/line-accounts-migration.spec.ts` → FAIL (no `*_line_accounts` dir).

- [ ] **Step 4: Schema + migration.** Edit `schema.prisma` per Interfaces. Generate with `npx prisma migrate dev --create-only --name line_accounts`, rename the dir to `20261101000000_line_accounts`. Hand-edit the SQL so the backfill `INSERT`s into `LineAccount` and `LineAccountGroup` run after those tables are created and before Prisma's `INSERT INTO "new_PlayerLineAccount"`. Ids in SQL: `lower(hex(randomblob(12)))`. Sources and precedence exactly as the test pins; roster rows only where `direct = 0 AND senderUserId IS NOT NULL`.

- [ ] **Step 5: Run the migration test** → PASS. Then `npx prisma migrate dev` to apply to the dev DB and regenerate the client.

- [ ] **Step 6: Write failing service tests** `server/src/line/line-accounts.service.spec.ts`:
  - `touch creates the account and the group membership with the given source`
  - `touch again updates lastSeenAt, keeps firstSeenAt and the first source`
  - `touch with null name/picture never blanks stored values` (store 'A'/'https://a', touch with nulls → still 'A'/'https://a'; `profileAt` unchanged)
  - `touch with a new name updates it and profileAt`
  - `the same LINE user in two groups is one LineAccount with two memberships`
  - `concurrent touches for a new user produce one account and one membership` (`Promise.all` of two `touch` calls)

- [ ] **Step 7: Implement `touch`** in `line-accounts.service.ts`: `upsert` `LineAccount` by `lineUserId` (update only the non-null profile fields, and `profileAt = now` when any was given), then `upsert` `LineAccountGroup` by `groupId_lineAccountId` (create sets `source`, `firstSeenAt`, `lastSeenAt`; update sets only `lastSeenAt`). On a Prisma unique violation (`P2002`) retry the whole touch once. Register in `LineModule` providers and exports.

- [ ] **Step 8: Run service tests** → PASS.

- [ ] **Step 9: Route existing link writers through it.** In `slip-payments.service.ts`: `claimPlayer` calls `touch(groupId, user, 'claim')` before creating the link; `setLink` (non-null) and `linkWrites` call `touch(groupId, {lineUserId, displayName, pictureUrl}, 'host')` before building writes (use the slip's `displayName`/`pictureUrl` in `linkWrites`, nulls in `setLink`); drop `displayName` from every `playerLineAccount.create`. `listLinks` returns `displayName` from `include: { lineAccount: true }`. `SlipPaymentsService` gets `LineAccountsService` injected (SessionsModule already imports `LineModule`). In `line-link.service.ts` `unlink` and `markLeft`, add `this.prisma.lineAccountGroup.deleteMany({ where: { groupId } })` to the existing transaction, after the `playerLineAccount` delete.

- [ ] **Step 10: Fix specs** that create `PlayerLineAccount` directly: create the `LineAccount` first (or call `touch`), and drop `displayName` from the link data. Add to `line-link.spec.ts`: `unlink removes the group's LINE account memberships` and the same for `markLeft`.

- [ ] **Step 11: Run the server suite.** `cd server && npm test && npm run lint` → all PASS, lint clean.

- [ ] **Step 12: Docs.** `docs/overview.md`: a short section on why accounts are global but listed per group, why a join table and not an array, why never auto-link by name, and that disconnecting the LINE group drops the memberships. `CLAUDE.md`: add `LineAccount`, `LineAccountGroup`, `PlayerLineAccount` to the data-model list. In the spec, replace "`lineAccountId` … replaces the raw `lineUserId`" with the relation-by-`lineUserId` decision above, and add the LINE-disconnect rule.

- [ ] **Step 13: Commit.** `feat(line): LineAccount directory with per-group membership`

---

### Task 2: Capture from roster posts (with avatar) and slip uploads

**Files:**
- Modify: `server/src/line/line-client.ts` (~L85 `memberName`)
- Modify: `server/src/line/line-roster.service.ts` (`capture` ~L40)
- Modify: `server/src/sessions/slips/slip-payments.service.ts` (`pendingSlip.create` ~L601)
- Test: `server/src/line/line-client.spec.ts`, `server/src/line/line-roster.spec.ts`, `server/src/sessions/slips/slip-payments.submit.spec.ts`

**Interfaces:**
- Consumes: `LineAccountsService.touch` (Task 1).
- Produces: `LineClient.memberProfile(lineGroupId: string, userId: string): Promise<{ displayName: string; pictureUrl: string | null } | null>`, same 24 h cache and "failed lookup not cached" rule as `memberName`. `memberName` becomes a thin wrapper returning `memberProfile(...)?.displayName ?? null`.

- [ ] **Step 1: Failing tests.**
  - `line-client.spec.ts`: `memberProfile returns displayName and pictureUrl`; `memberProfile returns pictureUrl null when LINE omits it`; `memberProfile caches and memberName reuses the cache` (one HTTP call for both).
  - `line-roster.spec.ts`: `capturing a roster records the sender in the group's LINE accounts with name and avatar` (source `'roster'`); `a failed profile lookup still records the account and keeps a stored name`; `an ignored (non-roster) message records no account`; `an unpaid group records no account`.
  - `slip-payments.submit.spec.ts`: `a held slip records the sender as a 'slip' account with the LIFF name and picture`; `an auto-paid slip records the sender too`.
- [ ] **Step 2: Run** `npx vitest run src/line/line-client.spec.ts src/line/line-roster.spec.ts src/sessions/slips/slip-payments.submit.spec.ts` → new tests FAIL.
- [ ] **Step 3: Implement.** `memberProfile` as above. `capture`: after the message row is stored (not on the P2002-ignored path), when `senderUserId` is present, `touch(groupCode, { lineUserId, ...profileOrNulls }, 'roster', input.postedAt)`. Slip submit: `touch(groupId, user, 'slip')` once per accepted submit, before the paid/held branch, so both outcomes record the sender. `LineRosterService` gets `LineAccountsService` injected.
- [ ] **Step 4: Run** the same command → PASS; then `npm test`.
- [ ] **Step 5: Commit.** `feat(line): record roster senders and slip senders as group LINE accounts`

---

### Task 3: Retention sweep

**Files:**
- Modify: `server/src/line/line-accounts.service.ts`, `server/src/line/line-purge.ts` (`tick` ~L37)
- Test: `server/src/line/line-accounts.service.spec.ts`

**Interfaces:**
- Produces: `LineAccountsService.sweep(now?: Date): Promise<{ memberships: number; accounts: number }>`; exported const `UNLINKED_RETENTION_DAYS = 365`.

- [ ] **Step 1: Failing tests:** `sweep deletes an unlinked membership unseen for more than 365 days`; `sweep keeps an unlinked membership seen 364 days ago`; `sweep keeps a linked membership however old`; `sweep deletes a LineAccount left with no membership and no link`; `sweep keeps an account still a member of another group`; `deleting a group then sweeping removes the orphaned account` (via `GroupsService.deleteGroup`).
- [ ] **Step 2: Run** `npx vitest run src/line/line-accounts.service.spec.ts` → FAIL.
- [ ] **Step 3: Implement `sweep`.** "Linked" = a `PlayerLineAccount` exists with the same `groupId` and the account's `lineUserId`. Delete stale unlinked memberships, then accounts with no `groups` and no `links`. Call it in `LinePurge.tick` after `this.roster.purge()` (inject `LineAccountsService`).
- [ ] **Step 4: Run** → PASS; `npm test`.
- [ ] **Step 5: Commit.** `feat(line): sweep stale unlinked LINE accounts`

---

### Task 4: Group routes and the player list field

**Files:**
- Create: `server/src/line/line-accounts.controller.ts`, `server/src/line/link-line-account.dto.ts`
- Modify: `server/src/line/line-accounts.service.ts`, `server/src/line/line.module.ts`, `server/src/groups/groups.service.ts` (`listPlayersManage` ~L217)
- Test: `server/src/line/line-accounts.controller.spec.ts`, `server/src/groups/list-players-manage.spec.ts`

**Interfaces:**
- Consumes: Task 1 schema and service.
- Produces (HTTP, owner-only, no `@Public`, under `@Controller('groups')`):
  - `GET /groups/:code/line/accounts` → `LineAccountRow[]`, ordered linked-last then `lastSeenAt` desc:
    ```ts
    interface LineAccountRow {
      id: string; displayName: string | null; pictureUrl: string | null;
      source: LineAccountSource; firstSeenAt: string; lastSeenAt: string;
      player: { id: string; name: string; linkedBy: 'self' | 'host' } | null;
    }
    ```
  - `PUT /groups/:code/line/accounts/:accountId/player` body `{ playerId: string }` → `{ ok: true }`
  - `DELETE /groups/:code/line/accounts/:accountId/player` → `{ ok: true }` (idempotent)
  - Service: `list(groupId): Promise<LineAccountRow[]>`, `link(groupId, accountId, playerId): Promise<void>`, `unlink(groupId, accountId): Promise<void>`.
  - `listPlayersManage` rows gain `lineAccount: { id: string; displayName: string | null; pictureUrl: string | null; linkedBy: 'self' | 'host' } | null`.
- Errors: account not a member of this group, or player not in this group → 404; account linked to a different player → 409 `{ code: 'ACCOUNT_ALREADY_LINKED' }`; linking a player who already has another account replaces that link (delete + create in one `$transaction`; a P2002 maps to the 409).

- [ ] **Step 1: Failing tests** (`line-accounts.controller.spec.ts`, via HTTP with an owner session like the existing controller specs):
  - `lists the group's accounts with name, avatar, source and linked player`
  - `link sets linkedBy 'host'`; `link replaces the player's previous account, which stays listed unlinked`
  - `unlink removes the link and the account stays listed`; `unlink twice is ok`
  - `linking an account linked to another player is 409 ACCOUNT_ALREADY_LINKED and changes nothing`
  - `an account known only in group A is 404 through group B's routes and absent from B's list` (same owner for A and B)
  - `a non-owner gets 404 on all three routes`
  - `a deleted player's account is listed unlinked`
  - `works on a free plan`
  - `the response never contains a raw lineUserId` (`expect(JSON.stringify(body)).not.toContain(lineUserId)`)
  - `list-players-manage.spec.ts`: `each player carries its linked LINE account or null`.
- [ ] **Step 2: Run** `npx vitest run src/line/line-accounts.controller.spec.ts src/groups/list-players-manage.spec.ts` → FAIL.
- [ ] **Step 3: Implement** the service methods, controller and DTO (`class-validator`: `@IsString() @IsNotEmpty() playerId`), register the controller in `LineModule`. `listPlayersManage`: one `playerLineAccount.findMany({ where: { groupId }, include: { lineAccount: true } })`, mapped by `playerId`.
- [ ] **Step 4: Run** → PASS; `npm test && npm run lint`.
- [ ] **Step 5: Commit.** `feat(line): host routes to list, link and unlink a group's LINE accounts`

---

### Task 5: Web: service, player-row chip, link picker

**Files:**
- Create: `web/src/app/core/line-accounts.service.ts`, `web/src/app/shared/line-account-picker/line-account-picker.{ts,html,css,spec.ts}`, `web/src/app/shared/line-avatar/line-avatar.{ts,css}`
- Modify: `web/src/app/core/roster.service.ts` (`ManagedPlayer`), `web/src/app/pages/player-roster/player-roster.{ts,html,css,spec.ts}`, `web/src/locale/messages.xlf`, `web/src/locale/messages.en.xlf`

**Interfaces:**
- Consumes: Task 4 HTTP routes and types.
- Produces:
  - `LineAccountsService` (`providedIn: 'root'`): `list(groupCode): Observable<LineAccountRow[]>`, `link(groupCode, accountId, playerId): Observable<{ ok: true }>`, `unlink(groupCode, accountId): Observable<{ ok: true }>`; `LineAccountRow` type exported from it.
  - `ManagedPlayer.lineAccount: { id; displayName; pictureUrl; linkedBy } | null`.
  - `<app-line-avatar [name] [pictureUrl] [size]>`: image with `referrerpolicy="no-referrer"`, falls back to the first letter on null or image error.
  - `<app-line-account-picker>` dialog: inputs `accounts: LineAccountRow[]` (caller passes unlinked ones), output `picked: string` (account id) and `closed`. A name filter; each row shows avatar, name and last seen.

- [ ] **Step 1: Failing specs** (`player-roster.spec.ts`, `line-account-picker.spec.ts`):
  - `a linked player's row shows the LINE avatar and name and an unlink button`
  - `unlink calls the API and the row returns to the link button`
  - `an unlinked player's row shows a link button that opens the picker with only unlinked accounts`
  - `picking an account calls link and the row shows that account`
  - `a 409 shows the already-linked message and leaves the row unchanged`
  - `self-claimed links are labelled as claimed by the player`
  - picker: `filters by name`; `shows an empty message when no unlinked accounts exist`
  - avatar: `falls back to the initial when the picture fails to load`
- [ ] **Step 2: Run** `cd web && npm test` → new specs FAIL.
- [ ] **Step 3: Implement.** Chip under the player name in the name cell; link/unlink buttons in the actions cell, hidden while `editingId()` is set. Copy (Thai source / English): `ผูก LINE` / `Link LINE`; `ยกเลิกการผูก` / `Unlink`; `ผู้เล่นผูกเอง` / `Linked by player`; `บัญชีนี้ผูกกับผู้เล่นคนอื่นแล้ว` / `This account is already linked to another player`; picker empty `ยังไม่มีบัญชี LINE ที่ยังไม่ได้ผูก` / `No unlinked LINE accounts yet`. Run `npx ng extract-i18n --output-path src/locale`, then add the English `<target>` for each new id in `messages.en.xlf`.
- [ ] **Step 4: Run** `npm test && npm run build` → PASS, build has no missing-translation warnings.
- [ ] **Step 5: Commit.** `feat(web): show and link a player's LINE account in the roster`

---

### Task 6: Web: the group's LINE account list page

**Files:**
- Create: `web/src/app/pages/line-accounts/line-accounts.{ts,html,css,spec.ts}`
- Modify: `web/src/app/app.routes.ts` (add `g/:groupCode/players/line`, `canActivate: [adminGuard]`), `web/src/app/pages/player-roster/player-roster.html` (the `บัญชี LINE` link near the top), locale files

**Interfaces:**
- Consumes: `LineAccountsService`, `<app-line-avatar>` (Task 5), `RosterService.listPlayersManage` for the player picker.

- [ ] **Step 1: Failing specs** (`line-accounts.spec.ts`):
  - `lists every account with avatar, name, last seen and its linked player`
  - `the ยังไม่ผูก filter shows only unlinked accounts`
  - `unlink keeps the row, now unlinked`
  - `ผูกกับผู้เล่น opens a player picker listing players without a LINE link first, and linking updates the row`
  - `empty state explains roster posts, slips and the pay page`
  - `back link returns to the roster page`
  - roster spec: `the บัญชี LINE link goes to /g/:code/players/line`
- [ ] **Step 2: Run** `cd web && npm test` → FAIL.
- [ ] **Step 3: Implement.** Copy: title `บัญชี LINE ในก๊วน` / `LINE accounts in this group`; filters `ทั้งหมด` / `All`, `ยังไม่ผูก` / `Unlinked`; action `ผูกกับผู้เล่น` / `Link to player`; empty `บัญชีจะขึ้นที่นี่เมื่อมีคนส่งรายชื่อในกลุ่ม LINE ส่งสลิป หรือกดยืนยันตัวเองในหน้าจ่ายเงิน` / `Accounts appear here when someone posts a roster in the LINE group, sends a slip, or confirms themselves on the pay page`; source labels `รายชื่อ` / `Roster`, `สลิป` / `Slip`, `ผู้เล่นยืนยัน` / `Player`, `ผู้จัด` / `Host`. Player picker: a simple dialog listing players (reuse `player-search-field` if it fits). Extract i18n and add English targets as in Task 5.
- [ ] **Step 4: Run** `npm test && npm run build` → PASS.
- [ ] **Step 5: Full suite from the repo root.** `npm test` → engines, server, web all PASS.
- [ ] **Step 6: Commit.** `feat(web): LINE account list for the group`
