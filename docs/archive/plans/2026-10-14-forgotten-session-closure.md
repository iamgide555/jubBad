# Forgotten Session Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a host explicitly close forgotten sessions before starting another for the same group, finishing active games with no result and honest estimated durations.

**Architecture:** Add recovery metadata and a pure duration helper, then an authenticated preview/close operation under existing group and session locks. Block new creation while any session is open and place the resolution flow in roster entry. Closure and creation remain separate, retryable operations; no timer is added.

**Tech Stack:** TypeScript, NestJS, Prisma 7 with SQLite, Angular standalone components/signals, Vitest, Angular localization.

**Spec:** `docs/archive/specs/2026-10-14-forgotten-session-closure-design.md`.

## Global Constraints

- **No background expiry job or inactivity timestamp.**
- **No new runtime dependencies.**
- **Thai is the source locale; English translations ship with every new user-facing string.**
- **Use existing authentication, ownership guards, group locks, session locks, and Prisma transactions.**
- **Server tests remain `fileParallelism: false`.**
- **Retain roster drafts and session-creation idempotency keys on errors and retries.**
- **No fabricated winners, scores, measured durations, or shuttle records.**

## Review Focus

- **Live change after preview:** a finish, auto-confirm, shuffle, or lineup edit must invalidate consent before any closure write; Task 3 tests stale hashes.
- **Retry or two tabs:** duplicate close requests must not change durations; fresh concurrent creations must not create two open sessions; Tasks 3 and 4 test retries and races.
- **Legacy multiple open sessions:** the newest session pointer is insufficient; every open session must be resolved without migration failure; Task 4 tests older open sessions.
- **No useful duration sample:** unknown time must never become a 24-hour game, zero-length estimate, or polluted average; Tasks 1, 2, and 5 test null and mixed duration sources.
- **Advanced billing state:** recovered games retain shuttle logs and settled checkout receipts, and never invent consumption; Task 3 tests log/receipt preservation and bill reads.

---

## File Map and Reading Order

- **Read first:** `CLAUDE.md`, `docs/overview.md` (session lifecycle, duration, billing, early checkout, ladders), and the linked spec.
- **Persistence:** `server/prisma/schema.prisma`; create `server/prisma/migrations/20261014000000_forgotten_session_closure/migration.sql`.
- **Duration unit:** create `server/src/sessions/match-duration.ts` and `match-duration.spec.ts`; keep this independent of NestJS and Prisma.
- **Recovery unit:** create `server/src/sessions/forgotten-session.ts` and `forgotten-session.spec.ts` for deterministic preview/hash and transaction writes. Integrate through `SessionsService`; do not move unrelated methods out of that large file.
- **API:** `server/src/sessions/sessions.controller.ts`, `sessions.service.ts`; create `dto/close-forgotten-session.dto.ts` and `forgotten-session.controller.spec.ts`.
- **Read models:** `server/src/sessions/sessions.service.ts`, `server/src/groups/groups.service.ts`, `web/src/app/core/session-summary.model.ts`, and summary page/tests.
- **Creation:** `server/src/sessions/sessions.service.ts`; create `session-creation-open-guard.spec.ts`; adjust existing historical fixtures in `sessions.controller.spec.ts` where they create several sessions for one group.
- **Host flow:** `web/src/app/core/roster.service.ts`, its tests, `web/src/app/pages/group-entry/group-entry.ts`, `.html`, `.css`, and `.spec.ts`; create `web/src/app/core/session-closure.model.ts`.
- **Localization/documentation:** `web/src/locale/messages.xlf`, `messages.en.xlf`, `docs/overview.md`.

**Existing behavior to preserve:** `createSession` already uses `groupLevels.withGroupLock` and a transactional `SessionCreation` retry record. `endSession` refuses unfinished pairings. `finishPairing` stores no-result games with `winner: null`. `getSummary` currently derives duration from timestamps and divides total time by played count in the web page. Billing in `bill-snapshot.ts`/`engines/bill.ts` does not use duration. `RosterService.listSessions` already returns every session for the group. Group-home's `sessionState` can call a day-old open session stale; the new gate must use actual `endedAt`, not that display state.

