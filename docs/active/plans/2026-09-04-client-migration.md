# Client Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `web/` off `localStorage` to the real NestJS API. `parser.ts`/`fuzzy-match.ts`/`pairing.ts` stop running in the browser entirely — every service method that used to read/write `localStorage` becomes an HTTP call.

**Architecture:** `RosterService` becomes a thin `HttpClient` wrapper for one-shot calls (group/players/parse/create-session). `LiveSessionService` becomes a thin action wrapper around one `httpResource<Session>` — `courts`/`waitingPlayerIds` derive from it, and `proposeMatch`/`confirmMatch`/`finishMatch` POST then `.reload()`. `SessionDashboard`/`SessionDisplay` read session/player data via `httpResource()` instead of synchronous service calls inside `computed()`. Dead code removed as a direct consequence: `web/src/app/core/history-derivation.ts` (server now derives history), `roster-review.ts`'s `resolveReviews` (server now resolves reviews) — both superseded by their server-side equivalents built in the API layer plan.

**Tech Stack:** Angular `HttpClient`/`httpResource()` (new to this app), `HttpClientTestingModule`/`HttpTestingController` for tests, RxJS `firstValueFrom` for one-shot Observable→Promise conversion.

**Spec:** `docs/active/specs/2026-09-04-client-migration-design.md`

## Global Constraints

- Run Angular commands with `PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"` prefixed, from `web/`. Run server commands the same way from `server/`.
- **`resource.value()` throws if the resource is in an error state** — confirmed by direct testing (a 404 response makes `.value()` throw `Resource is currently in an error state`, even from a template binding, not return `undefined`). Every computed/template that reads a resource's `.value()` must check `.error()` (or `.status() === 'error'`) first and use a fallback. Never write `resource.value()?.foo` unguarded.
- **The verified `httpResource()` test pattern**: `fixture.detectChanges()` (kicks off the request) → `httpMock.expectOne(url).flush(data)` → `await fixture.whenStable()` → now safe to read `.value()`/`.error()`. Calling `await fixture.whenStable()` *before* the mock request is flushed hangs indefinitely — never await stability before flushing a pending resource's request.
- **Confirmed via execution: `.reload()` (called from `proposeMatch`/`confirmMatch`/`finishMatch`/`refresh`, outside a component's own change-detection cycle) needs its own `await new Promise((r) => setTimeout(r, 0)); TestBed.tick();` before its follow-up request is registered with the mock backend** — without it, `httpMock.expectOne()` for the reload finds nothing. This applies every time this plan's own code calls `.reload()`, in both `LiveSessionService`'s own spec (raw `TestBed.inject`) and every component spec that clicks a button triggering an action.
- **`fixture.whenStable()` deadlocks on *dependent/chained* resources** — `SessionDashboard`/`SessionDisplay` each have a `playersResource` (and `SessionDisplay` a `groupResource`) whose URL is computed from `session()?.groupCode`. The instant the session resource settles, Angular's reactivity fires the now-defined dependent request *as part of that same settling pass* — `whenStable()` won't return until that new request is also handled, but the test hasn't gotten control back yet to flush it. Fixed the same way as the `.reload()` case: replace the `await fixture.whenStable()` that immediately follows flushing the *parent* resource with the explicit `setTimeout(0)` + `TestBed.tick()` pair, then `expectOne` the dependent resource's request. `whenStable()` stays safe for the *last* resource in a chain (nothing fires after it settles).
- **`GroupEntry.parse()` awaits two sequential HTTP calls** (`parseRoster`, then `getPlayers`) — the second request isn't issued until the first `firstValueFrom` promise's continuation runs, which needs a microtask tick. Insert `await new Promise((r) => setTimeout(r, 0));` between flushing the parse response and expecting the players request in every test that exercises a successful `parse()`.
- **`CourtPanel`'s template reads `court().status` unconditionally** (`@switch (c.status)`), which crashes (`Cannot read properties of undefined`) during the real async window where `courts()` is still `[]` (before the session resource resolves) — impossible under the old synchronous `localStorage` code, but real once loading is async. `court` must fall back to `{status: 'idle'}` when `courts()[courtNumber() - 1]` is `undefined`, even though `SessionDashboard`'s own `courtNumbers()` normally prevents a `CourtPanel` from existing before data loads — a standalone-tested (or otherwise independently rendered) `CourtPanel` needs to survive that window on its own.
- `confirmRoster()`'s `router.navigateByUrl` is async — after `await`ing its own `firstValueFrom`-based promise, a test asserting `router.url` still needs one more `await fixture.whenStable()` for the navigation itself to land (the same class of bug already fixed once earlier this session for the pre-migration synchronous `GroupEntry`, resurfacing here for the same underlying reason).
- **`nest start` assumes the default `dist/main` entry point** and fails (`MODULE_NOT_FOUND`) on this project's widened `rootDir` (from the scaffold plan), whose real entry is `dist/server/src/main.js`. For manual runs, `nest build` then run `node dist/server/src/main.js` directly. Also: the compiled runtime does not load `.env` on its own (only the Prisma CLI and Vitest do) — export `DATABASE_URL` in the shell, or the app throws `TypeError: Cannot read properties of undefined (reading 'replace')` trying to open the (undefined) database URL. Both are pre-existing gaps from earlier plans, not something this plan's scope covers fixing — noted here because Task 7's manual CORS check is what surfaces them.
- **This migration's tasks intentionally leave the full app red between Task 2 and Task 7.** Changing `RosterService`'s public API (Task 2) breaks every consumer's compilation until each is migrated in turn. Each task's own spec file(s) must pass at that task's own verification step — but do **not** run the whole-app `ng build`/`ng test` until Task 7 completes; a partial build failure between tasks is expected, not a regression to chase.
- `import type` for `Player`/`NameMatch`/`RosterNameMatch` from the root-level `fuzzy-match.ts` stays fine to use for typing (fully erased at compile time) — but no file in `web/` may import `matchName`/`matchRoster`/`confirmExistingPlayerAlias`/`createNewPlayer`/`parseLineRosterMessage`/`generateRound` as *runtime* values after this plan completes. If any task still needs one of those imported as a value, something in this plan's design is wrong — stop and reconsider rather than pushing through.
- `environment.apiBaseUrl` is `http://localhost:3000` for local dev — this plan does not add a production environment file or build configuration; that's out of scope (see spec's Non-goals).

---

## File Structure

- Modify: `server/src/sessions/sessions.service.ts`, `server/src/sessions/sessions.controller.spec.ts`, `server/src/main.ts` (Task 1).
- Create: `web/src/environments/environment.ts`.
- Modify: `web/src/app/app.config.ts`, `web/src/app/core/session.model.ts`, `web/src/app/core/live-session.model.ts`.
- Rewrite: `web/src/app/core/roster.service.ts`, `web/src/app/core/roster.service.spec.ts`.
- Rewrite: `web/src/app/core/live-session.service.ts`, `web/src/app/core/live-session.service.spec.ts`.
- Delete: `web/src/app/core/history-derivation.ts`, `web/src/app/core/history-derivation.spec.ts`.
- Rewrite: `web/src/app/core/roster-review.ts`, `web/src/app/core/roster-review.spec.ts`.
- Rewrite: `web/src/app/pages/group-entry/group-entry.ts`, `web/src/app/pages/group-entry/group-entry.spec.ts`.
- Rewrite: `web/src/app/pages/session-dashboard/session-dashboard.ts`, `web/src/app/pages/session-dashboard/session-dashboard.spec.ts`.
- Rewrite: `web/src/app/pages/session-dashboard/court-panel/court-panel.ts`, `web/src/app/pages/session-dashboard/court-panel/court-panel.spec.ts`.
- Rewrite: `web/src/app/pages/session-display/session-display.ts`, `web/src/app/pages/session-display/session-display.spec.ts`.

