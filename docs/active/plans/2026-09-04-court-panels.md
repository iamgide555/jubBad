# Court Panels + Waiting Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add live, per-court match rotation to `SessionDashboard` — one panel per court (idle → propose → confirm → active → finish), plus a waiting-queue panel — wired to `pairing.ts`. Third of 4 pieces implementing `PROJECT.md` §7's UI/UX design.

**Architecture:** A component-scoped `LiveSessionService` (provided on `SessionDashboard`, so state resets per session visit) holds an append-only `matches: MatchRecord[]` log (JSON-safe — the actual persisted/derived-from data) and a `courts: CourtState[]` array (denormalized current-display state, one entry per court). A pure `deriveHistory(matches)` function computes `pairing.ts`'s `MatchHistory` (with its `Map`s) from the log on demand — `Map`s are never persisted directly, since `JSON.stringify` silently turns a `Map` into `{}`. A new `CourtPanel` child component and the waiting-queue list both inject the same service instance (Angular's standard parent-provides-to-child DI — no manual Input/Output plumbing needed).

**Tech Stack:** Angular 22 standalone components + signals (same as the roster panel). `pairing.ts`'s `generateRound`/`pairKey` reused directly by relative import.

**Spec:** `PROJECT.md` §7.2 ("Court panels", "Waiting/queue panel") and §6.3's usage note (courts rotate independently, not synchronized rounds — `generateRound` called per-idle-court with `courtCount=1`).

## Global Constraints