---

## Task 1: Persist Recovery Metadata and Define Duration Rules

**Files:**
- Modify: `server/prisma/schema.prisma` (`Session`, `Pairing`).
- Create: `server/prisma/migrations/20261014000000_forgotten_session_closure/migration.sql`.
- Create: `server/src/sessions/match-duration.ts`, `match-duration.spec.ts`.

**Interfaces:**
- **Consumes:** persisted pairing timestamps plus the new nullable metadata.
- **Produces:** `DurationRow`, `matchDuration(row): { seconds: number | null; source: 'recorded' | 'estimated' | 'unknown' }`, `averageRecordedSeconds(rows): number | null`, and `estimateAtClosure(row, average, now): number | null`.

- [x] **Step 1: Write failing pure duration tests.** Use this complete starter file; add the fractional-mean case before implementation.

```ts
import { describe, expect, it } from 'vitest';
import { averageRecordedSeconds, estimateAtClosure, matchDuration, type DurationRow } from './match-duration.js';

const row = (seconds: number): DurationRow => ({
  confirmedAt: new Date(0), endedAt: new Date(seconds * 1000),
  closedWithoutResultAt: null, estimatedDurationSeconds: null,
});

describe('recovery durations', () => {
  it('averages only positive measured completed games', () => {
    expect(averageRecordedSeconds([
      row(600), row(1200), row(0), row(-1),
      { ...row(86400), closedWithoutResultAt: new Date(), estimatedDurationSeconds: 900 },
      { ...row(60), endedAt: null },
      { ...row(60), confirmedAt: null },
    ])).toBe(900);
  });
  it('returns unknown without a sample', () => {
    expect(averageRecordedSeconds([row(0)])).toBeNull();
    expect(matchDuration({ ...row(86400), closedWithoutResultAt: new Date() }))
      .toEqual({ seconds: null, source: 'unknown' });
  });
  it('caps an estimate to the possible elapsed time', () => {
    expect(estimateAtClosure({ ...row(60), endedAt: null }, 900, new Date(60_000))).toBe(60);
    expect(estimateAtClosure({ ...row(60), endedAt: null }, null, new Date(60_000))).toBeNull();
    expect(estimateAtClosure({ ...row(60), confirmedAt: new Date(120_000) }, 900, new Date(60_000))).toBe(0);
  });
  it('uses estimates without pretending the end timestamp was measured', () => {
    expect(matchDuration({ ...row(86400), closedWithoutResultAt: new Date(), estimatedDurationSeconds: 900 }))
      .toEqual({ seconds: 900, source: 'estimated' });
    expect(matchDuration(row(600))).toEqual({ seconds: 600, source: 'recorded' });
  });
  it('rounds the mean once rather than each sample', () => {
    expect(averageRecordedSeconds([row(1.4), row(1.4), row(1.8)])).toBe(2);
  });
});
```

- [x] **Step 2: Verify red.** From `server/`, run `npm test -- src/sessions/match-duration.spec.ts`; expect a missing-module failure.
- [x] **Step 3: Implement the helper and additive migration.** Add `closedAsForgottenAt DateTime?` to `Session`; add `closedWithoutResultAt DateTime?` and `estimatedDurationSeconds Int?` to `Pairing`. Use nullable columns with no backfill or unique-open-session constraint.

```sql
ALTER TABLE "Session" ADD COLUMN "closedAsForgottenAt" DATETIME;
ALTER TABLE "Pairing" ADD COLUMN "closedWithoutResultAt" DATETIME;
ALTER TABLE "Pairing" ADD COLUMN "estimatedDurationSeconds" INTEGER;
```