`.html`/`.css` template files are **not** modified anywhere in this plan — every migrated component keeps the same public property/method names, so existing templates keep working unchanged (an `async` method behind a `(click)` handler works identically to a `void` one from the template's perspective).

---

### Task 1: Server — expose `pairingId`, enable CORS

**Files:**
- Modify: `server/src/sessions/sessions.service.ts`
- Modify: `server/src/sessions/sessions.controller.spec.ts`
- Modify: `server/src/main.ts`

**Interfaces:**
- Produces: `GET /sessions/:code`'s `pending`/`active` court entries now include `pairingId: string` — Task 3's `LiveSessionService`/`CourtState` design depends on this field existing.

- [ ] **Step 1: Write the failing assertion**

Modify `server/src/sessions/sessions.controller.spec.ts`'s `'derives court status from Pairing rows'` test — change the `active` court's expected object to include `pairingId`:

```ts
      expect(res.body.courts).toEqual([
        {
          courtNumber: 1,
          status: 'active',
          pairingId: expect.any(String),
          teamA: [players[0].id, players[1].id],
          teamB: [players[2].id, players[3].id],
        },
        { courtNumber: 2, status: 'idle' },
      ]);
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npm test
```

Expected: FAIL — the actual response object has no `pairingId` key, so `toEqual` (exact shape match) fails.

- [ ] **Step 3: Add `pairingId` to the derivation**

Modify `server/src/sessions/sessions.service.ts`'s `getSession` method:

```ts
      return current.confirmedAt
        ? { courtNumber, status: 'active' as const, pairingId: current.id, teamA, teamB }
        : { courtNumber, status: 'pending' as const, pairingId: current.id, teamA, teamB };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npm test
```

Expected: PASS, full suite (this doesn't touch anything else).

- [ ] **Step 5: Enable CORS**

Modify `server/src/main.ts` — add `app.enableCors();` right after `NestFactory.create(AppModule)`:

```ts
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
```

No test for this — it's not observable from within NestJS's own test suite (which calls the app in-process, not cross-origin). Verified manually in Task 7's final check instead, when the real Angular dev server talks to the real NestJS dev server.

- [ ] **Step 6: Verify full suite and build, then commit**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx nest build
rm -rf dist
git add server/src/sessions/sessions.service.ts server/src/sessions/sessions.controller.spec.ts server/src/main.ts
git commit -m "feat: expose Pairing id on GET /sessions/:code, enable CORS"
```

---

### Task 2: `RosterService` migration

**Files:**
- Create: `web/src/environments/environment.ts`
- Modify: `web/src/app/app.config.ts`
- Modify: `web/src/app/core/session.model.ts`
- Modify: `web/src/app/core/live-session.model.ts`
- Rewrite: `web/src/app/core/roster.service.ts`
- Rewrite: `web/src/app/core/roster.service.spec.ts`

**Interfaces:**
- Produces: `RosterService.getGroup(code): Observable<Group>`, `.renameGroup(code, name): Observable<{code, name}>`, `.getPlayers(groupCode): Observable<Player[]>`, `.createSession(dto: CreateSessionRequest): Observable<{code: string}>`, `.parseRoster(code, groupName, rawText): Observable<ParseRosterResponse>` — Task 4 (`GroupEntry`) is the sole consumer of every one of these.
- `RosterService.getSession` is deliberately **not** included — no consumer needs an imperative one-shot session fetch after this plan; `LiveSessionService` (Task 3) reads sessions reactively via its own `httpResource`, bypassing `RosterService` entirely for that path.

- [ ] **Step 1: Add HttpClient + environment**

Create `web/src/environments/environment.ts`:

```ts
export const environment = {
  apiBaseUrl: 'http://localhost:3000',
};
```

Modify `web/src/app/app.config.ts`:

```ts
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(),
    provideRouter(routes)
  ]
};
```

- [ ] **Step 2: Update the models**

Modify `web/src/app/core/live-session.model.ts` — add `pairingId` to the non-idle variants:

```ts
export type CourtState =
  | { status: 'idle' }
  | { status: 'pending'; pairingId: string; teamA: [string, string]; teamB: [string, string] }
  | { status: 'active'; pairingId: string; teamA: [string, string]; teamB: [string, string] };
```

(`MatchRecord` is deleted from this file — nothing constructs one anymore once `LiveSessionService` stops tracking match history client-side; Task 3 removes its last usage.)

Modify `web/src/app/core/session.model.ts` — add `courts`:

```ts
import type { CourtState } from './live-session.model';

export interface Session {
  code: string;
  groupCode: string;
  date: string | null;
  venue: string | null;
  courtCount: number | null;
  rawImportText: string;
  rosterPlayerIds: string[];
  waitlistPlayerIds: string[];
  courts: CourtState[];
}
```

- [ ] **Step 3: Write the failing test**

Replace `web/src/app/core/roster.service.spec.ts` entirely:

```ts
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { RosterService } from './roster.service';
import { environment } from '../../environments/environment';

