# Shared Venues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the free-text venue field into a search box over a shared, cross-host venue list, and link the owner's past sessions to it with a one-off script.

**Architecture:** A pure `engines/venues.ts` owns name normalization and matching (exact vs suggestion). A new server `venues` module owns the `Venue` table, the search endpoint and the find-or-create used by `SessionsService.createSession`. The create-session DTO does **not** change: the client sends venue text only, and the server resolves it by exact normalized name, so a client cannot link to an arbitrary venue id. The web gets a `venue-search` shared component wired into `group-entry`. Backfill is a function in `server/src/venues/` with a thin CLI in `server/scripts/`.

**Tech Stack:** TypeScript, node:test (engines), NestJS + Prisma 7 + SQLite + vitest (server), Angular 22 standalone + signals + vitest (web).

**Spec:** `docs/superpowers/specs/2026-10-18-shared-venues-design.md`

## Global Constraints

- Similar names are suggestions only, never auto-linked. Only an exact normalized-name match auto-links.
- No price, hours or court-fee data on a venue. Court fee entry is unchanged.
- Start flow gets no extra steps; picking a venue stays optional.
- `Session.venue` text stays and keeps being what dashboards, bill text and the display page read. Public pages show the venue name only.
- Venue search is for logged-in hosts only (no `@Public()`); `auth.boundary.spec.ts` must keep passing without adding to `PUBLIC_ROUTES`.
- Backfill touches only sessions in the mapped groups (`Bad@Mama`, `วันพฤหัส`) owned by the named host; every other group is left alone. It takes the email as an argument (nothing hardcoded), supports a dry run, and is safe to run twice. The schema migration backfills nothing.
- Thai primary, English second locale: every new label gets both `src/locale/messages.xlf` and `messages.en.xlf` entries. 44px tap targets.
- Server specs run with `fileParallelism: false`; do not change that.
- Engines stay pure and dependency-free. Web does no business logic.
- Check for undeployed migrations before rebuilding the home server (project memory). Do not deploy as part of this plan.

## Review Focus

- Host types a venue that differs from an existing one only by case or spaces (`kip` vs `K I P`): must link to the existing venue, not create a duplicate.
- Host types a venue that is whitespace-only or empty: session is created with no venue link and no error.
- Two hosts create sessions with the same brand-new venue at once: exactly one `Venue` row, both sessions linked (unique `normalizedName`).
- Search with empty or whitespace query: returns nothing, not the whole list.
- Thai input with different Unicode forms (NFC vs NFD) of the same name: treated as the same venue.
- Backfill re-run, or a session whose group has no owner or a different owner: no duplicate venues, no cross-host linking.

---

## File Structure

- Create `engines/venues.ts`, `engines/venues.test.ts`: normalization and matching.
- Modify `server/prisma/schema.prisma`; create `server/prisma/migrations/<timestamp>_shared_venues/migration.sql`.
- Create `server/src/venues/venues.module.ts`, `venues.service.ts`, `venues.controller.ts`, `backfill.ts` and specs.
- Modify `server/src/app.module.ts`, `server/src/sessions/sessions.module.ts`, `server/src/sessions/sessions.service.ts`.
- Create `server/scripts/backfill-venues.mjs`.
- Create `web/src/app/core/venue.service.ts`, `web/src/app/shared/venue-search/` (ts, html, css, spec).
- Modify `web/src/app/pages/group-entry/group-entry.html` and its spec, both `src/locale/*.xlf`.
- Modify `docs/overview.md`.

---

### Task 1: Venue normalization and matching engine

**Files:**
- Create: `engines/venues.ts`
- Test: `engines/venues.test.ts`

**Interfaces:**
- Produces:
  - `normalizeVenueName(name: string): string` — NFC, lowercase, all whitespace removed. Empty string if nothing is left.
  - `interface VenueRef { id: string; displayName: string; normalizedName: string }`
  - `interface VenueMatches { exact: VenueRef | null; suggestions: VenueRef[] }`
  - `matchVenues(typed: string, venues: VenueRef[], limit?: number): VenueMatches` — `limit` default 8.