```ts
export interface DurationRow {
  confirmedAt: Date | null;
  endedAt: Date | null;
  closedWithoutResultAt: Date | null;
  estimatedDurationSeconds: number | null;
}
export function matchDuration(row: DurationRow): {
  seconds: number | null; source: 'recorded' | 'estimated' | 'unknown';
} {
  if (row.closedWithoutResultAt !== null) return row.estimatedDurationSeconds === null
    ? { seconds: null, source: 'unknown' }
    : { seconds: row.estimatedDurationSeconds, source: 'estimated' };
  if (row.confirmedAt === null || row.endedAt === null) return { seconds: null, source: 'unknown' };
  return { seconds: Math.max(0, Math.round((+row.endedAt - +row.confirmedAt) / 1000)), source: 'recorded' };
}
export function averageRecordedSeconds(rows: readonly DurationRow[]): number | null {
  const samples = rows.filter(r => r.closedWithoutResultAt === null && r.confirmedAt !== null
    && r.endedAt !== null && +r.endedAt > +r.confirmedAt)
    .map(r => (+r.endedAt! - +r.confirmedAt!) / 1000);
  return samples.length ? Math.round(samples.reduce((sum, s) => sum + s, 0) / samples.length) : null;
}
export function estimateAtClosure(row: DurationRow, average: number | null, now: Date): number | null {
  if (average === null || row.confirmedAt === null) return null;
  return Math.min(average, Math.max(0, Math.floor((+now - +row.confirmedAt) / 1000)));
}
```

- [x] **Step 4: Verify migration and green tests.** Apply the migration to an isolated SQLite copy, compare pre/post session/pairing row counts and existing columns, and run `PRAGMA foreign_key_check`. Follow the isolated database pattern in `server/src/groups/level-ladder-migration.spec.ts`; add `server/src/sessions/forgotten-session-migration.spec.ts` with assertions that a legacy pair of open sessions survives unchanged and all new fields are null. From `server/`, run `npx prisma generate --config prisma7.config.ts`, then rerun the pure tests. Do not migrate a production database during implementation.
- [x] **Step 5: Commit this deliverable.** Stage only the schema, migration, duration helper, and their tests; use `feat: add recovery duration metadata`.

---

## Task 2: Preserve Duration Provenance in Summaries and Exports

**Files:**
- Modify: `server/src/sessions/sessions.service.ts` (`SessionMatch`, `getSummary`, normal finish/undo writes).
- Modify: `server/src/groups/groups.service.ts` (export projection).
- Modify: `web/src/app/core/session-summary.model.ts`, `web/src/app/pages/session-summary/session-summary.ts`, `.html`, `.spec.ts`.
- Modify: `web/src/locale/messages.xlf`, `messages.en.xlf`.
- Test: `server/src/sessions/sessions.controller.spec.ts` (summary assertions); create `web/src/app/core/session-duration-summary.ts`, `.spec.ts`.

**Interfaces:**
- **Consumes:** Task 1's `matchDuration` and nullable database fields.
- **Produces:** `SessionMatch.durationSeconds: number | null`, `durationSource: 'recorded' | 'estimated' | 'unknown'`; player summary fields `measuredTotalSeconds`, `measuredMatchCount`, `estimatedMatchCount`, `unknownDurationMatchCount` (all numbers). Keep `totalSeconds` as the sum of known durations.

- [x] **Step 1: Write failing summary aggregation tests.** Create the small shared web helper below and first test its contract using a new `.spec.ts` file. Add an API summary fixture with one 600-second measured game, one recovered 900-second estimated game, and one recovered unknown game; assert played is 3, won/lost remain unchanged for recovery games, total is 1500, measured average is 600, estimated count is 1, and unknown count is 1. Use existing `sessions.controller.spec.ts` setup and direct Prisma fixture writes.

```ts
import { expect, it } from 'vitest';
import { durationSummary } from './session-duration-summary';
it('does not mix estimates or unknown games into measured averages', () => {
  expect(durationSummary([
    { durationSeconds: 600, durationSource: 'recorded' },
    { durationSeconds: 900, durationSource: 'estimated' },
    { durationSeconds: null, durationSource: 'unknown' },
  ])).toEqual({ totalSeconds: 1500, measuredTotalSeconds: 600,
    measuredMatchCount: 1, estimatedMatchCount: 1, unknownDurationMatchCount: 1 });
});
```

