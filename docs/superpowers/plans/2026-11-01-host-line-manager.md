# Host LINE Manager Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkboxes for tracking. Do not start implementation before owner reviews design and plan.

**Goal:** Let linked hosts manage owned-group payments in LINE and record successful link senders in the correct group's LINE directory.

**Architecture:** Extend current collector access with a live owner match and internal tick source. Record directory sightings after successful webhook redemption through `LineAccountsService.touch`; profile/directory failures cannot reverse linking.

**Tech Stack:** NestJS, Prisma/SQLite, Angular, Vitest, existing LINE Messaging API client.

---

## Design and execution constraints

- **Spec:** `docs/superpowers/specs/2026-11-01-host-line-manager-design.md`.
- **Branch:** At execution start, create `feat/host-line-manager` from reviewed base after checking `git status`. Leave unrelated cache/untracked files untouched.
- **Permissions:** Planning does not authorize commit, push, merge or deploy. Do not perform these steps until asked.
- **Testing:** Write focused regression cases first, observe failure, apply minimal changes and rerun. Server specs must stay serial within their migrated temporary test database (`server/test/vitest-global-setup.ts`).
- **Storage:** No migration or backfill. Preserve current first-source semantics and player-link rules.

## File responsibilities

| Area | Files | Responsibility |
| --- | --- | --- |
| Owner authorization | `server/src/sessions/slips/slip-payments.service.ts` | Live owner/collector decision and internal tick source |
| Payment HTTP | `server/src/sessions/slips/slip-collector.controller.ts` | Pass trusted source to existing tick operation |
| Host redemption | `server/src/line/line-host.service.ts` | Return only eligible code-generating group for directory insertion |
| Profile transport | `server/src/line/line-client.ts` | Fetch direct-chat user's name/avatar |
| Link observation | `server/src/line/line-webhook.service.ts`, `server/src/line/line-link.service.ts` | Best-effort directory insertion after successful redemption |
| Directory source | `server/src/line/line-accounts.service.ts`, `web/src/app/core/line-accounts.service.ts` | Accept and return `link` source |
| Directory label | `web/src/app/pages/line-accounts/line-accounts.ts`, both locale XLF files | Thai/English group-link label |
| Behavior docs | `docs/overview.md`, `HANDOFF-codex.md` | Document shipped behavior and current execution state |

---

## Task 1: Owner payment authorization and attribution

- [x] **Regression tests:** Extend `server/src/sessions/slips/slip-collector.controller.spec.ts`, reusing its `viewer`, `collectorBill`, `routes`, `q` and `role` helpers. Create a verified host viewer and update that fixture owner's `lineUserId`. Clear collector selection for owner-only cases. Prove owner can open every management route without a player link or directory membership; satisfy each mutation's normal prerequisites.
- [x] **Negative coverage:** Add unrelated owner, ownership transfer, host unlink/relink, stale card token, lapsed plan and invalid LINE header. Test every management route's refusal without mutation. Add host+collector overlap and independent collector fallback after unlink.
- [x] **Failing run:** Run `cd server && npx vitest run src/sessions/slips/slip-collector.controller.spec.ts`. Owner-access assertions should fail against current collector-only implementation.
- [x] **Role result:** In `SlipPaymentsService.collectorRole`, retain `gate()` first, then query the current owner through `gate.groupId`. Return internal `source` alongside `collector` and `panel`:

```ts
const group = await this.prisma.group.findUnique({
  where: { code: gate.groupId },
  select: { owner: { select: { lineUserId: true } } },
});
if (group?.owner?.lineUserId === user.userId) {
  return { collector: true, panel: gate.panel, source: 'host' as const };
}
const collector = await this.collectors.forBill(code);
const allowed = collector !== null && collector.lineUserId === user.userId;
return {
  collector: allowed,
  panel: gate.panel,
  source: allowed ? 'collector' as const : null,
};
```

- [x] **Type and controller change:** Extend the explicit role return type with `source: 'host' | 'collector' | null`; access return type with `source: 'host' | 'collector'`. Access returns null unless role has a non-null source. In controller tick, use the trusted result:

```ts
const access = await this.collector(code, token, req);
await this.slips.tick(code, dto.playerId, access.source);
```