- **History is within-session only for this piece** — not the all-time-across-sessions history §6.3 ultimately wants. That needs real cross-session persistence (a backend + DB), which doesn't exist yet; this is explicit scope, confirmed with the user, not an oversight. Revisit once the backend is built.
- **Never persist a `Map` directly.** `JSON.stringify(new Map(...))` produces `{}` silently — no error, just silent data loss. `matches: MatchRecord[]` (plain objects/arrays/strings/numbers only) is the only thing that goes into `localStorage`; `MatchHistory`'s `Map`s are always rebuilt in-memory via `deriveHistory` right before a `generateRound` call, never stored.
- **`proposeMatch` and "reshuffle" are the same operation** (§6.3: "regenerate a court's current, not-yet-confirmed match... just call `generateRound` again"). One service method serves both idle→pending (start) and pending→pending (reshuffle) — the only difference is that a pending court's own current occupants go back into its own pool for reconsideration, since they were never confirmed as playing.
- `generateRound(available, 1, history, random)` naturally does the "who plays vs who waits longer" fairness reasoning already (via `pairing.ts`'s existing sit-out logic) even when `available` is a larger pool than one court needs — no separate waiting-pool prioritization to reimplement here.
- `LiveSessionService` is component-scoped (`providers: [LiveSessionService]` on `SessionDashboard`, no `providedIn: 'root'`) so state doesn't leak between different session visits in the same app lifetime. It reads `sessionCode` from `ActivatedRoute` directly in its constructor — same pattern as `GroupEntry`/`SessionDashboard` already use — and `courtCount`/`rosterPlayerIds` via `RosterService.getSession`.
- Storage key: `live:${sessionCode}` → `{ courts: CourtState[]; matches: MatchRecord[] }` (JSON). No other new keys.
- Avoid `Array.prototype.findLast` (ES2023) — this project's `tsconfig.json` targets `ES2022`; use `[...arr].reverse().findIndex(...)` instead where "the most recent matching entry" is needed.
- Run tests with `npx ng test --watch=false` from `web/` (prefix `PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"` if Node needs pinning).

---

## File Structure

- Create: `web/src/app/core/live-session.model.ts` — `MatchRecord`, `CourtState` types.
- Create: `web/src/app/core/history-derivation.ts` — `deriveHistory(matches): MatchHistory`.
- Create: `web/src/app/core/live-session.service.ts` — `courts`/`matches` signals, `waitingPlayerIds` computed, `proposeMatch`/`confirmMatch`/`finishMatch` methods, `localStorage` persistence.
- Create: `web/src/app/pages/session-dashboard/court-panel/court-panel.ts` + `.html` — one per court.
- Modify: `web/src/app/pages/session-dashboard/session-dashboard.ts` + `.html` — provide `LiveSessionService`, render court panels + waiting queue.
- Create matching `.spec.ts` for each new/modified piece above.

---

### Task 1: `MatchRecord`/`CourtState` types + `deriveHistory`

**Files:**
- Create: `web/src/app/core/live-session.model.ts`
- Create: `web/src/app/core/history-derivation.ts`
- Create: `web/src/app/core/history-derivation.spec.ts`

**Interfaces:**
- Consumes: `pairKey`, `type MatchHistory` from `../../../../pairing.ts` (already built)
- Produces:
  - `interface MatchRecord { courtNumber: number; teamA: [string, string]; teamB: [string, string]; scoreA: number | null; scoreB: number | null }`
  - `type CourtState = { status: 'idle' } | { status: 'pending'; teamA: [string, string]; teamB: [string, string] } | { status: 'active'; teamA: [string, string]; teamB: [string, string] }`
  - `deriveHistory(matches: MatchRecord[]): MatchHistory`

- [ ] **Step 1: Write the failing test**

Create `web/src/app/core/live-session.model.ts`:

```ts
export interface MatchRecord {
  courtNumber: number;
  teamA: [string, string];
  teamB: [string, string];
  scoreA: number | null;
  scoreB: number | null;
}

export type CourtState =
  | { status: 'idle' }
  | { status: 'pending'; teamA: [string, string]; teamB: [string, string] }
  | { status: 'active'; teamA: [string, string]; teamB: [string, string] };
```

Create `web/src/app/core/history-derivation.spec.ts`:

```ts
import { deriveHistory } from './history-derivation';
import { pairKey } from '../../../../pairing.ts';
import type { MatchRecord } from './live-session.model';

describe('deriveHistory', () => {
  it('returns empty history for no matches', () => {
    const history = deriveHistory([]);
    expect(history.partnerCounts.size).toBe(0);
    expect(history.opponentCounts.size).toBe(0);
    expect(history.gamesPlayedThisSession.size).toBe(0);
  });

  it('counts partners, opponents, and games played from one match', () => {
    const matches: MatchRecord[] = [
      { courtNumber: 1, teamA: ['a', 'b'], teamB: ['c', 'd'], scoreA: null, scoreB: null },
    ];
    const history = deriveHistory(matches);

    expect(history.partnerCounts.get(pairKey('a', 'b'))).toBe(1);
    expect(history.partnerCounts.get(pairKey('c', 'd'))).toBe(1);
    expect(history.opponentCounts.get(pairKey('a', 'c'))).toBe(1);
    expect(history.opponentCounts.get(pairKey('a', 'd'))).toBe(1);
    expect(history.opponentCounts.get(pairKey('b', 'c'))).toBe(1);
    expect(history.opponentCounts.get(pairKey('b', 'd'))).toBe(1);
    expect(history.gamesPlayedThisSession.get('a')).toBe(1);
    expect(history.gamesPlayedThisSession.get('b')).toBe(1);
    expect(history.gamesPlayedThisSession.get('c')).toBe(1);
    expect(history.gamesPlayedThisSession.get('d')).toBe(1);
  });

  it('accumulates counts across multiple matches, regardless of court', () => {
    const matches: MatchRecord[] = [
      { courtNumber: 1, teamA: ['a', 'b'], teamB: ['c', 'd'], scoreA: null, scoreB: null },
      { courtNumber: 2, teamA: ['a', 'b'], teamB: ['e', 'f'], scoreA: 21, scoreB: 15 },
    ];
    const history = deriveHistory(matches);

    expect(history.partnerCounts.get(pairKey('a', 'b'))).toBe(2);
    expect(history.gamesPlayedThisSession.get('a')).toBe(2);
    expect(history.gamesPlayedThisSession.get('c')).toBe(1);
    expect(history.gamesPlayedThisSession.get('e')).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: FAIL — `history-derivation.ts` doesn't exist yet (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `web/src/app/core/history-derivation.ts`:

```ts
import { pairKey, type MatchHistory } from '../../../../pairing.ts';
import type { MatchRecord } from './live-session.model';

export function deriveHistory(matches: MatchRecord[]): MatchHistory {
  const partnerCounts = new Map<string, number>();
  const opponentCounts = new Map<string, number>();
  const gamesPlayedThisSession = new Map<string, number>();

  for (const match of matches) {
    const [a1, a2] = match.teamA;
    const [b1, b2] = match.teamB;

    for (const id of [a1, a2, b1, b2]) {
      gamesPlayedThisSession.set(id, (gamesPlayedThisSession.get(id) ?? 0) + 1);
    }

    for (const key of [pairKey(a1, a2), pairKey(b1, b2)]) {
      partnerCounts.set(key, (partnerCounts.get(key) ?? 0) + 1);
    }

    for (const key of [pairKey(a1, b1), pairKey(a1, b2), pairKey(a2, b1), pairKey(a2, b2)]) {
      opponentCounts.set(key, (opponentCounts.get(key) ?? 0) + 1);
    }
  }

  return { partnerCounts, opponentCounts, gamesPlayedThisSession };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: PASS — 3 new tests green.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/core/live-session.model.ts web/src/app/core/history-derivation.ts web/src/app/core/history-derivation.spec.ts
git commit -m "feat: add MatchRecord/CourtState types and deriveHistory"
```

---

### Task 2: `LiveSessionService` — construction + persistence

**Files:**
- Create: `web/src/app/core/live-session.service.ts`
- Create: `web/src/app/core/live-session.service.spec.ts`

**Interfaces:**
- Consumes: `RosterService.getSession` (already built)
- Produces: `class LiveSessionService { courts: Signal<CourtState[]>; matches: Signal<MatchRecord[]> }`, constructed per-session via `ActivatedRoute`

- [ ] **Step 1: Write the failing test**

Create `web/src/app/core/live-session.service.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { LiveSessionService } from './live-session.service';
import { RosterService } from './roster.service';

function setUpSession(sessionCode: string, courtCount: number, rosterPlayerIds: string[]) {
  const rosterService = TestBed.inject(RosterService);
  rosterService.createSession({
    code: sessionCode,
    groupCode: 'group1',
    date: '2026-09-08',
    venue: null,
    courtCount,
    rawImportText: '',
    rosterPlayerIds,
    waitlistPlayerIds: [],
  });
}

describe('LiveSessionService', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        LiveSessionService,
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ sessionCode: 'sess1' }) } },
        },
      ],
    });
  });

  it('initializes one idle court per courtCount, no matches', () => {
    setUpSession('sess1', 2, ['p1', 'p2', 'p3', 'p4']);
    const service = TestBed.inject(LiveSessionService);
    expect(service.courts()).toEqual([{ status: 'idle' }, { status: 'idle' }]);
    expect(service.matches()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: FAIL — `live-session.service.ts` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `web/src/app/core/live-session.service.ts`:

```ts
import { Injectable, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { RosterService } from './roster.service';
import type { CourtState, MatchRecord } from './live-session.model';

@Injectable()
export class LiveSessionService {
  private readonly sessionCode: string;
  protected readonly rosterPlayerIds: string[];
  readonly courts = signal<CourtState[]>([]);
  readonly matches = signal<MatchRecord[]>([]);

  constructor(
    route: ActivatedRoute,
    private rosterService: RosterService
  ) {
    this.sessionCode = route.snapshot.paramMap.get('sessionCode')!;
    const session = this.rosterService.getSession(this.sessionCode);
    this.rosterPlayerIds = session?.rosterPlayerIds ?? [];
    const courtCount = session?.courtCount ?? 0;

    const stored = this.load();
    this.courts.set(
      stored?.courts ?? Array.from({ length: courtCount }, () => ({ status: 'idle' as const }))
    );
    this.matches.set(stored?.matches ?? []);
  }

  private load(): { courts: CourtState[]; matches: MatchRecord[] } | null {
    const raw = localStorage.getItem(`live:${this.sessionCode}`);
    return raw ? JSON.parse(raw) : null;
  }

  protected persist(): void {
    localStorage.setItem(
      `live:${this.sessionCode}`,
      JSON.stringify({ courts: this.courts(), matches: this.matches() })
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: PASS — 1 new test green.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/core/live-session.service.ts web/src/app/core/live-session.service.spec.ts
git commit -m "feat: add LiveSessionService construction and persistence"
```

---

### Task 3: `LiveSessionService.proposeMatch`

**Files:**
- Modify: `web/src/app/core/live-session.service.ts`
- Modify: `web/src/app/core/live-session.service.spec.ts`

**Interfaces:**
- Consumes: `generateRound` from `../../../../pairing.ts` (already built), `deriveHistory` (Task 1)
- Produces: `proposeMatch(courtNumber: number, random?: () => number): void`

- [ ] **Step 1: Write the failing test**

Append to `web/src/app/core/live-session.service.spec.ts`:

```ts
it('proposeMatch fills an idle court from the roster', () => {
  setUpSession('sess1', 1, ['p1', 'p2', 'p3', 'p4']);
  const service = TestBed.inject(LiveSessionService);

  service.proposeMatch(1, () => 0.5);

  const court = service.courts()[0];
  expect(court.status).toBe('pending');
  if (court.status === 'pending') {
    const allAssigned = [...court.teamA, ...court.teamB].sort();
    expect(allAssigned).toEqual(['p1', 'p2', 'p3', 'p4']);
  }
});

it('proposeMatch does nothing when fewer than 4 players are available', () => {
  setUpSession('sess1', 1, ['p1', 'p2']);
  const service = TestBed.inject(LiveSessionService);

  service.proposeMatch(1, () => 0.5);

  expect(service.courts()[0]).toEqual({ status: 'idle' });
});

it('proposeMatch excludes players reserved by other pending/active courts', () => {
  setUpSession('sess1', 2, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']);
  const service = TestBed.inject(LiveSessionService);

  service.proposeMatch(1, () => 0.1);
  const firstCourt = service.courts()[0];
  expect(firstCourt.status).toBe('pending');

  service.proposeMatch(2, () => 0.1);
  const secondCourt = service.courts()[1];
  expect(secondCourt.status).toBe('pending');

  if (firstCourt.status === 'pending' && secondCourt.status === 'pending') {
    const firstIds = new Set([...firstCourt.teamA, ...firstCourt.teamB]);
    const secondIds = [...secondCourt.teamA, ...secondCourt.teamB];
    for (const id of secondIds) {
      expect(firstIds.has(id)).toBe(false);
    }
  }
});

it('proposeMatch on an already-pending court reconsiders its own occupants (reshuffle)', () => {
  setUpSession('sess1', 1, ['p1', 'p2', 'p3', 'p4']);
  const service = TestBed.inject(LiveSessionService);

  service.proposeMatch(1, () => 0.1);
  service.proposeMatch(1, () => 0.9); // reshuffle with a different random stream

  const court = service.courts()[0];
  expect(court.status).toBe('pending');
  if (court.status === 'pending') {
    const allAssigned = [...court.teamA, ...court.teamB].sort();
    expect(allAssigned).toEqual(['p1', 'p2', 'p3', 'p4']); // still only these 4 players exist
  }
});

it('persists after proposeMatch, reloadable by a fresh instance under the same session key', () => {
  setUpSession('sess1', 1, ['p1', 'p2', 'p3', 'p4']);
  const first = TestBed.inject(LiveSessionService);
  first.proposeMatch(1, () => 0.5);
  expect(first.courts()[0].status).toBe('pending');

  // A fresh instance (simulating a page reload) should reload the same
  // state. Plain `new` works here — the constructor only uses
  // constructor-injected params, it never calls `inject()` internally, so
  // no injection context (e.g. `TestBed.runInInjectionContext`) is needed
  // (confirmed while writing this plan).
  const second = new LiveSessionService(
    TestBed.inject(ActivatedRoute),
    TestBed.inject(RosterService)
  );
  expect(second.courts()).toEqual(first.courts());
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: FAIL — `proposeMatch` does not exist yet (this also unblocks Task 2's second test).

- [ ] **Step 3: Write minimal implementation**

Modify `web/src/app/core/live-session.service.ts` — add the import and method:

```ts
import { generateRound } from '../../../../pairing.ts';
import { deriveHistory } from './history-derivation';

// add as a method on the class:
  proposeMatch(courtNumber: number, random: () => number = Math.random): void {
    const index = courtNumber - 1;
    const reservedByOtherCourts = new Set<string>();
    this.courts().forEach((court, i) => {
      if (i === index || court.status === 'idle') return;
      reservedByOtherCourts.add(court.teamA[0]);
      reservedByOtherCourts.add(court.teamA[1]);
      reservedByOtherCourts.add(court.teamB[0]);
      reservedByOtherCourts.add(court.teamB[1]);
    });
    const available = this.rosterPlayerIds.filter((id) => !reservedByOtherCourts.has(id));

    const history = deriveHistory(this.matches());
    const result = generateRound(available, 1, history, random);
    if (result.courts.length === 0) return;

    const [proposed] = result.courts;
    this.courts.update((courts) => {
      const next = [...courts];
      next[index] = { status: 'pending', teamA: proposed.teamA, teamB: proposed.teamB };
      return next;
    });
    this.persist();
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: PASS — all 6 tests in this file green (1 from Task 2 + 5 new).

- [ ] **Step 5: Commit**

```bash
git add web/src/app/core/live-session.service.ts web/src/app/core/live-session.service.spec.ts
git commit -m "feat: add LiveSessionService.proposeMatch (start + reshuffle)"
```

---

### Task 4: `LiveSessionService.confirmMatch`

**Files:**
- Modify: `web/src/app/core/live-session.service.ts`
- Modify: `web/src/app/core/live-session.service.spec.ts`

**Interfaces:**
- Produces: `confirmMatch(courtNumber: number): void`

- [ ] **Step 1: Write the failing test**

Append to `web/src/app/core/live-session.service.spec.ts`:

```ts
it('confirmMatch moves a pending court to active and logs a match record', () => {
  setUpSession('sess1', 1, ['p1', 'p2', 'p3', 'p4']);
  const service = TestBed.inject(LiveSessionService);

  service.proposeMatch(1, () => 0.5);
  service.confirmMatch(1);

  const court = service.courts()[0];
  expect(court.status).toBe('active');
  expect(service.matches()).toHaveLength(1);
  expect(service.matches()[0]).toMatchObject({ courtNumber: 1, scoreA: null, scoreB: null });
});

it('confirmMatch does nothing on an idle court', () => {
  setUpSession('sess1', 1, ['p1', 'p2', 'p3', 'p4']);
  const service = TestBed.inject(LiveSessionService);

  service.confirmMatch(1);

  expect(service.courts()[0]).toEqual({ status: 'idle' });
  expect(service.matches()).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: FAIL — `confirmMatch` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Append to `web/src/app/core/live-session.service.ts`:

```ts
  confirmMatch(courtNumber: number): void {
    const index = courtNumber - 1;
    const court = this.courts()[index];
    if (court.status !== 'pending') return;

    this.matches.update((matches) => [
      ...matches,
      { courtNumber, teamA: court.teamA, teamB: court.teamB, scoreA: null, scoreB: null },
    ]);
    this.courts.update((courts) => {
      const next = [...courts];
      next[index] = { status: 'active', teamA: court.teamA, teamB: court.teamB };
      return next;
    });
    this.persist();
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: PASS — 8 tests green in this file.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/core/live-session.service.ts web/src/app/core/live-session.service.spec.ts
git commit -m "feat: add LiveSessionService.confirmMatch"
```

---

### Task 5: `LiveSessionService.finishMatch`

**Files:**
- Modify: `web/src/app/core/live-session.service.ts`
- Modify: `web/src/app/core/live-session.service.spec.ts`

**Interfaces:**
- Produces: `finishMatch(courtNumber: number, scoreA: number | null, scoreB: number | null): void`

- [ ] **Step 1: Write the failing test**

Append to `web/src/app/core/live-session.service.spec.ts`:

```ts
it('finishMatch records the score and frees the court back to idle', () => {
  setUpSession('sess1', 1, ['p1', 'p2', 'p3', 'p4']);
  const service = TestBed.inject(LiveSessionService);

  service.proposeMatch(1, () => 0.5);
  service.confirmMatch(1);
  service.finishMatch(1, 21, 15);

  expect(service.courts()[0]).toEqual({ status: 'idle' });
  expect(service.matches()[0]).toMatchObject({ scoreA: 21, scoreB: 15 });
});

it('finishMatch without a score still frees the court, leaving scores null', () => {
  setUpSession('sess1', 1, ['p1', 'p2', 'p3', 'p4']);
  const service = TestBed.inject(LiveSessionService);

  service.proposeMatch(1, () => 0.5);
  service.confirmMatch(1);
  service.finishMatch(1, null, null);

  expect(service.courts()[0]).toEqual({ status: 'idle' });
  expect(service.matches()[0]).toMatchObject({ scoreA: null, scoreB: null });
});

it('finishMatch does nothing on an idle court', () => {
  setUpSession('sess1', 1, ['p1', 'p2', 'p3', 'p4']);
  const service = TestBed.inject(LiveSessionService);

  service.finishMatch(1, 21, 15);

  expect(service.courts()[0]).toEqual({ status: 'idle' });
  expect(service.matches()).toHaveLength(0);
});

it('finishMatch updates the correct match when a court has played more than once', () => {
  setUpSession('sess1', 1, ['p1', 'p2', 'p3', 'p4']);
  const service = TestBed.inject(LiveSessionService);

  service.proposeMatch(1, () => 0.5);
  service.confirmMatch(1);
  service.finishMatch(1, 21, 10);

  service.proposeMatch(1, () => 0.5);
  service.confirmMatch(1);
  service.finishMatch(1, 15, 21);

  expect(service.matches()).toHaveLength(2);
  expect(service.matches()[0]).toMatchObject({ scoreA: 21, scoreB: 10 });
  expect(service.matches()[1]).toMatchObject({ scoreA: 15, scoreB: 21 });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: FAIL — `finishMatch` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Append to `web/src/app/core/live-session.service.ts`:

```ts
  finishMatch(courtNumber: number, scoreA: number | null, scoreB: number | null): void {
    const index = courtNumber - 1;
    const court = this.courts()[index];
    if (court.status !== 'active') return;

    this.matches.update((matches) => {
      const reversedIndex = [...matches].reverse().findIndex((m) => m.courtNumber === courtNumber);
      if (reversedIndex === -1) return matches;
      const actualIndex = matches.length - 1 - reversedIndex;
      const next = [...matches];
      next[actualIndex] = { ...next[actualIndex], scoreA, scoreB };
      return next;
    });
    this.courts.update((courts) => {
      const next = [...courts];
      next[index] = { status: 'idle' };
      return next;
    });
    this.persist();
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: PASS — 12 tests green in this file.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/core/live-session.service.ts web/src/app/core/live-session.service.spec.ts
git commit -m "feat: add LiveSessionService.finishMatch"
```

---

### Task 6: `LiveSessionService.waitingPlayerIds`

**Files:**
- Modify: `web/src/app/core/live-session.service.ts`
- Modify: `web/src/app/core/live-session.service.spec.ts`

**Interfaces:**
- Produces: `waitingPlayerIds: Signal<string[]>`

- [ ] **Step 1: Write the failing test**

Append to `web/src/app/core/live-session.service.spec.ts`:

```ts
it('waitingPlayerIds excludes players on pending or active courts', () => {
  setUpSession('sess1', 2, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  const service = TestBed.inject(LiveSessionService);

  service.proposeMatch(1, () => 0.1);
  service.confirmMatch(1);

  const waiting = service.waitingPlayerIds();
  const firstCourt = service.courts()[0];
  if (firstCourt.status === 'active') {
    for (const id of [...firstCourt.teamA, ...firstCourt.teamB]) {
      expect(waiting).not.toContain(id);
    }
  }
  expect(waiting).toHaveLength(2);
});

it('waitingPlayerIds includes everyone when all courts are idle', () => {
  setUpSession('sess1', 1, ['p1', 'p2', 'p3', 'p4']);
  const service = TestBed.inject(LiveSessionService);

  expect(service.waitingPlayerIds().sort()).toEqual(['p1', 'p2', 'p3', 'p4']);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: FAIL — `waitingPlayerIds` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Modify `web/src/app/core/live-session.service.ts` — add the `computed` import and the property:

```ts
import { Injectable, computed, signal } from '@angular/core';

// add as a class field, alongside `matches`:
  readonly waitingPlayerIds = computed(() => {
    const reserved = new Set<string>();
    for (const court of this.courts()) {
      if (court.status === 'idle') continue;
      reserved.add(court.teamA[0]);
      reserved.add(court.teamA[1]);
      reserved.add(court.teamB[0]);
      reserved.add(court.teamB[1]);
    }
    return this.rosterPlayerIds.filter((id) => !reserved.has(id));
  });
```

- [ ] **Step 4: Run test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: PASS — 14 tests green in this file.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/core/live-session.service.ts web/src/app/core/live-session.service.spec.ts
git commit -m "feat: add LiveSessionService.waitingPlayerIds"
```

---

### Task 7: `CourtPanel` component

**Files:**
- Create: `web/src/app/pages/session-dashboard/court-panel/court-panel.ts`
- Create: `web/src/app/pages/session-dashboard/court-panel/court-panel.html`
- Create: `web/src/app/pages/session-dashboard/court-panel/court-panel.spec.ts`

**Interfaces:**
- Consumes: `LiveSessionService` (Tasks 2-6), provided by a parent (`SessionDashboard`, Task 8) — this task's spec provides its own instance directly, since `CourtPanel` doesn't need to be rendered inside `SessionDashboard` to be tested in isolation.
- Produces: `CourtPanel` component with `@Input() courtNumber!: number`

- [ ] **Step 1: Write the failing test**

Create `web/src/app/pages/session-dashboard/court-panel/court-panel.spec.ts`:

```ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { CourtPanel } from './court-panel';
import { LiveSessionService } from '../../../core/live-session.service';
import { RosterService } from '../../../core/roster.service';

describe('CourtPanel', () => {
  let fixture: ComponentFixture<CourtPanel>;
  let service: LiveSessionService;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [CourtPanel],
      providers: [
        LiveSessionService,
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ sessionCode: 'sess1' }) } },
        },
      ],
    }).compileComponents();

    const rosterService = TestBed.inject(RosterService);
    rosterService.createSession({
      code: 'sess1',
      groupCode: 'group1',
      date: '2026-09-08',
      venue: null,
      courtCount: 1,
      rawImportText: '',
      rosterPlayerIds: ['p1', 'p2', 'p3', 'p4'],
      waitlistPlayerIds: [],
    });

    service = TestBed.inject(LiveSessionService);
    fixture = TestBed.createComponent(CourtPanel);
    fixture.componentRef.setInput('courtNumber', 1);
    await fixture.whenStable();
  });

  it('shows a "Start next match" button when idle', () => {
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Start next match');
  });

  it('shows reshuffle and confirm controls once pending', () => {
    service.proposeMatch(1, () => 0.5);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('reshuffle');
    expect(text).toContain('confirm');
  });

  it('shows a "Finish match" control once active', () => {
    service.proposeMatch(1, () => 0.5);
    service.confirmMatch(1);
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Finish match');
  });

  it('clicking "Start next match" calls proposeMatch on the service', () => {
    fixture.detectChanges();
    const button = (fixture.nativeElement as HTMLElement).querySelector(
      'button'
    ) as HTMLButtonElement;
    button.click();
    fixture.detectChanges();
    expect(service.courts()[0].status).toBe('pending');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: FAIL — `CourtPanel` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `web/src/app/pages/session-dashboard/court-panel/court-panel.ts`:

```ts
import { Component, computed, input } from '@angular/core';
import { LiveSessionService } from '../../../core/live-session.service';

@Component({
  selector: 'app-court-panel',
  imports: [],
  templateUrl: './court-panel.html',
  styleUrl: './court-panel.css',
})
export class CourtPanel {
  readonly courtNumber = input.required<number>();

  constructor(protected liveSession: LiveSessionService) {}

  protected readonly court = computed(
    () => this.liveSession.courts()[this.courtNumber() - 1]
  );

  protected startOrReshuffle(): void {
    this.liveSession.proposeMatch(this.courtNumber());
  }

  protected confirm(): void {
    this.liveSession.confirmMatch(this.courtNumber());
  }

  protected finish(scoreA: number | null, scoreB: number | null): void {
    this.liveSession.finishMatch(this.courtNumber(), scoreA, scoreB);
  }
}
```

Create `web/src/app/pages/session-dashboard/court-panel/court-panel.css` (empty file — the CLI always creates one alongside a component, keep the pattern):

```css
```

Create `web/src/app/pages/session-dashboard/court-panel/court-panel.html`:

```html
<div class="court-panel">
  <h4>Court {{ courtNumber() }}</h4>

  @let c = court();

  @switch (c.status) {
    @case ('idle') {
      <button type="button" (click)="startOrReshuffle()">Start next match</button>
    }
    @case ('pending') {
      @if (c.status === 'pending') {
        <p>{{ c.teamA[0] }} + {{ c.teamA[1] }} vs {{ c.teamB[0] }} + {{ c.teamB[1] }}</p>
      }
      <button type="button" (click)="startOrReshuffle()">reshuffle</button>
      <button type="button" (click)="confirm()">confirm</button>
    }
    @case ('active') {
      @if (c.status === 'active') {
        <p>{{ c.teamA[0] }} + {{ c.teamA[1] }} vs {{ c.teamB[0] }} + {{ c.teamB[1] }}</p>
      }
      <button type="button" (click)="finish(null, null)">Finish match</button>
    }
  }
</div>
```

(Repeatedly calling `court()` in the template and relying on Angular's signal-narrowing to refine the type on each call does **not** work inside `@switch`/`@case` combined with a nested `@if` re-check of the same condition — confirmed by running this exact template first and hitting `TS2339: Property 'teamB' does not exist on type '{ status: "idle"; }'`. Binding the value once via `@let c = court();` and narrowing off the single local `c` fixes it — this is the reliable pattern for a discriminated union read multiple times in one template.)

- [ ] **Step 4: Run test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: PASS — 4 new tests green. If `input.required<number>()` plus `fixture.componentRef.setInput(...)` doesn't resolve `courtNumber()` in time for the first `detectChanges()`, add `await fixture.whenStable()` after `setInput` in the test's `beforeEach` (already present above) before asserting — do not change the component's input style to work around a test-timing issue.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/pages/session-dashboard/court-panel
git commit -m "feat: add CourtPanel component"
```

---

### Task 8: `SessionDashboard` — provide `LiveSessionService`, render court panels + waiting queue

**Files:**
- Modify: `web/src/app/pages/session-dashboard/session-dashboard.ts`
- Modify: `web/src/app/pages/session-dashboard/session-dashboard.html`
- Modify: `web/src/app/pages/session-dashboard/session-dashboard.spec.ts`

**Interfaces:**
- Consumes: `LiveSessionService` (Tasks 2-6), `CourtPanel` (Task 7)
- Produces: `SessionDashboard` renders one `CourtPanel` per court and a waiting-queue list, alongside the existing roster chips

- [ ] **Step 1: Write the failing test**

Append to `web/src/app/pages/session-dashboard/session-dashboard.spec.ts` (this file already seeds a session with `courtCount: 1` and roster `['p1', 'p2']` in its existing test — add a new roster of 4 for these new tests so a court panel can actually fill):

```ts
it('renders one CourtPanel per court', () => {
  const rosterService = TestBed.inject(RosterService);
  rosterService.savePlayers('group1', [
    { id: 'p1', name: 'ตั้ม', aliases: [] },
    { id: 'p2', name: 'เบส', aliases: [] },
    { id: 'p3', name: 'ปอม', aliases: [] },
    { id: 'p4', name: 'ไม้', aliases: [] },
  ]);
  rosterService.createSession({
    code: 'sess1',
    groupCode: 'group1',
    date: '2026-09-08',
    venue: null,
    courtCount: 2,
    rawImportText: '',
    rosterPlayerIds: ['p1', 'p2', 'p3', 'p4'],
    waitlistPlayerIds: [],
  });

  fixture = TestBed.createComponent(SessionDashboard);
  fixture.detectChanges();

  const panels = (fixture.nativeElement as HTMLElement).querySelectorAll('app-court-panel');
  expect(panels).toHaveLength(2);
});

it('renders the waiting queue', () => {
  const rosterService = TestBed.inject(RosterService);
  rosterService.savePlayers('group1', [
    { id: 'p1', name: 'ตั้ม', aliases: [] },
    { id: 'p2', name: 'เบส', aliases: [] },
    { id: 'p3', name: 'ปอม', aliases: [] },
    { id: 'p4', name: 'ไม้', aliases: [] },
  ]);
  rosterService.createSession({
    code: 'sess1',
    groupCode: 'group1',
    date: '2026-09-08',
    venue: null,
    courtCount: 1,
    rawImportText: '',
    rosterPlayerIds: ['p1', 'p2', 'p3', 'p4'],
    waitlistPlayerIds: [],
  });

  fixture = TestBed.createComponent(SessionDashboard);
  fixture.detectChanges();

  const waitingSection = (fixture.nativeElement as HTMLElement).querySelector('.waiting-queue');
  expect(waitingSection).toBeTruthy();
  expect(waitingSection?.textContent).toContain('ตั้ม');
});
```

(Checking for `'ตั้ม'` anywhere in the page's text is too weak — that name already appears via the roster chips regardless of whether a waiting queue exists at all, so the test would pass vacuously before this task's implementation. Scoping the check to `.waiting-queue`'s own text content — confirmed by running this exact test against the pre-Task-8 template and seeing it correctly fail with `Received: null` — makes it a real test.)

- [ ] **Step 2: Run test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: FAIL — no `app-court-panel` elements are rendered yet, and the waiting-queue text isn't present yet.

- [ ] **Step 3: Write minimal implementation**

Replace `web/src/app/pages/session-dashboard/session-dashboard.ts`:

```ts
import { Component, computed } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { RosterService } from '../../core/roster.service';
import { LiveSessionService } from '../../core/live-session.service';
import { CourtPanel } from './court-panel/court-panel';

@Component({
  selector: 'app-session-dashboard',
  imports: [CourtPanel],
  providers: [LiveSessionService],
  templateUrl: './session-dashboard.html',
  styleUrl: './session-dashboard.css',
})
export class SessionDashboard {
  private readonly sessionCode: string;
  readonly rosterNames = computed(() => {
    const session = this.rosterService.getSession(this.sessionCode);
    if (!session) return [];
    const players = this.rosterService.getPlayers(session.groupCode);
    const byId = new Map(players.map((p) => [p.id, p.name]));
    return session.rosterPlayerIds.map((id) => byId.get(id) ?? id);
  });

  readonly courtNumbers = computed(() =>
    this.liveSession.courts().map((_, i) => i + 1)
  );

  readonly waitingNames = computed(() => {
    const session = this.rosterService.getSession(this.sessionCode);
    if (!session) return [];
    const players = this.rosterService.getPlayers(session.groupCode);
    const byId = new Map(players.map((p) => [p.id, p.name]));
    return this.liveSession.waitingPlayerIds().map((id) => byId.get(id) ?? id);
  });

  constructor(
    route: ActivatedRoute,
    private rosterService: RosterService,
    protected liveSession: LiveSessionService
  ) {
    this.sessionCode = route.snapshot.paramMap.get('sessionCode')!;
  }
}
```

Replace `web/src/app/pages/session-dashboard/session-dashboard.html`:

```html
<div class="roster-chips">
  @for (name of rosterNames(); track name) {
    <span class="chip">{{ name }}</span>
  }
</div>

@for (courtNumber of courtNumbers(); track courtNumber) {
  <app-court-panel [courtNumber]="courtNumber" />
}

<div class="waiting-queue">
  <h4>Waiting</h4>
  @for (name of waitingNames(); track name) {
    <span class="chip">{{ name }}</span>
  }
</div>
```

- [ ] **Step 4: Run test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: PASS — all tests in this file green, including the pre-existing roster-chips test from the roster-panel plan.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/pages/session-dashboard
git commit -m "feat: render court panels and waiting queue on SessionDashboard"
```

---

## Post-implementation

Update `PROJECT.md`:
- §7.4: note court panels + waiting queue are built (within-session history only — cross-session history needs the backend, not built yet).
- §8 checklist: build-order item 4 stays unchecked until the display view (piece 4 of 4) is also done.