- [x] **Step 2: Verify red.** From `web/`, run `npm test -- --watch=false --include='src/app/core/session-duration-summary.spec.ts'`; expect missing module. Run the new API summary case with `npm test -- src/sessions/sessions.controller.spec.ts -t 'recovery duration'` from `server/`; expect missing metadata/duration assertions to fail.
- [x] **Step 3: Implement API aggregation, exports, and measured web averages.** Replace the timestamp calculation in `getSummary` with `matchDuration(p)` and increment source counters per player. Use the following web aggregation contract for display fallback on older payload fixtures; the server performs the equivalent aggregation through its existing maps, avoiding a server import of web code.

```ts
export function durationSummary(matches: readonly {
  durationSeconds: number | null;
  durationSource?: 'recorded' | 'estimated' | 'unknown';
}[]) {
  const result = { totalSeconds: 0, measuredTotalSeconds: 0,
    measuredMatchCount: 0, estimatedMatchCount: 0, unknownDurationMatchCount: 0 };
  for (const m of matches) {
    const source = m.durationSource ?? (m.durationSeconds === null ? 'unknown' : 'recorded');
    if (m.durationSeconds !== null) result.totalSeconds += m.durationSeconds;
    if (source === 'recorded' && m.durationSeconds !== null) {
      result.measuredTotalSeconds += m.durationSeconds;
      result.measuredMatchCount++;
    } else if (source === 'estimated') result.estimatedMatchCount++;
    else result.unknownDurationMatchCount++;
  }
  return result;
}
```

**Presentation changes:** use `durationSummary(row.matches)` for the average denominator and total annotations; do not divide total time by `played`. Match rows branch on null before calling `formatMinutes`. Show `Estimated` / `โดยประมาณ`, `Duration unknown` / `ไม่ทราบเวลา`, and `Partial total` / `เวลารวมไม่ครบ`; give each a stable localization ID. Existing recorded-only summaries must keep their current labels. Export `closedAsForgottenAt`, `closedWithoutResultAt`, and `estimatedDurationSeconds`. Normal finish and undo-of-finish/confirmation clear both pairing recovery fields; result corrections preserve them.

```ts
// Normal finish/undo data additions:
closedWithoutResultAt: null,
estimatedDurationSeconds: null,
```

- [x] **Step 4: Verify green and UI semantics.** Run the helper tests, summary page tests, and the API summary case. Add page cases for all-unknown time (show unknown, not `0 min`), mixed totals (estimated and partial labels), and recorded-only payloads. Add an export assertion and a result-correction assertion proving estimates remain labeled after winner edits. Update canonical fixtures to carry the new source/counter fields.
- [x] **Step 5: Commit this deliverable.** Stage only Task 2 files; use `feat: label estimated match durations`.

---

## Task 3: Add Explicit, Atomic Forgotten-Session Closure

**Files:**
- Create: `server/src/sessions/forgotten-session.ts`, `forgotten-session.spec.ts`, `forgotten-session.controller.spec.ts`, `dto/close-forgotten-session.dto.ts`.
- Modify: `server/src/sessions/sessions.service.ts`, `sessions.controller.ts`.
- Test: `server/src/auth/auth.boundary.spec.ts`, `server/src/sessions/bill.controller.spec.ts`, `shuttle-lifecycle.spec.ts`.

**Interfaces:**
- **Consumes:** `Prisma.TransactionClient`, Task 1 duration helper, `groupLevels.withGroupLock`, and `SessionLock.run`.
- **Produces:** `ClosePreview` with `code: string`, `endedAt: string | null`, `snapshotHash: string`, `pendingCount: number`, `activeCount: number`, `queuedCount: number`, `averageDurationSeconds: number | null`. Export `readClosureSnapshot(tx, code)` and `closeForgottenInTransaction(tx, code, snapshotHash, now): Promise<{ code: string; endedAt: Date }>` from `forgotten-session.ts`.