- [x] **Compatibility:** Keep `slip-pay.controller.ts` public role response exactly `{collector: role.collector}`. Keep filtered management response, sender suppression, throttling, locks and existing collector resolution unchanged. Update method comments to include owners without broad renaming.
- [x] **Attribution tests:** Assert owner-only and overlapping owner/collector ticks store `host`; collector-only ticks store `collector`; existing slip/host/collector marks are not overwritten. Confirm closed collection allows authorized reads and rejects writes.
- [x] **Passing run:** Rerun the focused HTTP suite plus `src/sessions/slips/slip-payments.paid.spec.ts` and `src/sessions/collector.service.spec.ts`. Expect all tests passing and unchanged read-only status key assertions.

## Task 2: Return eligible DM-link group and fetch host profile

- [x] **Redemption tests:** Extend `server/src/line/line-host.spec.ts` to require successful redemption result's `groupCode` to equal only the code-generating group. A second owned group must never be returned. Existing changed-owner case and nullable/deleted group cases return `groupCode: null` while preserving successful host account linking.
- [x] **Profile tests:** Add tests in `server/src/line/line-client.spec.ts` for `userProfile('U1')`: exact URL `https://api.line.me/v2/bot/profile/U1`, bearer header, name/avatar, absent picture as null, malformed body/non-2xx/network failure as null, no request when unconfigured. Test path encoding.
- [x] **Failing run:** Run `cd server && npx vitest run src/line/line-host.spec.ts src/line/line-client.spec.ts`.
- [x] **Redemption change:** Add `groupCode: string | null` to successful `LineHostService.redeem` return shape. Initialize null before transaction; set to `group.code` only inside existing `enabled.count === 1` branch after successful group lookup. Return `{userId, groupName, groupCode}`. Keep account binding and used-code claim in their current transaction.
- [x] **Profile change:** Add this method, reusing transport failure handling; no new cache is needed for a one-time link lookup:

```ts
async userProfile(userId: string): Promise<MemberProfile | null> {
  const body = await this.call('GET', `/profile/${encodeURIComponent(userId)}`);
  if (typeof body?.displayName !== 'string') return null;
  return {
    displayName: body.displayName,
    pictureUrl: typeof body.pictureUrl === 'string' && body.pictureUrl !== ''
      ? body.pictureUrl : null,
  };
}
```

- [x] **Passing run:** Rerun both suites and update any exact successful-result expectations for new `groupCode`. Expect existing race, one-time code, unlink and ownership-change cases still passing.

## Task 3: Directory source and successful-link observations

- [x] **Source regression:** Extend `server/src/line/line-accounts.service.spec.ts`: touching a new account with `link` lists source `link`; touching an existing roster account with `link` keeps source `roster`, preserves known profile when null supplied, advances last-seen and creates no player link.
- [x] **Webhook regressions:** Extend `server/src/line/line-webhook.spec.ts` using signed webhook requests and real redemption. Group link records sender only in redeemed group; host DM link records only eligible returned group. Verify invalid, expired and used codes create no entries and trigger no profile lookup. Missing group sender skips insertion.
- [x] **Failure regressions:** Stub profile null/rejection and directory rejection independently. Successful link still binds account/group, consumes code and sends existing success reply. Null/rejected profile still attempts null-profile insertion. Assert no player links created. For directory-only sender, role remains false until host explicitly links player and selects collector.
- [x] **Failing run:** Run `cd server && npx vitest run src/line/line-accounts.service.spec.ts src/line/line-webhook.spec.ts`.
- [x] **Source implementation:** Add `'link'` to `LineAccountSource` and `toSource` recognized values. Keep `touch` implementation and database schema unchanged.
- [x] **Webhook dependency:** Inject `LineAccountsService` into `LineWebhookService`; it is already registered in `LineModule`. Add a private helper taking `(groupCode: string, lineUserId: string, source: 'host' | 'link', loadProfile: () => Promise<MemberProfile | null>)`. Catch lookup separately from insertion:

```ts
let profile: MemberProfile | null = null;
try {
  profile = await loadProfile();
} catch {
  this.logger.warn('link profile lookup failed');
}
try {
  await this.accounts.touch(groupCode, {
    lineUserId,
    displayName: profile?.displayName ?? null,
    pictureUrl: profile?.pictureUrl ?? null,
  }, source);
} catch {
  this.logger.warn('link directory recording failed');
}
```

- [x] **Group invocation:** After successful `onLink` redemption and throttle success, invoke helper only with non-null sender: redeemed `linked.groupCode`, `senderUserId`, `'link'`, and `() => this.client.memberProfile(groupId, senderUserId)`. Keep failed-code throttle and reply behavior unchanged.
- [x] **DM invocation:** After successful `onHostLink` redemption and throttle success, invoke helper only with non-null `linked.groupCode`: that code, `lineUserId`, `'host'`, and `() => this.client.userProfile(lineUserId)`. Keep successful linkage even if either helper stage fails.
- [x] **Mocks and passing run:** Add `userProfile` to affected fake LINE clients; reset it consistently. Rerun webhook, account service, host link and group link suites serially. Verify cleanup deletes test-created memberships/accounts without touching unrelated data.