describe('RosterService', () => {
  let service: RosterService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(RosterService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('getGroup requests GET /groups/:code', () => {
    let result: unknown;
    service.getGroup('group1').subscribe((g) => (result = g));

    const req = httpMock.expectOne(`${environment.apiBaseUrl}/groups/group1`);
    expect(req.request.method).toBe('GET');
    req.flush({ code: 'group1', name: 'Group A', lastSessionCode: null });

    expect(result).toEqual({ code: 'group1', name: 'Group A', lastSessionCode: null });
  });

  it('renameGroup sends PUT /groups/:code with just the new name', () => {
    let result: unknown;
    service.renameGroup('group1', 'New Name').subscribe((g) => (result = g));

    const req = httpMock.expectOne(`${environment.apiBaseUrl}/groups/group1`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ name: 'New Name' });
    req.flush({ code: 'group1', name: 'New Name' });

    expect(result).toEqual({ code: 'group1', name: 'New Name' });
  });

  it('getPlayers requests GET /groups/:code/players', () => {
    let result: unknown;
    service.getPlayers('group1').subscribe((p) => (result = p));

    const req = httpMock.expectOne(`${environment.apiBaseUrl}/groups/group1/players`);
    expect(req.request.method).toBe('GET');
    req.flush([{ id: 'p1', name: 'ตั้ม', aliases: [] }]);

    expect(result).toEqual([{ id: 'p1', name: 'ตั้ม', aliases: [] }]);
  });

  it('createSession sends POST /sessions with the given body', () => {
    let result: unknown;
    const dto = {
      groupCode: 'group1',
      date: '2026-09-08',
      venue: 'KIP',
      courtCount: 2,
      rawImportText: '1. ตั้ม',
      rosterReviews: [],
      waitlistReviews: [],
    };
    service.createSession(dto).subscribe((r) => (result = r));

    const req = httpMock.expectOne(`${environment.apiBaseUrl}/sessions`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(dto);
    req.flush({ code: 'sess1' });

    expect(result).toEqual({ code: 'sess1' });
  });

  it('parseRoster sends POST /groups/:code/parse', () => {
    let result: unknown;
    service.parseRoster('group1', 'Group A', '1. ตั้ม').subscribe((r) => (result = r));

    const req = httpMock.expectOne(`${environment.apiBaseUrl}/groups/group1/parse`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ groupName: 'Group A', rawText: '1. ตั้ม' });
    const response = {
      header: { isoDate: null, venue: null, courtCount: null },
      rosterReviews: [{ inputName: 'ตั้ม', match: { type: 'new' } }],
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    };
    req.flush(response);

    expect(result).toEqual(response);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
cd web && PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false --include='**/roster.service.spec.ts'
```

Expected: FAIL — `RosterService` still has its old `localStorage`-backed methods (`savePlayers`, `getSession`, etc.), none of which match this spec's expectations, and it takes no `HttpClient`.

- [ ] **Step 5: Rewrite `RosterService`**

Replace `web/src/app/core/roster.service.ts` entirely:

```ts
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { environment } from '../../environments/environment';
import type { Player, RosterNameMatch } from '../../../../fuzzy-match.ts';
import type { Group } from './group.model';
import type { NameReview } from './roster-review';

export interface CreateSessionRequest {
  groupCode: string;
  date: string | null;
  venue: string | null;
  courtCount: number | null;
  rawImportText: string;
  rosterReviews: NameReview[];
  waitlistReviews: NameReview[];
}

export interface ParseRosterResponse {
  header: { isoDate: string | null; venue: string | null; courtCount: number | null };
  rosterReviews: RosterNameMatch[];
  waitlistReviews: RosterNameMatch[];
  warnings: string[];
  unrecognizedLines: string[];
}

@Injectable({ providedIn: 'root' })
export class RosterService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiBaseUrl;

  getGroup(code: string) {
    return this.http.get<Group>(`${this.base}/groups/${code}`);
  }

  renameGroup(code: string, name: string) {
    return this.http.put<{ code: string; name: string | null }>(
      `${this.base}/groups/${code}`,
      { name }
    );
  }

  getPlayers(groupCode: string) {
    return this.http.get<Player[]>(`${this.base}/groups/${groupCode}/players`);
  }

  createSession(dto: CreateSessionRequest) {
    return this.http.post<{ code: string }>(`${this.base}/sessions`, dto);
  }

  parseRoster(code: string, groupName: string, rawText: string) {
    return this.http.post<ParseRosterResponse>(`${this.base}/groups/${code}/parse`, {
      groupName,
      rawText,
    });
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false --include='**/roster.service.spec.ts'
```

Expected: PASS. The rest of `web/` will not compile yet — per Global Constraints, that's expected until Task 7.

- [ ] **Step 7: Commit**

```bash
git add web/src/environments web/src/app/app.config.ts web/src/app/core/session.model.ts web/src/app/core/live-session.model.ts web/src/app/core/roster.service.ts web/src/app/core/roster.service.spec.ts
git commit -m "feat: migrate RosterService to HttpClient"
```

---

### Task 3: `LiveSessionService` migration

**Files:**
- Rewrite: `web/src/app/core/live-session.service.ts`
- Rewrite: `web/src/app/core/live-session.service.spec.ts`
- Delete: `web/src/app/core/history-derivation.ts`
- Delete: `web/src/app/core/history-derivation.spec.ts`

**Interfaces:**
- Consumes: `RosterService`'s `renameGroup`/`getGroup`/`getPlayers`/`createSession`/`parseRoster` are unrelated to this service — `LiveSessionService` needs none of them; it talks to `/sessions/:code/...` directly.
- Produces: `LiveSessionService.sessionResource: HttpResourceRef<Session>`, `.courts: Signal<CourtState[]>`, `.waitingPlayerIds: Signal<string[]>`, `.refresh(): void`, `.proposeMatch(courtNumber): Promise<boolean>`, `.confirmMatch(pairingId): Promise<void>`, `.finishMatch(pairingId, scoreA, scoreB): Promise<void>` — Task 5 (`SessionDashboard`), Task 6 (`CourtPanel`), and Task 7 (`SessionDisplay`) all depend on this exact shape. **`confirmMatch`/`finishMatch` now take a `pairingId: string`, not a `courtNumber`** — a real, necessary signature change (the server needs the `Pairing` row's id, which a court number alone doesn't give it).

- [ ] **Step 1: Delete the now-dead history derivation**

```bash
rm web/src/app/core/history-derivation.ts web/src/app/core/history-derivation.spec.ts
```

The server has its own copy (`server/src/sessions/derive-history.ts`, built in the API layer plan) — this client copy has no caller once `generateRound`/history-building moves fully server-side.

- [ ] **Step 2: Write the failing test**

Replace `web/src/app/core/live-session.service.spec.ts` entirely:

```ts
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { LiveSessionService } from './live-session.service';
import { environment } from '../../environments/environment';
import type { Session } from './session.model';

function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    code: 'sess1',
    groupCode: 'group1',
    date: '2026-09-08',
    venue: null,
    courtCount: 1,
    rawImportText: '',
    rosterPlayerIds: ['p1', 'p2', 'p3', 'p4'],
    waitlistPlayerIds: [],
    courts: [{ status: 'idle' }],
    ...overrides,
  };
}

describe('LiveSessionService', () => {
  let service: LiveSessionService;
  let httpMock: HttpTestingController;

  function setUp() {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        LiveSessionService,
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ sessionCode: 'sess1' }) } },
        },
      ],
    });
    service = TestBed.inject(LiveSessionService);
    httpMock = TestBed.inject(HttpTestingController);
  }

  async function flushSession(session: Session) {
    TestBed.tick();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`).flush(session);
    await new Promise((r) => setTimeout(r, 0));
  }

  beforeEach(() => {
    setUp();
  });

  it('exposes courts from the fetched session', async () => {
    await flushSession(baseSession());
    expect(service.courts()).toEqual([{ status: 'idle' }]);
  });

  it('proposeMatch posts to the propose endpoint and reloads the session', async () => {
    await flushSession(baseSession());

    const promise = service.proposeMatch(1);
    const proposeReq = httpMock.expectOne(
      `${environment.apiBaseUrl}/sessions/sess1/courts/1/propose`
    );
    expect(proposeReq.request.method).toBe('POST');
    proposeReq.flush({
      ok: true,
      pairing: { id: 'pair1', courtNumber: 1, matchNumber: 1, teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] },
    });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();

    const reloadReq = httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`);
    reloadReq.flush(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );

    expect(await promise).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(service.courts()).toEqual([
      { status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] },
    ]);
  });

  it('proposeMatch returns false when the server reports not-enough-players', async () => {
    await flushSession(baseSession());

    const promise = service.proposeMatch(1);
    httpMock
      .expectOne(`${environment.apiBaseUrl}/sessions/sess1/courts/1/propose`)
      .flush({ ok: false, reason: 'not-enough-players' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`).flush(baseSession());

    expect(await promise).toBe(false);
  });

  it('confirmMatch posts to the confirm endpoint with the given pairingId and reloads', async () => {
    await flushSession(baseSession());

    const promise = service.confirmMatch('pair1');
    const confirmReq = httpMock.expectOne(
      `${environment.apiBaseUrl}/sessions/sess1/pairings/pair1/confirm`
    );
    expect(confirmReq.request.method).toBe('POST');
    confirmReq.flush({});
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`).flush(baseSession());

    await promise;
  });

  it('finishMatch posts scores to the finish endpoint and reloads', async () => {
    await flushSession(baseSession());

    const promise = service.finishMatch('pair1', 21, 15);
    const finishReq = httpMock.expectOne(
      `${environment.apiBaseUrl}/sessions/sess1/pairings/pair1/finish`
    );
    expect(finishReq.request.method).toBe('POST');
    expect(finishReq.request.body).toEqual({ scoreA: 21, scoreB: 15 });
    finishReq.flush({});
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`).flush(baseSession());

    await promise;
  });

  it('waitingPlayerIds excludes players on non-idle courts', async () => {
    await flushSession(
      baseSession({
        rosterPlayerIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
        courts: [{ status: 'active', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    expect(service.waitingPlayerIds().sort()).toEqual(['p5', 'p6']);
  });

  it('refresh triggers a reload', async () => {
    await flushSession(baseSession());
    service.refresh();
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/sess1`).flush(baseSession());
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false --include='**/live-session.service.spec.ts'
```

Expected: FAIL — the current `LiveSessionService` has no `sessionResource`, and its `proposeMatch`/`confirmMatch`/`finishMatch` are synchronous `localStorage`-backed methods with the old `(courtNumber, random?)`/`(courtNumber)` signatures.

- [ ] **Step 4: Rewrite `LiveSessionService`**

Replace `web/src/app/core/live-session.service.ts` entirely:

```ts
import { HttpClient, httpResource } from '@angular/common/http';
import { Injectable, computed, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import type { CourtState } from './live-session.model';
import type { Session } from './session.model';

interface ProposeResponse {
  ok: boolean;
  reason?: string;
}

@Injectable()
export class LiveSessionService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiBaseUrl;
  private readonly sessionCode: string;

  readonly sessionResource: ReturnType<typeof httpResource<Session>>;

  readonly courts = computed<CourtState[]>(() => {
    if (this.sessionResource.error()) return [];
    return this.sessionResource.value()?.courts ?? [];
  });

  readonly waitingPlayerIds = computed(() => {
    if (this.sessionResource.error()) return [];
    const session = this.sessionResource.value();
    if (!session) return [];
    const reserved = new Set<string>();
    for (const court of this.courts()) {
      if (court.status === 'idle') continue;
      reserved.add(court.teamA[0]);
      reserved.add(court.teamA[1]);
      reserved.add(court.teamB[0]);
      reserved.add(court.teamB[1]);
    }
    return session.rosterPlayerIds.filter((id) => !reserved.has(id));
  });

  constructor(route: ActivatedRoute) {
    this.sessionCode = route.snapshot.paramMap.get('sessionCode')!;
    this.sessionResource = httpResource<Session>(() => `${this.base}/sessions/${this.sessionCode}`);
  }

  refresh(): void {
    this.sessionResource.reload();
  }

  async proposeMatch(courtNumber: number): Promise<boolean> {
    const response = await firstValueFrom(
      this.http.post<ProposeResponse>(
        `${this.base}/sessions/${this.sessionCode}/courts/${courtNumber}/propose`,
        {}
      )
    );
    this.sessionResource.reload();
    return response.ok;
  }

  async confirmMatch(pairingId: string): Promise<void> {
    await firstValueFrom(
      this.http.post(`${this.base}/sessions/${this.sessionCode}/pairings/${pairingId}/confirm`, {})
    );
    this.sessionResource.reload();
  }

  async finishMatch(pairingId: string, scoreA: number | null, scoreB: number | null): Promise<void> {
    await firstValueFrom(
      this.http.post(`${this.base}/sessions/${this.sessionCode}/pairings/${pairingId}/finish`, {
        scoreA,
        scoreB,
      })
    );
    this.sessionResource.reload();
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false --include='**/live-session.service.spec.ts'
```

Expected: PASS. If `sessionResource.reload()` doesn't pick up in time for an assertion, add the same `await new Promise((r) => setTimeout(r, 0));` used elsewhere in this spec after the reload's mock request is flushed — this is the verified, necessary pattern for resource settling in tests (see Global Constraints).

- [ ] **Step 6: Commit**

```bash
git add web/src/app/core/live-session.service.ts web/src/app/core/live-session.service.spec.ts
git rm web/src/app/core/history-derivation.ts web/src/app/core/history-derivation.spec.ts
git commit -m "feat: migrate LiveSessionService to httpResource, remove dead history-derivation"
```

---

### Task 4: `GroupEntry` migration

**Files:**
- Rewrite: `web/src/app/core/roster-review.ts`
- Rewrite: `web/src/app/core/roster-review.spec.ts`
- Rewrite: `web/src/app/pages/group-entry/group-entry.ts`
- Rewrite: `web/src/app/pages/group-entry/group-entry.spec.ts`

**Interfaces:**
- Consumes: `RosterService.getGroup`/`.renameGroup`/`.parseRoster`/`.getPlayers`/`.createSession` (all from Task 2).
- `group-entry.html` is unchanged — `GroupEntry` keeps every property/method name the template already binds to.

- [ ] **Step 1: Write the failing test for `roster-review.ts`**

Replace `web/src/app/core/roster-review.spec.ts` entirely:

```ts
import { attachDecisions } from './roster-review';
import type { RosterNameMatch } from '../../../../fuzzy-match.ts';

describe('attachDecisions', () => {
  it('defaults every review to accept', () => {
    const matches: RosterNameMatch[] = [
      { inputName: 'ตั้ม', match: { type: 'exact', playerId: 'p1' } },
      { inputName: 'เกียร์', match: { type: 'new' } },
    ];
    expect(attachDecisions(matches)).toEqual([
      { inputName: 'ตั้ม', match: { type: 'exact', playerId: 'p1' }, decision: 'accept' },
      { inputName: 'เกียร์', match: { type: 'new' }, decision: 'accept' },
    ]);
  });

  it('preserves input order', () => {
    const matches: RosterNameMatch[] = [
      { inputName: 'a', match: { type: 'new' } },
      { inputName: 'b', match: { type: 'new' } },
    ];
    expect(attachDecisions(matches).map((r) => r.inputName)).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false --include='**/roster-review.spec.ts'
```

Expected: FAIL — `roster-review.ts` exports `buildReviews`/`resolveReviews`, not `attachDecisions`.

- [ ] **Step 3: Rewrite `roster-review.ts`**

Replace `web/src/app/core/roster-review.ts` entirely:

```ts
import type { NameMatch, RosterNameMatch } from '../../../../fuzzy-match.ts';

export interface NameReview {
  inputName: string;
  match: NameMatch;
  decision: 'accept' | 'reject-new';
}

export function attachDecisions(reviews: RosterNameMatch[]): NameReview[] {
  return reviews.map((r) => ({ ...r, decision: 'accept' as const }));
}
```

(`resolveReviews`/`confirmExistingPlayerAlias`/`createNewPlayer` are gone — the server resolves reviews now, inside `POST /sessions`.)

- [ ] **Step 4: Run the test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false --include='**/roster-review.spec.ts'
```

Expected: PASS.

- [ ] **Step 5: Write the failing test for `GroupEntry`**

Replace `web/src/app/pages/group-entry/group-entry.spec.ts` entirely:

```ts
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { GroupEntry } from './group-entry';
import { routes } from '../../app.routes';
import { environment } from '../../../environments/environment';

const B = environment.apiBaseUrl;

describe('GroupEntry', () => {
  let component: GroupEntry;
  let fixture: ComponentFixture<GroupEntry>;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GroupEntry],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter(routes),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ groupCode: 'group1' }) } },
        },
      ],
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(GroupEntry);
    component = fixture.componentInstance;

    // Constructor fires GET /groups/group1 - respond 404 (brand-new group) by
    // default; tests that need a pre-existing group flush a real body instead.
    httpMock.expectOne(`${B}/groups/group1`).flush('Not Found', { status: 404, statusText: 'Not Found' });
    await fixture.whenStable();
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('starts in the paste state', () => {
    expect(component.state()).toBe('paste');
  });

  it('groupName is empty when no Group exists yet', () => {
    expect(component.groupName()).toBe('');
  });

  it('lastSessionCode is null when no Group exists yet', () => {
    expect(component.lastSessionCode()).toBeNull();
  });

  it('parse shows an error and stays in the paste state when the group name is empty', async () => {
    component.groupName.set('');
    component.rawText.set('1. ตั้ม');
    await component.parse();

    expect(component.state()).toBe('paste');
    expect(component.pasteError()).toContain('group name');
  });

  it('parse shows an error and stays in the paste state when nothing has been pasted', async () => {
    component.groupName.set('Group A');
    component.rawText.set('   ');
    await component.parse();

    expect(component.state()).toBe('paste');
    expect(component.pasteError()).toContain('Paste a roster message');
  });

  it('parse shows an error when the server reports no recognized roster', async () => {
    component.groupName.set('Group A');
    component.rawText.set('ไกด์\nเตย');

    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: null, venue: null, courtCount: null },
      rosterReviews: [],
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await parsePromise;

    expect(component.state()).toBe('paste');
    expect(component.pasteError()).toContain('No players were recognized');
  });

  it('a successful parse switches to confirm, prefilling header fields and reviews', async () => {
    component.groupName.set('Group A');
    component.rawText.set('1. ตั้ม\n2. เกียร์');

    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: '2026-09-08', venue: 'KIP', courtCount: 2 },
      rosterReviews: [
        { inputName: 'ตั้ม', match: { type: 'exact', playerId: 'p1' } },
        { inputName: 'เกียร์', match: { type: 'new' } },
      ],
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    httpMock.expectOne(`${B}/groups/group1/players`).flush([{ id: 'p1', name: 'ตั้ม', aliases: [] }]);
    await parsePromise;

    expect(component.state()).toBe('confirm');
    expect(component.date()).toBe('2026-09-08');
    expect(component.venue()).toBe('KIP');
    expect(component.courtCount()).toBe(2);
    expect(component.rosterReviews()).toEqual([
      { inputName: 'ตั้ม', match: { type: 'exact', playerId: 'p1' }, decision: 'accept' },
      { inputName: 'เกียร์', match: { type: 'new' }, decision: 'accept' },
    ]);
  });

  it('resolves a fuzzy suggestion to the matched player name via playerName()', async () => {
    component.groupName.set('Group A');
    component.rawText.set('1. ตัม');

    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: null, venue: null, courtCount: null },
      rosterReviews: [{ inputName: 'ตัม', match: { type: 'fuzzy', playerId: 'p1', score: 0.8 } }],
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    httpMock.expectOne(`${B}/groups/group1/players`).flush([{ id: 'p1', name: 'ตั้ม', aliases: [] }]);
    await parsePromise;

    expect(component.playerName('p1')).toBe('ตั้ม');
  });

  it('toggleDecision flips a review between accept and reject-new', async () => {
    component.groupName.set('Group A');
    component.rawText.set('1. ตัม');

    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: null, venue: null, courtCount: null },
      rosterReviews: [{ inputName: 'ตัม', match: { type: 'fuzzy', playerId: 'p1', score: 0.8 } }],
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    await parsePromise;

    const review = component.rosterReviews()[0];
    expect(review.decision).toBe('accept');
    component.toggleDecision(review);
    expect(component.rosterReviews()[0].decision).toBe('reject-new');
  });

  it('canConfirm is false until date and courtCount are set', async () => {
    component.groupName.set('Group A');
    component.rawText.set('1. ตั้ม');
    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: null, venue: null, courtCount: null },
      rosterReviews: [{ inputName: 'ตั้ม', match: { type: 'new' } }],
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    await parsePromise;

    expect(component.canConfirm()).toBe(false);
    component.date.set('2026-09-08');
    component.courtCount.set(2);
    expect(component.canConfirm()).toBe(true);
  });

  it('confirmRoster posts the resolved reviews and navigates to the new session', async () => {
    const router = TestBed.inject(Router);
    component.groupName.set('Group A');
    component.rawText.set('1. ตั้ม');
    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: null, venue: null, courtCount: null },
      rosterReviews: [{ inputName: 'ตั้ม', match: { type: 'new' } }],
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    await parsePromise;

    component.date.set('2026-09-08');
    component.courtCount.set(2);
    component.venue.set('KIP');

    const confirmPromise = component.confirmRoster();
    const req = httpMock.expectOne(`${B}/sessions`);
    expect(req.request.body).toMatchObject({
      groupCode: 'group1',
      date: '2026-09-08',
      venue: 'KIP',
      courtCount: 2,
    });
    req.flush({ code: 'sess1' });
    await confirmPromise;
    await fixture.whenStable();

    expect(router.url).toBe('/s/sess1');
  });

  it('confirmRoster trims a whitespace-only venue to null', async () => {
    component.groupName.set('Group A');
    component.rawText.set('1. ตั้ม');
    const parsePromise = component.parse();
    httpMock.expectOne(`${B}/groups/group1/parse`).flush({
      header: { isoDate: null, venue: null, courtCount: null },
      rosterReviews: [{ inputName: 'ตั้ม', match: { type: 'new' } }],
      waitlistReviews: [],
      warnings: [],
      unrecognizedLines: [],
    });
    await new Promise((r) => setTimeout(r, 0));
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    await parsePromise;

    component.date.set('2026-09-08');
    component.courtCount.set(1);
    component.venue.set('   ');

    const confirmPromise = component.confirmRoster();
    const req = httpMock.expectOne(`${B}/sessions`);
    expect(req.request.body).toMatchObject({ venue: null });
    req.flush({ code: 'sess1' });
    await confirmPromise;
  });

  it('saveGroupName sends the group name via renameGroup', () => {
    component.groupName.set('Group A');
    component.saveGroupName();

    const req = httpMock.expectOne(`${B}/groups/group1`);
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ name: 'Group A' });
    req.flush({ code: 'group1', name: 'Group A' });
  });
});

describe('GroupEntry with an existing group', () => {
  let fixture: ComponentFixture<GroupEntry>;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GroupEntry],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter(routes),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ groupCode: 'group1' }) } },
        },
      ],
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(GroupEntry);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('prefills groupName and lastSessionCode from the fetched Group', async () => {
    httpMock
      .expectOne(`${environment.apiBaseUrl}/groups/group1`)
      .flush({ code: 'group1', name: 'Group A', lastSessionCode: 'sess1' });
    await fixture.whenStable();

    expect(fixture.componentInstance.groupName()).toBe('Group A');
    expect(fixture.componentInstance.lastSessionCode()).toBe('sess1');
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false --include='**/group-entry.spec.ts'
```

Expected: FAIL to compile — `GroupEntry` still imports `parseLineRosterMessage` directly and calls the old synchronous `RosterService` methods.

- [ ] **Step 7: Rewrite `GroupEntry`**

Replace `web/src/app/pages/group-entry/group-entry.ts` entirely:

```ts
import { Component, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { attachDecisions, type NameReview } from '../../core/roster-review';
import { RosterService } from '../../core/roster.service';
import { resolvePlayerNames } from '../../core/player-names';
import type { Player } from '../../../../../fuzzy-match.ts';

@Component({
  selector: 'app-group-entry',
  imports: [FormsModule, RouterLink],
  templateUrl: './group-entry.html',
  styleUrl: './group-entry.css',
})
export class GroupEntry {
  protected readonly groupCode: string;
  readonly state = signal<'paste' | 'confirm'>('paste');
  readonly rawText = signal('');
  readonly date = signal('');
  readonly venue = signal('');
  readonly courtCount = signal<number | null>(null);
  readonly rosterReviews = signal<NameReview[]>([]);
  readonly waitlistReviews = signal<NameReview[]>([]);
  readonly groupName = signal('');
  readonly lastSessionCode = signal<string | null>(null);
  readonly warnings = signal<string[]>([]);
  readonly unrecognizedLines = signal<string[]>([]);
  readonly pasteError = signal<string | null>(null);

  private players: Player[] = [];

  constructor(
    route: ActivatedRoute,
    private rosterService: RosterService,
    private router: Router
  ) {
    this.groupCode = route.snapshot.paramMap.get('groupCode')!;
    this.rosterService.getGroup(this.groupCode).subscribe({
      next: (group) => {
        this.groupName.set(group.name ?? '');
        this.lastSessionCode.set(group.lastSessionCode);
      },
      error: () => {
        // Brand-new group - nothing to prefill, stays at defaults.
      },
    });
  }

  saveGroupName(): void {
    if (!this.groupName().trim()) return;
    this.rosterService.renameGroup(this.groupCode, this.groupName()).subscribe();
  }

  playerName(id: string): string {
    return resolvePlayerNames([id], this.players)[0];
  }

  async parse(): Promise<void> {
    this.pasteError.set(null);

    if (!this.groupName().trim()) {
      this.pasteError.set('Please enter a group name first.');
      return;
    }
    if (!this.rawText().trim()) {
      this.pasteError.set('Paste a roster message first.');
      return;
    }

    const result = await firstValueFrom(
      this.rosterService.parseRoster(this.groupCode, this.groupName(), this.rawText())
    );

    if (result.rosterReviews.length === 0) {
      this.pasteError.set(
        'No players were recognized — check that each name is on its own numbered line (e.g. "1. name").'
      );
      return;
    }

    this.date.set(result.header.isoDate ?? '');
    this.venue.set(result.header.venue ?? '');
    this.courtCount.set(result.header.courtCount);
    this.warnings.set(result.warnings);
    this.unrecognizedLines.set(result.unrecognizedLines);

    this.rosterReviews.set(attachDecisions(result.rosterReviews));
    this.waitlistReviews.set(attachDecisions(result.waitlistReviews));

    this.players = await firstValueFrom(this.rosterService.getPlayers(this.groupCode));

    this.state.set('confirm');
  }

  canConfirm(): boolean {
    return (
      this.date().length > 0 &&
      this.courtCount() !== null &&
      this.courtCount()! > 0 &&
      this.rosterReviews().length > 0
    );
  }

  toggleDecision(review: NameReview): void {
    const flip = (reviews: NameReview[]) =>
      reviews.map((r) =>
        r === review
          ? { ...r, decision: (r.decision === 'accept' ? 'reject-new' : 'accept') as NameReview['decision'] }
          : r
      );
    this.rosterReviews.update(flip);
    this.waitlistReviews.update(flip);
  }

  async confirmRoster(): Promise<void> {
    const result = await firstValueFrom(
      this.rosterService.createSession({
        groupCode: this.groupCode,
        date: this.date(),
        venue: this.venue().trim() || null,
        courtCount: this.courtCount(),
        rawImportText: this.rawText(),
        rosterReviews: this.rosterReviews(),
        waitlistReviews: this.waitlistReviews(),
      })
    );

    this.router.navigateByUrl(`/s/${result.code}`);
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false --include='**/group-entry.spec.ts'
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add web/src/app/core/roster-review.ts web/src/app/core/roster-review.spec.ts web/src/app/pages/group-entry
git commit -m "feat: migrate GroupEntry to the API"
```

---

### Task 5: `SessionDashboard` migration

**Files:**
- Rewrite: `web/src/app/pages/session-dashboard/session-dashboard.ts`
- Rewrite: `web/src/app/pages/session-dashboard/session-dashboard.spec.ts`

**Interfaces:**
- Consumes: `LiveSessionService.sessionResource`/`.courts`/`.waitingPlayerIds` (Task 3).
- `session-dashboard.html` is unchanged.

- [ ] **Step 1: Write the failing test**

Replace `web/src/app/pages/session-dashboard/session-dashboard.spec.ts` entirely:

```ts
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { SessionDashboard } from './session-dashboard';
import { environment } from '../../../environments/environment';
import type { Session } from '../../core/session.model';

const B = environment.apiBaseUrl;

function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    code: 'sess1',
    groupCode: 'group1',
    date: '2026-09-08',
    venue: null,
    courtCount: 1,
    rawImportText: '',
    rosterPlayerIds: ['p1', 'p2'],
    waitlistPlayerIds: [],
    courts: [{ status: 'idle' }],
    ...overrides,
  };
}

describe('SessionDashboard', () => {
  let fixture: ComponentFixture<SessionDashboard>;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SessionDashboard],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ sessionCode: 'sess1' }) } },
        },
      ],
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('renders the confirmed roster as chips', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();

    httpMock
      .expectOne(`${B}/sessions/sess1`)
      .flush(baseSession({ rosterPlayerIds: ['p1', 'p2'] }));
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock
      .expectOne(`${B}/groups/group1/players`)
      .flush([
        { id: 'p1', name: 'ตั้ม', aliases: [] },
        { id: 'p2', name: 'เบส', aliases: [] },
      ]);
    await fixture.whenStable();

    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('ตั้ม');
    expect(text).toContain('เบส');
  });

  it('renders one CourtPanel per court', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();

    httpMock
      .expectOne(`${B}/sessions/sess1`)
      .flush(
        baseSession({
          courtCount: 2,
          rosterPlayerIds: ['p1', 'p2', 'p3', 'p4'],
          courts: [{ status: 'idle' }, { status: 'idle' }],
        })
      );
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/groups/group1/players`).flush([]);
    await fixture.whenStable();

    fixture.detectChanges();
    const panels = (fixture.nativeElement as HTMLElement).querySelectorAll('app-court-panel');
    expect(panels).toHaveLength(2);
  });

  it('renders the waiting queue', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();

    httpMock
      .expectOne(`${B}/sessions/sess1`)
      .flush(baseSession({ rosterPlayerIds: ['p1', 'p2', 'p3', 'p4'] }));
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock
      .expectOne(`${B}/groups/group1/players`)
      .flush([{ id: 'p1', name: 'ตั้ม', aliases: [] }]);
    await fixture.whenStable();

    fixture.detectChanges();
    const waitingSection = (fixture.nativeElement as HTMLElement).querySelector('.waiting-queue');
    expect(waitingSection?.textContent).toContain('ตั้ม');
  });

  it('renders the waitlist as chips', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();

    httpMock
      .expectOne(`${B}/sessions/sess1`)
      .flush(baseSession({ rosterPlayerIds: ['p1'], waitlistPlayerIds: ['p2'] }));
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock
      .expectOne(`${B}/groups/group1/players`)
      .flush([
        { id: 'p1', name: 'ตั้ม', aliases: [] },
        { id: 'p2', name: 'เบส', aliases: [] },
      ]);
    await fixture.whenStable();

    fixture.detectChanges();
    const waitlistSection = (fixture.nativeElement as HTMLElement).querySelector('.waitlist');
    expect(waitlistSection?.textContent).toContain('เบส');
  });

  it('shows a "session not found" message for an unknown sessionCode', async () => {
    fixture = TestBed.createComponent(SessionDashboard);
    fixture.detectChanges();

    httpMock
      .expectOne(`${B}/sessions/sess1`)
      .flush('Not Found', { status: 404, statusText: 'Not Found' });
    await fixture.whenStable();

    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Session not found');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false --include='**/session-dashboard.spec.ts'
```

Expected: FAIL to compile — `SessionDashboard` still calls the deleted `RosterService.getSession`/`.getPlayers` synchronously.

- [ ] **Step 3: Rewrite `SessionDashboard`**

Replace `web/src/app/pages/session-dashboard/session-dashboard.ts` entirely:

```ts
import { Component, computed } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { httpResource } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { LiveSessionService } from '../../core/live-session.service';
import { resolvePlayerNames } from '../../core/player-names';
import { CourtPanel } from './court-panel/court-panel';
import type { Player } from '../../../../../fuzzy-match.ts';

@Component({
  selector: 'app-session-dashboard',
  imports: [CourtPanel],
  providers: [LiveSessionService],
  templateUrl: './session-dashboard.html',
  styleUrl: './session-dashboard.css',
})
export class SessionDashboard {
  protected readonly session = computed(() => {
    if (this.liveSession.sessionResource.error()) return undefined;
    return this.liveSession.sessionResource.value();
  });

  protected readonly sessionExists = computed(() => this.session() !== undefined);

  private readonly playersResource = httpResource<Player[]>(() => {
    const groupCode = this.session()?.groupCode;
    return groupCode ? `${environment.apiBaseUrl}/groups/${groupCode}/players` : undefined;
  });

  protected readonly players = computed<Player[]>(() => {
    if (this.playersResource.error()) return [];
    return this.playersResource.value() ?? [];
  });

  readonly rosterNames = computed(() => {
    const session = this.session();
    if (!session) return [];
    return resolvePlayerNames(session.rosterPlayerIds, this.players());
  });

  readonly waitlistNames = computed(() => {
    const session = this.session();
    if (!session) return [];
    return resolvePlayerNames(session.waitlistPlayerIds, this.players());
  });

  readonly courtNumbers = computed(() => this.liveSession.courts().map((_, i) => i + 1));

  readonly waitingNames = computed(() =>
    resolvePlayerNames(this.liveSession.waitingPlayerIds(), this.players())
  );

  constructor(route: ActivatedRoute, protected liveSession: LiveSessionService) {}
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false --include='**/session-dashboard.spec.ts'
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/pages/session-dashboard/session-dashboard.ts web/src/app/pages/session-dashboard/session-dashboard.spec.ts
git commit -m "feat: migrate SessionDashboard to httpResource"
```

---

### Task 6: `CourtPanel` migration

**Files:**
- Rewrite: `web/src/app/pages/session-dashboard/court-panel/court-panel.ts`
- Rewrite: `web/src/app/pages/session-dashboard/court-panel/court-panel.spec.ts`

**Interfaces:**
- Consumes: `LiveSessionService.courts`/`.proposeMatch`/`.confirmMatch`/`.finishMatch` (Task 3) — `confirm()`/`finish()` now read `pairingId` off the current `CourtState` rather than passing a court number.
- `court-panel.html` is unchanged.

- [ ] **Step 1: Write the failing test**

Replace `web/src/app/pages/session-dashboard/court-panel/court-panel.spec.ts` entirely:

```ts
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { CourtPanel } from './court-panel';
import { LiveSessionService } from '../../../core/live-session.service';
import { environment } from '../../../../environments/environment';
import type { Session } from '../../../core/session.model';

const B = environment.apiBaseUrl;

function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    code: 'sess1',
    groupCode: 'group1',
    date: '2026-09-08',
    venue: null,
    courtCount: 1,
    rawImportText: '',
    rosterPlayerIds: ['p1', 'p2', 'p3', 'p4'],
    waitlistPlayerIds: [],
    courts: [{ status: 'idle' }],
    ...overrides,
  };
}

const players = [
  { id: 'p1', name: 'ตั้ม', aliases: [] },
  { id: 'p2', name: 'เบส', aliases: [] },
  { id: 'p3', name: 'ปอม', aliases: [] },
  { id: 'p4', name: 'ไม้', aliases: [] },
];

async function createPanel(session = baseSession()): Promise<{
  fixture: ComponentFixture<CourtPanel>;
  httpMock: HttpTestingController;
}> {
  const httpMock = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(CourtPanel);
  fixture.componentRef.setInput('courtNumber', 1);
  fixture.componentRef.setInput('players', players);
  fixture.detectChanges();

  httpMock.expectOne(`${B}/sessions/sess1`).flush(session);
  await fixture.whenStable();

  return { fixture, httpMock };
}

describe('CourtPanel', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CourtPanel],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        LiveSessionService,
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ sessionCode: 'sess1' }) } },
        },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
  });

  it('shows a "Start next match" button when idle', async () => {
    const { fixture } = await createPanel();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Start next match');
  });

  it('shows reshuffle and confirm controls, and player names not ids, once pending', async () => {
    const { fixture } = await createPanel(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('reshuffle');
    expect(text).toContain('confirm');
    expect(text).toContain('ตั้ม');
    expect(text).not.toContain('p1');
  });

  it('shows a "Finish match" control once active', async () => {
    const { fixture } = await createPanel(
      baseSession({
        courts: [{ status: 'active', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Finish match');
  });

  it('clicking "Start next match" calls proposeMatch and reflects the pending court', async () => {
    const { fixture, httpMock } = await createPanel();
    fixture.detectChanges();

    const button = (fixture.nativeElement as HTMLElement).querySelector('button') as HTMLButtonElement;
    button.click();

    httpMock
      .expectOne(`${B}/sessions/sess1/courts/1/propose`)
      .flush({
        ok: true,
        pairing: { id: 'pair1', courtNumber: 1, matchNumber: 1, teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] },
      });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock
      .expectOne(`${B}/sessions/sess1`)
      .flush(
        baseSession({
          courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
        })
      );
    await fixture.whenStable();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('reshuffle');
  });

  it('clicking "confirm" posts to confirm with the court\'s pairingId', async () => {
    const { fixture, httpMock } = await createPanel(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    fixture.detectChanges();

    const buttons = (fixture.nativeElement as HTMLElement).querySelectorAll('button');
    const confirmButton = Array.from(buttons).find((b) => b.textContent === 'confirm') as HTMLButtonElement;
    confirmButton.click();

    const req = httpMock.expectOne(`${B}/sessions/sess1/pairings/pair1/confirm`);
    expect(req.request.method).toBe('POST');
    req.flush({});
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(
      baseSession({
        courts: [{ status: 'active', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    await fixture.whenStable();
  });
});

describe('CourtPanel with too few players', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CourtPanel],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        LiveSessionService,
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ sessionCode: 'sess1' }) } },
        },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
  });

  it('shows a message when there are not enough players to start a match', async () => {
    const { fixture, httpMock } = await createPanel(baseSession({ rosterPlayerIds: ['p1', 'p2'] }));
    fixture.detectChanges();

    const button = (fixture.nativeElement as HTMLElement).querySelector('button') as HTMLButtonElement;
    button.click();

    httpMock
      .expectOne(`${B}/sessions/sess1/courts/1/propose`)
      .flush({ ok: false, reason: 'not-enough-players' });
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession({ rosterPlayerIds: ['p1', 'p2'] }));
    await fixture.whenStable();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Not enough players waiting');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false --include='**/court-panel.spec.ts'
```

Expected: FAIL to compile — `CourtPanel.confirm()`/`.finish()` still call `liveSession.confirmMatch(this.courtNumber())`/`.finishMatch(this.courtNumber(), ...)`, which no longer matches the new `pairingId`-based signatures.

- [ ] **Step 3: Rewrite `CourtPanel`**

Replace `web/src/app/pages/session-dashboard/court-panel/court-panel.ts` entirely:

```ts
import { Component, computed, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LiveSessionService } from '../../../core/live-session.service';
import { resolvePlayerNames } from '../../../core/player-names';
import type { CourtState } from '../../../core/live-session.model';
import type { Player } from '../../../../../../fuzzy-match.ts';

@Component({
  selector: 'app-court-panel',
  imports: [FormsModule],
  templateUrl: './court-panel.html',
  styleUrl: './court-panel.css',
})
export class CourtPanel {
  readonly courtNumber = input.required<number>();
  readonly players = input<Player[]>([]);

  readonly scoreA = signal<number | null>(null);
  readonly scoreB = signal<number | null>(null);
  readonly notEnoughPlayers = signal(false);

  constructor(protected liveSession: LiveSessionService) {}

  protected readonly court = computed<CourtState>(
    () => this.liveSession.courts()[this.courtNumber() - 1] ?? { status: 'idle' }
  );

  protected teamNames(ids: [string, string]): string[] {
    return resolvePlayerNames(ids, this.players());
  }

  protected async startOrReshuffle(): Promise<void> {
    const success = await this.liveSession.proposeMatch(this.courtNumber());
    this.notEnoughPlayers.set(!success);
  }

  protected async confirm(): Promise<void> {
    const c = this.court();
    if (c.status !== 'pending') return;
    await this.liveSession.confirmMatch(c.pairingId);
  }

  protected async finish(): Promise<void> {
    const c = this.court();
    if (c.status !== 'active') return;
    await this.liveSession.finishMatch(c.pairingId, this.scoreA(), this.scoreB());
    this.scoreA.set(null);
    this.scoreB.set(null);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false --include='**/court-panel.spec.ts'
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/pages/session-dashboard/court-panel
git commit -m "feat: migrate CourtPanel to pairingId-based confirm/finish"
```

---

### Task 7: `SessionDisplay` migration, final full-app verification

**Files:**
- Rewrite: `web/src/app/pages/session-display/session-display.ts`
- Rewrite: `web/src/app/pages/session-display/session-display.spec.ts`

**Interfaces:**
- Consumes: `LiveSessionService.sessionResource`/`.courts`/`.waitingPlayerIds`/`.refresh` (Task 3).
- `session-display.html` is unchanged.

- [ ] **Step 1: Write the failing test**

Replace `web/src/app/pages/session-display/session-display.spec.ts` entirely:

```ts
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { SessionDisplay } from './session-display';
import { environment } from '../../../environments/environment';
import type { Session } from '../../core/session.model';

const B = environment.apiBaseUrl;

function baseSession(overrides: Partial<Session> = {}): Session {
  return {
    code: 'sess1',
    groupCode: 'group1',
    date: '2026-09-08',
    venue: 'KIP',
    courtCount: 1,
    rawImportText: '',
    rosterPlayerIds: ['p1', 'p2', 'p3', 'p4'],
    waitlistPlayerIds: [],
    courts: [{ status: 'idle' }],
    ...overrides,
  };
}

const players = [
  { id: 'p1', name: 'ตั้ม', aliases: [] },
  { id: 'p2', name: 'เบส', aliases: [] },
  { id: 'p3', name: 'ปอม', aliases: [] },
  { id: 'p4', name: 'ไม้', aliases: [] },
];

async function createDisplay(session = baseSession()): Promise<{
  fixture: ComponentFixture<SessionDisplay>;
  httpMock: HttpTestingController;
}> {
  const httpMock = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(SessionDisplay);
  fixture.detectChanges();

  httpMock.expectOne(`${B}/sessions/sess1`).flush(session);
  await new Promise((r) => setTimeout(r, 0));
  TestBed.tick();

  return { fixture, httpMock };
}

describe('SessionDisplay', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SessionDisplay],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ sessionCode: 'sess1' }) } },
        },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
  });

  it('shows the Group name as the header when one is set', async () => {
    const { fixture, httpMock } = await createDisplay();
    httpMock
      .expectOne(`${B}/groups/group1`)
      .flush({ code: 'group1', name: 'Group A', lastSessionCode: null });
    httpMock.expectOne(`${B}/groups/group1/players`).flush(players);
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();

    expect(fixture.componentInstance.header()).toBe('Group A');
  });

  it('falls back to date + venue when no Group name is set', async () => {
    const { fixture, httpMock } = await createDisplay();
    httpMock.expectOne(`${B}/groups/group1`).flush({ code: 'group1', name: null, lastSessionCode: null });
    httpMock.expectOne(`${B}/groups/group1/players`).flush(players);
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();

    expect(fixture.componentInstance.header()).toBe('2026-09-08 · KIP');
  });

  it('shows "waiting" for an idle or pending court, never a proposed pairing', async () => {
    const { fixture, httpMock } = await createDisplay(
      baseSession({
        courts: [{ status: 'pending', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    httpMock.expectOne(`${B}/groups/group1`).flush({ code: 'group1', name: null, lastSessionCode: null });
    httpMock.expectOne(`${B}/groups/group1/players`).flush(players);
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();

    expect(fixture.componentInstance.courtLines()[0].text).toBe('waiting');
  });

  it('shows the pairing for an active court', async () => {
    const { fixture, httpMock } = await createDisplay(
      baseSession({
        courts: [{ status: 'active', pairingId: 'pair1', teamA: ['p1', 'p2'], teamB: ['p3', 'p4'] }],
      })
    );
    httpMock.expectOne(`${B}/groups/group1`).flush({ code: 'group1', name: null, lastSessionCode: null });
    httpMock.expectOne(`${B}/groups/group1/players`).flush(players);
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();

    const line = fixture.componentInstance.courtLines()[0];
    expect(line.text).toContain('vs');
    expect(line.text).not.toBe('waiting');
  });

  it('clicking refresh calls liveSession.refresh', async () => {
    const { fixture, httpMock } = await createDisplay();
    httpMock.expectOne(`${B}/groups/group1`).flush({ code: 'group1', name: null, lastSessionCode: null });
    httpMock.expectOne(`${B}/groups/group1/players`).flush(players);
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    fixture.detectChanges();

    const button = (fixture.nativeElement as HTMLElement).querySelector('button') as HTMLButtonElement;
    button.click();

    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();
    httpMock.expectOne(`${B}/sessions/sess1`).flush(baseSession());
  });

  it('lists waiting players by name', async () => {
    const { fixture, httpMock } = await createDisplay();
    httpMock.expectOne(`${B}/groups/group1`).flush({ code: 'group1', name: null, lastSessionCode: null });
    httpMock.expectOne(`${B}/groups/group1/players`).flush(players);
    await new Promise((r) => setTimeout(r, 0));
    TestBed.tick();

    expect(fixture.componentInstance.waitingNames().sort()).toEqual(
      ['ตั้ม', 'ปอม', 'เบส', 'ไม้'].sort()
    );
  });
});

describe('SessionDisplay with an unknown sessionCode', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SessionDisplay],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ sessionCode: 'ghost' }) } },
        },
      ],
    }).compileComponents();
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
  });

  it('shows a "session not found" message', async () => {
    const httpMock = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(SessionDisplay);
    fixture.detectChanges();

    httpMock.expectOne(`${environment.apiBaseUrl}/sessions/ghost`).flush('Not Found', {
      status: 404,
      statusText: 'Not Found',
    });
    await fixture.whenStable();

    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Session not found');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false --include='**/session-display.spec.ts'
```

Expected: FAIL to compile — `SessionDisplay` still calls the deleted synchronous `RosterService` methods.

- [ ] **Step 3: Rewrite `SessionDisplay`**

Replace `web/src/app/pages/session-display/session-display.ts` entirely:

```ts
import { Component, computed } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { LiveSessionService } from '../../core/live-session.service';
import { resolvePlayerNames } from '../../core/player-names';
import type { Group } from '../../core/group.model';
import type { Player } from '../../../../../fuzzy-match.ts';

@Component({
  selector: 'app-session-display',
  imports: [],
  providers: [LiveSessionService],
  templateUrl: './session-display.html',
  styleUrl: './session-display.css',
})
export class SessionDisplay {
  protected readonly session = computed(() => {
    if (this.liveSession.sessionResource.error()) return undefined;
    return this.liveSession.sessionResource.value();
  });

  readonly sessionExists = computed(() => this.session() !== undefined);

  private readonly groupResource = httpResource<Group>(() => {
    const groupCode = this.session()?.groupCode;
    return groupCode ? `${environment.apiBaseUrl}/groups/${groupCode}` : undefined;
  });

  private readonly playersResource = httpResource<Player[]>(() => {
    const groupCode = this.session()?.groupCode;
    return groupCode ? `${environment.apiBaseUrl}/groups/${groupCode}/players` : undefined;
  });

  private readonly players = computed<Player[]>(() => {
    if (this.playersResource.error()) return [];
    return this.playersResource.value() ?? [];
  });

  readonly header = computed(() => {
    const session = this.session();
    if (!session) return '';
    const group = this.groupResource.error() ? undefined : this.groupResource.value();
    if (group?.name) return group.name;
    return session.venue ? `${session.date} · ${session.venue}` : (session.date ?? '');
  });

  readonly courtLines = computed(() => {
    const players = this.players();
    return this.liveSession.courts().map((court, i) => {
      if (court.status !== 'active') {
        return { courtNumber: i + 1, text: 'waiting' };
      }
      const [a1, a2] = resolvePlayerNames(court.teamA, players);
      const [b1, b2] = resolvePlayerNames(court.teamB, players);
      return { courtNumber: i + 1, text: `${a1} + ${a2} vs ${b1} + ${b2}` };
    });
  });

  readonly waitingNames = computed(() =>
    resolvePlayerNames(this.liveSession.waitingPlayerIds(), this.players())
  );

  constructor(protected liveSession: LiveSessionService) {}

  refresh(): void {
    this.liveSession.refresh();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false --include='**/session-display.spec.ts'
```

Expected: PASS.

- [ ] **Step 5: Full-app verification (first time since Task 1)**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng build
```

Expected: every spec across `web/` passes, and the production build succeeds. If anything still references a deleted export (`buildReviews`, `resolveReviews`, `MatchRecord`, `deriveHistory`, `RosterService.getSession`/`.savePlayers`/`.saveGroup`/`.createSession` with the old `Session`-object signature), fix it now — this is the first point such a stray reference would surface.

- [ ] **Step 6: Manual cross-origin smoke check**

`nest start` fails on this project (`MODULE_NOT_FOUND`) — it assumes the default `dist/main` entry, but the widened `rootDir` (scaffold plan) puts the real entry at `dist/server/src/main.js`. Start the server with:

```bash
cd server
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx nest build
DATABASE_URL="file:./prisma/dev.db" PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" node dist/server/src/main.js
```

(the compiled runtime doesn't load `.env` on its own — `DATABASE_URL` must be exported directly, or `$connect()` throws trying to open an undefined database URL). Confirmed once with a direct cross-origin `curl` request during this plan's own execution:

```bash
curl -s -i -X OPTIONS http://localhost:3000/groups/test-cors \
  -H "Origin: http://localhost:4200" -H "Access-Control-Request-Method: GET"
```

Expected: `Access-Control-Allow-Origin: *` in the response headers. With the Angular dev server also running (`web/`: `PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng serve`), open the app in a browser, create a group, paste a roster, confirm, and propose/confirm/finish a match on the dashboard — the fuller, real end-to-end exercise of Task 1's `app.enableCors()` the `curl` check only partially covers. Confirm no CORS error appears in the browser console.

- [ ] **Step 7: Commit**

```bash
git add web/src/app/pages/session-display
git commit -m "feat: migrate SessionDisplay to httpResource"
```

---

## Post-implementation

Update `PROJECT.md`:
- §9 checklist: note the client migration is complete under Build order (or Infra, whichever existing section fits — check current numbering before editing).
- §8.6: change from "migration path" (a plan) to "decided, built" — note the `pairingId` addition to `GET /sessions/:code` (a small API-layer follow-up this migration required) and the dead-code removals (`history-derivation.ts`, `resolveReviews`) as direct, expected consequences of the engines fully leaving the client.