- [x] **Step 1: Write failing transaction integration tests.** Bootstrap `PrismaModule` and `SessionsModule` with the same Nest testing pattern as `sessions.controller.spec.ts`. Seed a unique group, roster, a measured game, an active game, a pending pairing, and queued lineup using Prisma; clean children before parents in `afterEach`. Call the new service interfaces directly for deterministic testing:

```ts
const preview = await service.previewForgottenSession(code);
expect(preview).toMatchObject({ pendingCount: 1, activeCount: 1, queuedCount: 1, averageDurationSeconds: 900 });
await service.closeForgottenSession(code, { snapshotHash: preview.snapshotHash });
const active = await prisma.pairing.findUniqueOrThrow({ where: { id: activeId } });
expect(active).toMatchObject({ winner: null, scoreA: null, scoreB: null,
  estimatedDurationSeconds: 900, revision: 1 });
expect(active.closedWithoutResultAt).toEqual(active.endedAt);
expect(active.confirmedAt).toEqual(originalConfirmedAt);
expect(await prisma.pairing.findUnique({ where: { id: pendingId } })).toBeNull();
expect(await prisma.queuedMatch.count({ where: { sessionId: code } })).toBe(0);
```

**Additional independent cases:** preview is read-only; empty session closes; no measured sample stores null; another finish/auto-confirm/queue edit after preview returns `SESSION_CLOSE_STALE` and leaves all other rows unchanged; finished rows remain byte-for-byte equal; repeated close preserves timestamps, revisions, and estimates; injected transaction failure rolls back deletions and updates; ordinary `endSession` still refuses unfinished games.

- [x] **Step 2: Verify red.** From `server/`, run `npm test -- src/sessions/forgotten-session.spec.ts`; expect missing new service methods/helper module.
- [x] **Step 3: Implement deterministic snapshot and transactional writes.** In `readClosureSnapshot`, fetch the session, all pairings ordered by `id`, and queues ordered by `id`. Throw `SESSION_NOT_FOUND` on a missing session. Use `createHash` from `node:crypto`; project only stable fields, with ISO timestamps and explicit nulls. Expose the preview counts but keep raw rows private to the helper.

```ts
const snapshotHash = createHash('sha256').update(JSON.stringify({
  code: session.code, endedAt: session.endedAt?.toISOString() ?? null,
  pairings: pairings.map(p => ({ id: p.id, revision: p.revision,
    confirmedAt: p.confirmedAt?.toISOString() ?? null,
    endedAt: p.endedAt?.toISOString() ?? null,
    closedWithoutResultAt: p.closedWithoutResultAt?.toISOString() ?? null,
    estimatedDurationSeconds: p.estimatedDurationSeconds })),
  queues: queues.map(q => ({ id: q.id, position: q.position, teamA: q.teamA, teamB: q.teamB })),
})).digest('hex');
```

**Transaction sequence:** re-read snapshot; return existing `endedAt` if already closed; reject mismatched hash; compute measured average once from pre-write finished rows; delete dependent shuttle uses for pending IDs; delete pending rows; finish each active row using `estimateAtClosure`, clear scores/winner, increment revision; delete queued matches; update session closure fields. Keep active-match shuttle uses and identities untouched. No calls to separately transactional service finish methods inside this transaction.

```ts
await tx.pairing.update({ where: { id: p.id }, data: {
  endedAt: now, closedWithoutResultAt: now,
  estimatedDurationSeconds: estimateAtClosure(p, average, now),
  winner: null, scoreA: null, scoreB: null, revision: { increment: 1 },
} });
```

**Service wrappers:** `previewForgottenSession(code)` uses one read transaction. `closeForgottenSession(code, dto)` looks up `groupId`, obtains group then session lock, then calls `closeForgottenInTransaction` inside `$transaction`. Declare both service signatures explicitly; controller delegates to them. The lookup outside the locks is only for group-lock routing; existence/state is rechecked inside the transaction.