- [ ] **Step 1: Write the failing tests** in `engines/venues.test.ts` (node:test, same style as `engines/fuzzy-match.test.ts`):
  - `normalizeVenueName('  K I P ')` equals `'kip'`; Thai NFD input equals its NFC form's result; `normalizeVenueName('   ')` equals `''`.
  - `matchVenues('kip', [{id:'1',displayName:'KIP',normalizedName:'kip'}])` gives `exact.id === '1'` and `suggestions` empty (the exact venue is not repeated in suggestions).
  - `matchVenues('kipp', [...KIP...])` gives `exact === null` and `suggestions[0].id === '1'` (similar, never exact).
  - `matchVenues('ki', [...KIP, Alpha...])` returns KIP via prefix/substring; `Alpha` is not returned.
  - `matchVenues('   ', anyList)` returns `{ exact: null, suggestions: [] }`.
  - `matchVenues` with 20 matching venues and no `limit` returns 8; order is substring matches first, then similarity-only matches, each sorted best first, ties by `displayName`.

- [ ] **Step 2: Run to verify failure**

Run: `node --experimental-strip-types --test engines/venues.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `engines/venues.ts`. Reuse `similarity` from `engines/fuzzy-match.ts` (do not duplicate Levenshtein). A venue is a suggestion if its normalized name contains the normalized query, or `similarity(query, venue) >= VENUE_SUGGEST_THRESHOLD` (export the constant, start at `0.6`; venue names are longer than player nicknames so this is higher than the player threshold). Empty normalized query short-circuits.

- [ ] **Step 4: Run to verify pass**

Run: `node --experimental-strip-types --test engines/venues.test.ts`
Expected: PASS. Then `npm run test:engines` — all pass.

- [ ] **Step 5: Commit** `git add engines/venues.ts engines/venues.test.ts && git commit -m "feat(engines): venue name normalization and matching"`

---

### Task 2: Schema and migration

**Files:**
- Modify: `server/prisma/schema.prisma` (add `Venue`, add `Session.venueId`/`venueRef`)
- Create: `server/prisma/migrations/20261018000000_shared_venues/migration.sql`
- Test: `server/src/venues/venues-migration.spec.ts`

**Interfaces:**
- Produces Prisma models: `Venue { id String @id @default(cuid()); displayName String; normalizedName String @unique; createdAt DateTime @default(now()); sessions Session[] }` and `Session.venueId String?` with relation field `venueRef Venue? @relation(fields: [venueId], references: [id], onDelete: SetNull)`.

- [ ] **Step 1: Write the failing test** `venues-migration.spec.ts`, copying the shape of `server/src/sessions/forgotten-session-migration.spec.ts`: apply every earlier migration to a temp SQLite file, insert a `Group` and two `Session` rows (one with `venue` text), apply the new `migration.sql`, and assert: both sessions survive unchanged, `venueId` is `NULL` on both, the `Venue` table exists and is empty (no backfill), inserting two venues with the same `normalizedName` throws a unique-constraint error, and `PRAGMA foreign_key_check` is empty.

- [ ] **Step 2: Run to verify failure**

Run (from `server/`): `npx vitest run src/venues/venues-migration.spec.ts`
Expected: FAIL (migration file missing).

- [ ] **Step 3: Edit the schema, then generate the migration SQL** with Prisma's create-only migrate flow against `prisma7.config.ts` (do not hand-write it unless the generator cannot run), name it `shared_venues`, and rename the directory to the timestamp above if needed so it sorts after `20261014000000_forgotten_session_closure`. Confirm the SQL is only a `CREATE TABLE "Venue"`, a unique index on `normalizedName`, and a nullable `ALTER TABLE "Session" ADD COLUMN "venueId"`. Then `npx prisma generate`.

- [ ] **Step 4: Run to verify pass** — same vitest command. Expected: PASS.

- [ ] **Step 5: Commit** `git add server/prisma server/src/venues && git commit -m "feat(server): Venue table and nullable Session.venueId"`

---

### Task 3: Venues service and search endpoint

**Files:**
- Create: `server/src/venues/venues.service.ts`, `venues.controller.ts`, `venues.module.ts`
- Modify: `server/src/app.module.ts` (import `VenuesModule`)
- Test: `server/src/venues/venues.controller.spec.ts`

**Interfaces:**
- Consumes: `matchVenues`, `normalizeVenueName`, `VenueRef` from Task 1 (import via relative path like `groups.service.ts` does for engines).
- Produces:
  - `VenuesService.search(query: string): Promise<VenueMatches>` — loads venues, runs `matchVenues`, returns only `{ id, displayName }` shaped refs on the wire.
  - `VenuesService.findOrCreate(tx: Prisma.TransactionClient, rawName: string | null): Promise<string | null>` — returns the venue id, or `null` when `rawName` is null/blank after normalization. Finds by `normalizedName`; otherwise creates with `displayName = rawName.trim()`. Uses upsert on `normalizedName` so concurrent creators converge on one row.
  - `GET /venues/search?q=` → `{ exact: { id: string; displayName: string } | null; suggestions: { id: string; displayName: string }[] }`. Authenticated, not `@Public()`.
  - `VenuesModule` exports `VenuesService`.

- [ ] **Step 1: Write the failing tests** `venues.controller.spec.ts`, shaped like `server/src/groups/create-group.spec.ts` (supertest, swapped `caller` standing in for AuthGuard):
  - seed venue `KIP`; `GET /venues/search?q=kip` → `exact.displayName === 'KIP'`, suggestions empty.
  - `GET /venues/search?q=ki` → `exact` null, suggestions contain `KIP`.
  - `GET /venues/search?q=%20%20` and a missing `q` → `{ exact: null, suggestions: [] }`, status 200.
  - `findOrCreate(prisma, ' k i p ')` returns the seeded id and the venue count is unchanged.
  - `findOrCreate` called twice concurrently with a new name (`Promise.all`) → one `Venue` row, same id returned both times.
  - `findOrCreate(prisma, '   ')` and `findOrCreate(prisma, null)` → `null`.
  - Clean up created venues in `afterEach`; use `randomUUID()` suffixes in names so parallel dev data never collides.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/venues/venues.controller.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the three files per the Interfaces block. Query param is optional; treat a missing `q` as empty. Cap the venue scan sensibly (the list is small; a full scan per request is acceptable, note that in a one-line comment).

- [ ] **Step 4: Run to verify pass** — same command, then `npx vitest run src/auth/auth.boundary.spec.ts` (the new route must be walked as an authenticated-only route and need no `PUBLIC_ROUTES` entry; if the boundary spec's route walk needs the module wired, wire it there the way `GroupsModule` is).
Expected: PASS.

- [ ] **Step 5: Commit** `git add server/src/venues server/src/app.module.ts && git commit -m "feat(server): venue search endpoint and find-or-create"`

---

### Task 4: Link venue on session creation

**Files:**
- Modify: `server/src/sessions/sessions.module.ts` (import `VenuesModule`), `server/src/sessions/sessions.service.ts` (inject `VenuesService`; in the `tx.session.create` call near line 607, add `venueId`)
- Test: add to an existing create-session spec (find with `grep -ln "createSession" server/src/sessions/*.spec.ts`); if none fits, create `server/src/sessions/session-venue.spec.ts` in the same style.

**Interfaces:**
- Consumes: `VenuesService.findOrCreate(tx, rawName)` from Task 3.
- Produces: `Session.venueId` set on every new session whose `venue` text is non-blank after normalization; `Session.venue` stored exactly as today (the DTO value, unchanged).

- [ ] **Step 1: Write the failing tests:**
  - create a session with `venue: 'Gym A'`; assert a `Venue` with `displayName 'Gym A'` exists and `session.venueId` equals its id, `session.venue === 'Gym A'`.
  - create a second session in another group with `venue: ' gym a '`; assert the same `venueId`, venue count unchanged, and `session.venue` is `' gym a '` as sent.
  - `venue: '   '` and `venue: null` → `venueId` is `null`, no `Venue` rows created.
  - Idempotent replay of the same `idempotencyKey` creates no extra venue.

- [ ] **Step 2: Run to verify failure** — `npx vitest run <that spec>`. Expected: FAIL.

- [ ] **Step 3: Implement.** Call `findOrCreate` inside the existing transaction and pass the result as `venueId` in `tx.session.create`. No DTO change.

- [ ] **Step 4: Run to verify pass** — the new spec, then `npm test` from `server/` (full server suite). Expected: PASS.

- [ ] **Step 5: Commit** `git add server/src && git commit -m "feat(server): link new sessions to a shared venue"`

---

### Task 5: Owner-scoped backfill script

**Files:**
- Create: `server/src/venues/backfill.ts`, `server/scripts/backfill-venues.mjs`
- Test: `server/src/venues/backfill.spec.ts`

**Interfaces:**
- Consumes: `normalizeVenueName` (Task 1).
- Produces:
  - `backfillVenues(prisma: PrismaService, opts: { ownerEmail: string; groupVenues: { groupName: string; venueName: string }[]; dryRun: boolean }): Promise<BackfillReport>`
  - `interface BackfillReport { ownerFound: boolean; venuesCreated: number; venuesReused: number; sessionsLinked: number; sessionTextsOverwritten: number; unmatchedGroupNames: string[]; dryRun: boolean }`
  - Rule, only over groups owned by the user whose email matches `ownerEmail` (case-insensitive):
    1. **Group mapping (owner decision, takes priority):** for a group whose `name` equals a `groupVenues[].groupName` (trimmed, case-insensitive), **every** session in it is set to that venue: `venueId` = the venue (reuse by normalized name or create with `displayName` = `venueName`), and `Session.venue` text is overwritten with `venueName`, whatever it held before (counted in `sessionTextsOverwritten` when it changed). A mapping name that matches no owned group goes in `unmatchedGroupNames` (a typo shows up in the dry run; it does not throw).
    2. **Nothing else is touched (owner decision):** the owner's other groups keep their venue text and stay unlinked; the next session they create adds its venue to the shared list through the normal create flow. There is no text-based fallback.
    - Throws `Error('owner not found: <email>')` if no user matches. When `dryRun` is true, writes nothing but returns the counts it would produce. All writes in one transaction.
  - CLI: `node scripts/backfill-venues.mjs --owner <email> --map "<group name>=<venue name>" [--map ...] [--dry-run]` (`--map` repeatable, split on the first `=`; a `--map` without `=` is a usage error). Imports the built `dist/server/src/venues/backfill.js` and `dist/server/src/prisma/prisma.service.js`, constructs `PrismaService`, awaits `onModuleInit()`, runs, prints the report as JSON, exits non-zero on error. Missing `--owner` prints usage and exits non-zero.

- [ ] **Step 1: Write the failing tests** in `backfill.spec.ts`: two hosts (`hostA`, `hostB`). `hostA` owns groups named `Bad@Mama`, `วันพฤหัส` and `Other`; `hostB` owns a group also named `Bad@Mama`; one group has `ownerId` null. Sessions: in `Bad@Mama` (A) venue text `null`, `'Gym'` and `''`; in `วันพฤหัส` text `'kip'` and `null`; in `Other` text `'KIP'`, `'kip '`, blank; the same in B's `Bad@Mama`. Run with `ownerEmail = hostA`, `groupVenues = [{Bad@Mama → Mama Badminton}, {วันพฤหัส → KIP Complex}]`. Assert:
  - every session in A's `Bad@Mama` has venue text `Mama Badminton` and the one `Venue`; every session in A's `วันพฤหัส` has `KIP Complex` (text overwritten, including the old `'kip'`); `sessionTextsOverwritten` counts only the rows whose text actually changed.
  - A's `Other` sessions (`KIP`, `kip `, blank) keep `venueId` null and their text unchanged.
  - hostB's `Bad@Mama` sessions and the ownerless group's sessions are untouched (`venueId` null, text unchanged).
  - A mapping for a group name hostA does not own appears in `unmatchedGroupNames`, no throw.
  - Dry run: report equals the real run's counts, nothing written. Second real run: `sessionsLinked === 0`, `venuesCreated === 0`, `sessionTextsOverwritten === 0`.
  - Unknown email rejects with `owner not found`; email case differing from stored still matches; group name matching ignores case and surrounding spaces.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/venues/backfill.spec.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `backfill.ts` per the rule above, then the thin `.mjs` CLI following the style of `server/scripts/backup-db.mjs` (an exported `parseArgs`, side effects only when run directly, so it can be unit-tested). Add a short spec for `parseArgs` (missing owner, `--dry-run` flag) alongside, mirroring `backup-db.spec.ts`.

- [ ] **Step 4: Run to verify pass** — both specs, then `npm run lint` from `server/`. Expected: PASS.

- [ ] **Step 5: Dry-run against the local dev DB** after `npm run build`: `node scripts/backfill-venues.mjs --owner <your email> --map "Bad@Mama=Mama Badminton" --map "วันพฤหัส=KIP Complex" --dry-run`. Expected: a JSON report with `dryRun: true`; confirm no rows changed. (The local dev DB may not have those group names; then `unmatchedGroupNames` lists both, which is fine.) Do not run it for real or on the home server in this plan; that is the owner's call after review.

- [ ] **Step 6: Commit** `git add server/src/venues server/scripts && git commit -m "feat(server): owner-scoped venue backfill script"`

---

### Task 6: Web venue search box

**Files:**
- Create: `web/src/app/core/venue.service.ts`, `web/src/app/shared/venue-search/venue-search.ts`, `.html`, `.css`, `.spec.ts`
- Modify: `web/src/app/pages/group-entry/group-entry.html` (replace the venue `<input>` at the `entry.venue` label), `group-entry.ts` (import the component), `group-entry.spec.ts`, `src/locale/messages.xlf`, `src/locale/messages.en.xlf`

**Interfaces:**
- Consumes: `GET /venues/search?q=` from Task 3.
- Produces:
  - `VenueService.search(q: string): Observable<VenueSearchResult>`; `interface VenueSearchResult { exact: VenueOption | null; suggestions: VenueOption[] }`; `interface VenueOption { id: string; displayName: string }`.
  - `<app-venue-search [(value)]="venue" />` where `value` is a `model<string>('')`. Typing updates `value` immediately (so the form always submits what is typed). After a 250 ms pause with a non-blank value, it calls `search` and lists `exact` first then `suggestions` as buttons; tapping one sets `value` to its `displayName` and closes the list. Blank value shows no list. A failed search shows no list and no error (search is a convenience, not a gate).

- [ ] **Step 1: Write the failing tests** `venue-search.spec.ts` (Angular testing HTTP backend, fake timers for the debounce): typing `ki` triggers one request after 250 ms, not before; two quick keystrokes make one request; response renders exact then suggestions as buttons with ≥44px tap target class; tapping a suggestion sets `value` and hides the list; clearing the input hides the list and sends no request; HTTP error leaves `value` and the input usable with no list. In `group-entry.spec.ts`, assert the existing venue assertions still hold (`component.venue()` set from a parse, submitted as `venue.trim() || null`).

- [ ] **Step 2: Run to verify failure** — from `web/`: `npm test` (or the single spec via the `ng test` include option). Expected: FAIL.

- [ ] **Step 3: Implement** the service and component (standalone, signals, `model()`), keep the label markup identical to today's (`@@entry.venue` "สนาม") with the component rendering only the input and list. Add Thai source strings for any new text (none expected beyond an aria-label such as "สนามที่เคยใช้" / "Known venues") with ids under `@@venueSearch.*`, then regenerate/extend both `.xlf` files the way the existing locale workflow does (run Angular's i18n extract and fill `messages.en.xlf` targets by hand).

- [ ] **Step 4: Run to verify pass** — `npm test` from `web/` (full web suite) and `npm run build` from `web/`. Expected: PASS and clean build.

- [ ] **Step 5: Commit** `git add web && git commit -m "feat(web): searchable shared venue field on roster entry"`

---

### Task 7: Docs and full verification

**Files:**
- Modify: `docs/overview.md` (add a short "Venues" subsection near the session/roster-entry material: shared list, exact normalized match auto-links, similar = suggestion only, server resolves by text, owner backfill script and how to run it)
- Modify: `docs/superpowers/specs/2026-10-18-shared-venues-design.md` status line to "implemented" once everything passes

- [ ] **Step 1:** Write the overview subsection, explaining *why* (client sends text only; fuzzy never auto-merges; backfill is a script, not a migration).
- [ ] **Step 2:** Run everything from the repo root: `npm test`. Expected: engines, server and web suites all pass.
- [ ] **Step 3:** From `server/`: `npm run lint`. Expected: clean.
- [ ] **Step 4: Commit** `git add docs && git commit -m "docs: shared venues"`

Deploying and running the real backfill on the home server are separate, owner-confirmed steps after review.

---

## Self-Review

- Spec coverage: shared searchable list (Tasks 1, 3, 6); new name becomes a venue on create (Tasks 3, 4); exact auto-link / similar suggestion only (Tasks 1, 3); optional and no extra steps (Tasks 4, 6); existing sessions keep working (nullable column, Task 2); owner-only backfill with dry run, idempotent, email argument (Task 5); logged-in only (Task 3); both locales (Task 6); overview doc (Task 7). Non-goals untouched: no price/hours fields anywhere.
- Types: `VenueRef`/`VenueMatches` (Task 1) feed `VenuesService.search` (Task 3); `findOrCreate(tx, rawName)` (Task 3) is what Task 4 calls; `BackfillReport` fields are named once (Task 5); `VenueOption`/`VenueSearchResult` (Task 6) mirror the endpoint shape from Task 3.
- Proportion: plan is a few times longer than the spec, because the spec had no file or signature detail; code blocks are absent in favour of signatures and assertions.