- [x] **Unlink-race regression and fix:** Delayed profile lookup reproduced membership recreation after unlink and bot leave (two failing tests). `LineLinkService.recordSender` now holds existing group lock, rechecks live LINE group and touches only a still-linked group; five focused suites pass, including both regressions.

## Task 4: Directory label and management UI regression

- [x] **UI tests:** Extend `web/src/app/pages/line-accounts/line-accounts.spec.ts` with a row using `source: 'link'`; verify **เชื่อมกลุ่ม**, unknown-profile fallback and existing explicit player-link action. Confirm directory insertion does not appear as an already-linked player.
- [x] **Management tests:** In `web/src/app/pages/payment-status/payment-status.spec.ts`, cover `{collector: true}` with management response containing a `host` paid mark. In `web/src/app/shared/slip-review/slip-review.spec.ts`, verify `collectorMode: true` renders existing **โฮสต์ติ๊ก** chip while continuing to hide linking and saved-name actions.
- [x] **Failing run:** Run focused Angular tests with `cd web && npx ng test --watch=false --include src/app/pages/line-accounts/line-accounts.spec.ts`; new source fixture should fail type/build or label expectations before implementation.
- [x] **Browser source:** Add `'link'` to `LineAccountRow['source']` union in `web/src/app/core/line-accounts.service.ts`; add label case:

```ts
case 'link':
  return $localize`:@@lineAccounts.sourceLink:เชื่อมกลุ่ม`;
```

- [x] **Locales:** Hand-add `lineAccounts.sourceLink` before `</body>` in `web/src/locale/messages.xlf` with source **เชื่อมกลุ่ม**; add same unit to `messages.en.xlf` with target **Group link**. Do not run extraction. No payment-screen redesign or role API expansion.
- [x] **Directory passing run:** Run `cd web && npx ng test --watch=false --include src/app/pages/line-accounts/line-accounts.spec.ts`. Expect new source label and existing explicit-link behavior to pass.
- [x] **Payment-page passing run:** Run `cd web && npx ng test --watch=false --include src/app/pages/payment-status/payment-status.spec.ts`. Expect owner management response to use existing management view.
- [x] **Review passing run:** Run `cd web && npx ng test --watch=false --include src/app/shared/slip-review/slip-review.spec.ts`. Expect host chip and existing collector-mode restrictions to pass.

## Task 5: Full verification, docs and review

- [x] **Regression gate:** Root `npm test` passed: **408 engine**, **1,956 server**, **1,981 web** tests; one server skip and one web todo. Server lint/build and web production build exited zero. Web build retains existing dashboard CSS-budget and LIFF CommonJS warnings. Evidence: `/tmp/jubbad-host-line-full-final.log`, `/tmp/jubbad-host-line-lint-final.log`, `/tmp/jubbad-host-line-server-build-final.log`, `/tmp/jubbad-host-line-web-build.log`.
- [x] **Scope review:** Confirm no Prisma migration, no backfill, no auto player links, no additional public role/status fields, no unrelated cache files and no change to collector pinning. Inspect new logs for accidental sensitive values.
- [x] **Overview:** Update `docs/overview.md` collector access and directory sections to describe owner authorization, attribution, DM-only support, link source and exact directory membership scope. Correct collector-only statements where owner grant now applies.
- [x] **Handoff:** Update `HANDOFF-codex.md` to reflect implementation/test state and remaining release steps. Keep uncommitted until owner asks. Check completed task boxes as work finishes.
- [x] **Review artifacts:** Spec and code-quality reviews approved owner, directory and UI changes; final independent review approved. Overview and handoff record changes and proof. Keep spec/plan live while release and real-phone verification remain; archive only once fully complete according to `CLAUDE.md`.
- [ ] **Phone check after authorized deployment:** Open newly sent payment card as linked host and collector; confirm owner-only host access, correct chips and directory profile/source. Verify host unlink revokes owner-based access. Collection-close test must use a disposable test bill because close deletes slip images.

---

## Completion conditions

- **Functional:** Host owner access, payment attribution and both directory link paths satisfy spec and regression cases.
- **Proof:** Focused and full checks pass; real-phone verification status is reported honestly.
- **Release:** Commit, merge and deployment remain separate owner-authorized actions. Planning alone does not authorize them.