```ts
import { IsString, Matches } from 'class-validator';
export class CloseForgottenSessionDto {
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  snapshotHash!: string;
}
```

**Routes:** add `@Get(':code/close-preview')` and `@Post(':code/close-forgotten')`; neither uses `@Public()`. Reuse the existing ownership-by-session-code route convention.

- [x] **Step 4: Verify green, boundaries, and advanced bookkeeping.** Test anonymous denial, other-owner 404, owner success, malformed hash 400, missing session 404. Add an advanced fixture with shuttle uses and a settled checkout: compare identity/use/receipt rows before and after closure, confirm bill includes the recovered game exactly once, and confirm no-result changes no winner-based Elo. Verify normal auto-confirm can race closure only by invalidating the preview or observing an ended session; no auto-confirmed game may appear after committed closure.
- [x] **Step 5: Commit this deliverable.** Stage only Task 3 files; use `feat: close forgotten sessions explicitly`.

---

## Task 4: Enforce One Open Session per Group on New Creation

**Files:**
- Modify: `server/src/sessions/sessions.service.ts` (`createSessionExclusively`).
- Create: `server/src/sessions/session-creation-open-guard.spec.ts`.
- Modify fixtures only where necessary: `server/src/sessions/sessions.controller.spec.ts`, other failing creation tests that intentionally build historical sessions.

**Interfaces:**
- **Consumes:** existing group-scoped lock and `SessionCreation` keys; Task 3 explicit closure.
- **Produces:** HTTP 409 `{ code: 'GROUP_HAS_OPEN_SESSIONS', sessionCodes: string[] }`, ordered newest-first with code as a tie-breaker. Successful request/retry remains `{ code: string }`.

- [x] **Step 1: Write failing creation tests.** Reuse the Nest/Prisma test bootstrap pattern. Create a group and DTO with empty review arrays to isolate the guard; no endpoint minimum roster exists. Test an unstarted open session, a day-old active session, and two legacy open sessions with a newer ended session. Verify rejection makes no player, alias, tag, roster, or idempotency writes.

```ts
const caller = { id: 'guard-test-admin', role: 'admin' };
const dto = { groupCode, date: null, venue: null, courtCount: 1,
  rawImportText: '', idempotencyKey: randomUUID(), rosterReviews: [], waitlistReviews: [] };
await expect(service.createSession(dto, caller)).rejects.toMatchObject({
  response: { code: 'GROUP_HAS_OPEN_SESSIONS', sessionCodes: [openCode] },
});
```

**Retry/race tests:** with no pre-existing open session, call the same DTO twice and expect one code; submit two distinct keys concurrently and expect one success, one `GROUP_HAS_OPEN_SESSIONS`; close an old session then create successfully; repeat the old successful key while its created session is still open and return that session rather than a conflict. Different groups may each create one session.

- [x] **Step 2: Verify red.** From `server/`, run `npm test -- src/sessions/session-creation-open-guard.spec.ts`; expect creation to succeed where the new tests require refusal.
- [x] **Step 3: Insert the guard before any writes.** Move the existing ownership lookup/check before returning a prior idempotency record, so retries cannot bypass ownership. After ownership and the prior-key check, query all open sessions inside the existing transaction before ladder/player resolution.

```ts
const open = await tx.session.findMany({
  where: { groupId: dto.groupCode, endedAt: null },
  orderBy: [{ createdAt: 'desc' }, { code: 'asc' }], select: { code: true },
});
if (open.length) throw this.conflict('GROUP_HAS_OPEN_SESSIONS', {
  sessionCodes: open.map(s => s.code),
});
```

**Compatibility:** do not add a database uniqueness constraint or silently close anything during creation. Historical test fixtures should directly seed ended sessions or explicitly end previous sessions before creating another; preserve any tests deliberately exercising legacy multiple-open-session data.

- [x] **Step 4: Verify green.** Run the guard tests and `sessions.controller.spec.ts`, then the server suite once to find fixture assumptions. Add an owner mismatch on a valid prior key and assert 404. Audit lock acquisition: recovery and creation share the existing group lock, and no existing method acquires group lock while holding session lock.
- [x] **Step 5: Commit this deliverable.** Stage only Task 4 files; use `feat: block creation with open sessions`.

---

## Task 5: Add the Host Resolution Flow and End-to-End Proof

**Files:**
- Create: `web/src/app/core/session-closure.model.ts`.
- Modify: `web/src/app/core/roster.service.ts`, `roster.service.spec.ts`.
- Modify: `web/src/app/pages/group-entry/group-entry.ts`, `.html`, `.css`, `.spec.ts`.
- Modify: `web/src/locale/messages.xlf`, `messages.en.xlf`, `docs/overview.md`.

**Interfaces:**
- **Consumes:** `RosterService.listSessions(groupCode)`, Task 3 preview/close API, Task 4 conflict code.
- **Produces:** `RosterService.previewForgottenSession(code): Observable<ClosePreview>` and `closeForgottenSession(code, snapshotHash): Observable<{ code: string; endedAt: string }>`; component methods `loadOpenSessions(): Promise<void>`, `previewClosure(code): Promise<void>`, `cancelClosure(): void`, `confirmClosure(): Promise<void>`.

- [x] **Step 1: Write failing HTTP and UI tests.** Define `ClosePreview` in the new web model with the exact Task 3 field names. In service tests, assert GET preview and POST close body `{ snapshotHash }`. In page tests, flush `/groups/group1/sessions` during initialization before the gate becomes ready; tests with no old session flush `[]`.

```ts
it('posts only the reviewed hash when closing', () => {
  service.closeForgottenSession('old', 'a'.repeat(64)).subscribe();
  const req = httpMock.expectOne({ url: `${B}/sessions/old/close-forgotten`, method: 'POST' });
  expect(req.request.body).toEqual({ snapshotHash: 'a'.repeat(64) });
  req.flush({ code: 'old', endedAt: '2026-10-14T10:00:00Z' });
});
```

**Page cases:** an open session hides/disables starting a new session; resume links to `/s/:code`; preview shows counts and sample estimate; cancel sends no POST; double tap sends one POST; a stale hash requires a refreshed preview and another deliberate confirmation; closing all legacy sessions unlocks roster entry; list load error blocks submission and offers retry; a creation conflict retains reviews, date, venue, court count, raw text, and idempotency key; resuming/successful close does not erase staged drafts. HTTP errors never silently proceed to creation.

- [x] **Step 2: Verify red.** From `web/`, run `npm test -- --watch=false --include='src/app/core/roster.service.spec.ts' --include='src/app/pages/group-entry/group-entry.spec.ts'`; expect missing new methods or missing gate behavior.
- [x] **Step 3: Implement the gate, preview, and explicit close.** Use `firstValueFrom` like `confirmRoster` already does. Store pending resolution state in component signals, not persistent storage. Consent/hash is transient and is never copied into `RosterDraft`.

```ts
// RosterService methods; import Observable and ClosePreview for explicit return types.
previewForgottenSession(code: string): Observable<ClosePreview> {
  return this.http.get<ClosePreview>(`${this.base}/sessions/${code}/close-preview`);
}
closeForgottenSession(code: string, snapshotHash: string): Observable<{ code: string; endedAt: string }> {
  return this.http.post<{ code: string; endedAt: string }>(
    `${this.base}/sessions/${code}/close-forgotten`, { snapshotHash });
}
```

**Component state:** add `openSessions`, `sessionGateStatus: 'loading' | 'ready' | 'error'`, `closePreview`, `closureBusy`, and `closureError`. Load the owner-only full session list after group load, filter `endedAt === null`, and sort newest-first. Keep existing `state: 'paste' | 'confirm'` and draft restoration unchanged; display the gate above the retained roster UI. `confirmRoster` refuses unless gate status is ready and no sessions remain. The create-conflict handler calls `loadOpenSessions()` instead of clearing any form field or regenerating the request key.

**Confirm action sequence:** guard busy state; POST the currently reviewed hash; clear preview after success; reload the session list; unlock roster entry only when none remain. On `SESSION_CLOSE_STALE`, clear the old preview, fetch a new one, and show **Session changed. Review again before closing.** No automatic retry of a destructive close. On network failure, retain the hash and allow retry; the API's already-ended behavior makes retry safe.

**UX copy:** Thai source with stable English translations: **Resume session**, **Close previous session and continue**, **Cancel**, **Pending lineups will be discarded. Active matches will count as played with no result. Their durations will be estimated from completed games when available. This may affect the previous session's bill.** Show **Duration unknown** when the preview has no sample. Use an inline confirmation panel with a heading, focus placement, `aria-live` error/status, disabled busy controls, and existing 44px tap targets. Include queued-lineup count separately from pending court count.

- [x] **Step 4: Verify green and document final behavior.** Run targeted page/service/summary tests. Update `docs/overview.md` session lifecycle and duration sections to explain on-demand closure, estimate provenance, measured-only averages, creation guard, and billing participation. Keep the existing public dashboard's day-old display-only rule documented distinctly from actual closure. Manual browser check: open old active and pending courts; enter roster route; cancel; resume; then close and create; inspect old summary and bill in Thai and English; verify a second tab with a late finish causes re-review.
- [x] **Step 5: Run release checks once and commit.** From root run `npm test`, then `npm --prefix server run build` and `npm --prefix web run build`. Run the existing server lint command. Confirm generated localization catalogs contain matching IDs/parameters and there are no unrelated modifications. Stage only Task 5 files; use `feat: resolve forgotten sessions before starting`.

---

## Execution and Completion

- **Execution recommendation:** native implementation. These five tasks share duration types and session lifecycle contracts; keeping one implementer responsible reduces interface drift, followed by a focused independent review of closure transactions, retries, and billing preservation.
- **Database rollout:** back up using `npm --prefix server run db:backup` before applying the additive migration through the established deployment workflow. Deploy regenerated Prisma/server before the web bundle. A rolled-back server can ignore the nullable columns; preserve those columns and their data rather than dropping recovery history.
- **Completion:** check implemented steps only after their evidence exists. When the full plan is complete, archive it and the spec according to `CLAUDE.md`. Do not commit or implement application changes while merely preparing this plan.

## Plan Self-Review

- **Spec coverage:** persistence/duration → Task 1; summaries/exports/corrections → Task 2; preview/atomic closure/authorization/bookkeeping → Task 3; all-session creation guard/idempotency → Task 4; host flow/drafts/localization/manual proof → Task 5.
- **Interface consistency:** `snapshotHash` is the only close body field; `averageDurationSeconds` is the preview sample; `estimatedDurationSeconds` is per-match persisted metadata; `durationSource` is the public read-model provenance.
- **Failure coverage:** stale preview, duplicate close, concurrent create, multiple old sessions, absent samples, future timestamps, migration preservation, auth, and advanced billing state are assigned above.
- **Scope:** no scheduling, activity tracking, default estimated duration, duration editor, new runtime library, or wholesale service refactor.

## Implementation Evidence

- **Completed:** all five tasks; one feature commit contains the reviewed implementation.
- **Verification:** `npm test` passed: 386 engine, 851 server, and 946 web tests; one existing web test remains marked `todo`. Both production builds and server lint passed. The existing dashboard CSS warning remains.
- **Review:** a fresh independent reviewer found no blocking backend issues. Two UI findings were reproduced and fixed with failing-then-passing tests: known zero totals and restored keyboard focus after renewed consent.
- **Browser limitation:** no browser is exposed to computer-use tools. An isolated preview with synthetic data booted successfully; interactive browser QA could not run. Component rendering and authenticated HTTP integration tests cover the flow.
- **Implementation adjustments:** roster preparation stays visible during the initial check, while creation stays disabled; optional web provenance fields allow older server payloads during rolling deployment. Task commits were consolidated to reduce sandbox approval interruptions.
