# Roster Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the roster confirmation flow — paste a LINE roster message on `GroupEntry`, review/confirm parsed header + fuzzy-matched names, create a `Session` and persist `Player` records, then land on `SessionDashboard` showing the confirmed roster as chips. Second of 4 pieces implementing `PROJECT.md` §7's UI/UX design (after the routing scaffold).

**Architecture:** `GroupEntry` (`/g/:groupCode`) owns the paste → confirm flow and hands off to a fresh `SessionDashboard` (`/s/:sessionCode`) on confirm. Business logic (matching parsed names, resolving host decisions into `Player` updates) lives in small pure functions under `web/src/app/core/`, not inside components — same style as `fuzzy-match.ts`/`pairing.ts`. State persists to `localStorage` (no backend/DB exists yet) via a thin `RosterService`. Root-level engines (`parser.ts`, `fuzzy-match.ts`) are imported directly by relative path — verified working in the previous plan's follow-up (see Global Constraints).

**Tech Stack:** Angular 22 standalone components + signals, `FormsModule` for the header input fields, Vitest + jsdom (already scaffolded). `crypto.randomUUID()` for IDs (built into the browser/jsdom, no dependency).

**Spec:** `PROJECT.md` §7.1 (routes) and §7.2 ("Roster panel" — states 1 and 2 only; state 3 is a plain read-only render on `SessionDashboard` in this plan, add-late-arrival/remove-no-show interactivity is deferred to the court-panel plan since those actions only matter once court panels exist to consume the "future fills" they affect).

## Global Constraints

- **Cross-boundary engine imports need two tsconfig flags** — confirmed working: `web/tsconfig.json`'s `compilerOptions` must include `"allowImportingTsExtensions": true` and `"rewriteRelativeImportExtensions": true` (already added; if missing, add them). Without both, importing `parser.ts`/`fuzzy-match.ts` by relative path fails with `TS5097`/`TS5096`. Verified: the actual bundled output includes the real function bodies (not just types), and both `ng build` and `ng test` (Vitest) pipelines work.
- Import root engines by relative path with the `.ts` extension, e.g. from `web/src/app/core/roster.service.ts`: `from '../../../../fuzzy-match.ts'`. Do not copy these files into `web/` — one source of truth, matching `parser.ts`'s existing tests.
- Business logic (matching, resolving host decisions) lives in plain exported functions under `web/src/app/core/`, not component methods — keep components thin (signals + template wiring + calling these functions), matching this project's established style.
- Storage keys: `players:${groupCode}` → `Player[]` (JSON), `session:${sessionCode}` → `Session` (JSON). No other localStorage keys in this plan.
- `Session.code` and new `Player.id` values use `crypto.randomUUID()` (`Session.code` sliced to 8 chars for a shorter shareable URL — collision risk is negligible at this app's scale and is an accepted trade-off, not a decision to revisit here).
- Run tests with `npx ng test --watch=false` from `web/` (prefix `PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"` if Node needs pinning, per the scaffold plan's Global Constraints).
- No backend/DB calls anywhere in this plan — `RosterService` is `localStorage`-only. Swapping it for a real backend later is an explicit future step, not addressed here.

---

## File Structure

- Create: `web/src/app/core/session.model.ts` — the `Session` interface.
- Create: `web/src/app/core/roster.service.ts` — `localStorage`-backed get/save for players and sessions.
- Create: `web/src/app/core/roster-review.ts` — pure functions: `buildReviews`, `resolveReviews`.
- Modify: `web/src/app/pages/group-entry/group-entry.ts` + `.html` — paste → confirm flow.
- Modify: `web/src/app/pages/session-dashboard/session-dashboard.ts` + `.html` — reads the confirmed session, renders roster chips.
- Create matching `.spec.ts` for each new/modified piece above.

---

### Task 1: `Session` model + `RosterService`

**Files:**
- Create: `web/src/app/core/session.model.ts`
- Create: `web/src/app/core/roster.service.ts`
- Create: `web/src/app/core/roster.service.spec.ts`

**Interfaces:**
- Consumes: `Player` from `../../../../fuzzy-match.ts` (already built)
- Produces:
  - `interface Session { code: string; groupCode: string; date: string | null; venue: string | null; courtCount: number | null; rawImportText: string; rosterPlayerIds: string[]; waitlistPlayerIds: string[] }`
  - `class RosterService { getPlayers(groupCode: string): Player[]; savePlayers(groupCode: string, players: Player[]): void; createSession(session: Session): void; getSession(sessionCode: string): Session | null }`

- [ ] **Step 1: Write the failing test**

Create `web/src/app/core/session.model.ts`:

```ts
export interface Session {
  code: string;
  groupCode: string;
  date: string | null;
  venue: string | null;
  courtCount: number | null;
  rawImportText: string;
  rosterPlayerIds: string[];
  waitlistPlayerIds: string[];
}
```

Create `web/src/app/core/roster.service.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { RosterService } from './roster.service';
import type { Player } from '../../../../fuzzy-match.ts';
import type { Session } from './session.model';

describe('RosterService', () => {
  let service: RosterService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    service = TestBed.inject(RosterService);
  });

  it('getPlayers returns an empty array when nothing is stored', () => {
    expect(service.getPlayers('group1')).toEqual([]);
  });

  it('savePlayers then getPlayers round-trips', () => {
    const players: Player[] = [{ id: 'p1', name: 'ตั้ม', aliases: [] }];
    service.savePlayers('group1', players);
    expect(service.getPlayers('group1')).toEqual(players);
  });

  it('players are scoped per group', () => {
    service.savePlayers('group1', [{ id: 'p1', name: 'ตั้ม', aliases: [] }]);
    expect(service.getPlayers('group2')).toEqual([]);
  });

  it('getSession returns null when nothing is stored', () => {
    expect(service.getSession('sess1')).toBeNull();
  });

  it('createSession then getSession round-trips', () => {
    const session: Session = {
      code: 'sess1',
      groupCode: 'group1',
      date: '2026-09-08',
      venue: 'KIP',
      courtCount: 2,
      rawImportText: 'raw text',
      rosterPlayerIds: ['p1', 'p2'],
      waitlistPlayerIds: [],
    };
    service.createSession(session);
    expect(service.getSession('sess1')).toEqual(session);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: FAIL — `RosterService` doesn't exist yet (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `web/src/app/core/roster.service.ts`:

```ts
import { Injectable } from '@angular/core';
import type { Player } from '../../../../fuzzy-match.ts';
import type { Session } from './session.model';

@Injectable({ providedIn: 'root' })
export class RosterService {
  getPlayers(groupCode: string): Player[] {
    const raw = localStorage.getItem(`players:${groupCode}`);
    return raw ? JSON.parse(raw) : [];
  }

  savePlayers(groupCode: string, players: Player[]): void {
    localStorage.setItem(`players:${groupCode}`, JSON.stringify(players));
  }

  createSession(session: Session): void {
    localStorage.setItem(`session:${session.code}`, JSON.stringify(session));
  }

  getSession(sessionCode: string): Session | null {
    const raw = localStorage.getItem(`session:${sessionCode}`);
    return raw ? JSON.parse(raw) : null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: PASS — 5 new tests green.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/core/session.model.ts web/src/app/core/roster.service.ts web/src/app/core/roster.service.spec.ts
git commit -m "feat: add Session model and localStorage-backed RosterService"
```

---

### Task 2: `roster-review.ts` — `buildReviews`

**Files:**
- Create: `web/src/app/core/roster-review.ts`
- Create: `web/src/app/core/roster-review.spec.ts`

**Interfaces:**
- Consumes: `matchName` from `../../../../fuzzy-match.ts` (Task 4 of the fuzzy-match plan, already built)
- Produces:
  - `interface NameReview { inputName: string; match: NameMatch; decision: 'accept' | 'reject-new' }`
  - `buildReviews(names: string[], players: Player[]): NameReview[]`

- [ ] **Step 1: Write the failing test**

Create `web/src/app/core/roster-review.spec.ts`:

```ts
import { buildReviews } from './roster-review';
import type { Player } from '../../../../fuzzy-match.ts';

const players: Player[] = [{ id: 'p1', name: 'ตั้ม', aliases: [] }];

describe('buildReviews', () => {
  it('marks an exact match, defaulting decision to accept', () => {
    const result = buildReviews(['ตั้ม'], players);
    expect(result).toEqual([
      { inputName: 'ตั้ม', match: { type: 'exact', playerId: 'p1' }, decision: 'accept' },
    ]);
  });

  it('marks a new name as new', () => {
    const result = buildReviews(['เกียร์'], players);
    expect(result[0].match).toEqual({ type: 'new' });
  });

  it('preserves input order for multiple names', () => {
    const result = buildReviews(['ตั้ม', 'เกียร์'], players);
    expect(result.map((r) => r.inputName)).toEqual(['ตั้ม', 'เกียร์']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: FAIL — `roster-review.ts` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `web/src/app/core/roster-review.ts`:

```ts
import { matchName, type NameMatch, type Player } from '../../../../fuzzy-match.ts';

export interface NameReview {
  inputName: string;
  match: NameMatch;
  decision: 'accept' | 'reject-new';
}

export function buildReviews(names: string[], players: Player[]): NameReview[] {
  return names.map((inputName) => ({
    inputName,
    match: matchName(inputName, players),
    decision: 'accept',
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: PASS — 3 new tests green.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/core/roster-review.ts web/src/app/core/roster-review.spec.ts
git commit -m "feat: add buildReviews for roster confirmation"
```

---

### Task 3: `roster-review.ts` — `resolveReviews`

**Files:**
- Modify: `web/src/app/core/roster-review.ts`
- Modify: `web/src/app/core/roster-review.spec.ts`

**Interfaces:**
- Consumes: `confirmExistingPlayerAlias`, `createNewPlayer` from `../../../../fuzzy-match.ts` (already built), `interface NameReview` (Task 2)
- Produces: `resolveReviews(reviews: NameReview[], players: Player[]): { playerIds: string[]; players: Player[] }`

- [ ] **Step 1: Write the failing test**

Append to `web/src/app/core/roster-review.spec.ts` (add `resolveReviews` to the existing import):

```ts
describe('resolveReviews', () => {
  it('resolves an exact match to its existing playerId, unchanged players', () => {
    const reviews = buildReviews(['ตั้ม'], players);
    const result = resolveReviews(reviews, players);
    expect(result.playerIds).toEqual(['p1']);
    expect(result.players).toEqual(players);
  });

  it('resolves an accepted fuzzy match by adding the raw text as an alias', () => {
    const reviews = [
      {
        inputName: 'ตัม',
        match: { type: 'fuzzy' as const, playerId: 'p1', score: 0.75 },
        decision: 'accept' as const,
      },
    ];
    const result = resolveReviews(reviews, players);
    expect(result.playerIds).toEqual(['p1']);
    expect(result.players).toEqual([{ id: 'p1', name: 'ตั้ม', aliases: ['ตัม'] }]);
  });

  it('resolves a rejected fuzzy match by creating a new player instead', () => {
    const reviews = [
      {
        inputName: 'ตัม',
        match: { type: 'fuzzy' as const, playerId: 'p1', score: 0.75 },
        decision: 'reject-new' as const,
      },
    ];
    const result = resolveReviews(reviews, players);
    expect(result.playerIds).toHaveLength(1);
    expect(result.players).toHaveLength(2);
    expect(result.players[1]).toEqual({ id: result.playerIds[0], name: 'ตัม', aliases: [] });
  });

  it('resolves a new-player match by creating a new player', () => {
    const reviews = buildReviews(['เกียร์'], players);
    const result = resolveReviews(reviews, players);
    expect(result.playerIds).toHaveLength(1);
    expect(result.players).toHaveLength(2);
    expect(result.players[1]).toEqual({ id: result.playerIds[0], name: 'เกียร์', aliases: [] });
  });

  it('accumulates player updates across multiple reviews in one call', () => {
    const reviews = buildReviews(['ตั้ม', 'เกียร์'], players);
    const result = resolveReviews(reviews, players);
    expect(result.playerIds).toEqual(['p1', result.playerIds[1]]);
    expect(result.players).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: FAIL — `resolveReviews` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Append to `web/src/app/core/roster-review.ts`:

```ts
import {
  confirmExistingPlayerAlias,
  createNewPlayer,
} from '../../../../fuzzy-match.ts';

export function resolveReviews(
  reviews: NameReview[],
  players: Player[]
): { playerIds: string[]; players: Player[] } {
  let updatedPlayers = players;

  const playerIds = reviews.map((review) => {
    if (review.match.type === 'exact') {
      return review.match.playerId;
    }
    if (review.match.type === 'fuzzy' && review.decision === 'accept') {
      updatedPlayers = confirmExistingPlayerAlias(
        updatedPlayers,
        review.match.playerId,
        review.inputName
      );
      return review.match.playerId;
    }
    const newId = crypto.randomUUID();
    updatedPlayers = createNewPlayer(updatedPlayers, newId, review.inputName);
    return newId;
  });

  return { playerIds, players: updatedPlayers };
}
```

(Update the `import { matchName, ... }` line at the top of the file to include `confirmExistingPlayerAlias, createNewPlayer` rather than adding a second import statement for the same module.)

- [ ] **Step 4: Run test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: PASS — 5 new tests green.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/core/roster-review.ts web/src/app/core/roster-review.spec.ts
git commit -m "feat: add resolveReviews for roster confirmation"
```

---

### Task 4: `GroupEntry` — paste state

**Files:**
- Modify: `web/src/app/pages/group-entry/group-entry.ts`
- Modify: `web/src/app/pages/group-entry/group-entry.html`
- Modify: `web/src/app/pages/group-entry/group-entry.spec.ts`

**Interfaces:**
- Consumes: `parseLineRosterMessage` from `../../../../../parser.ts` (already built)
- Produces: `GroupEntry` component with `state: Signal<'paste' | 'confirm'>`, `rawText: WritableSignal<string>`, a `parse()` method

- [ ] **Step 1: Write the failing test**

Replace `web/src/app/pages/group-entry/group-entry.spec.ts`:

```ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { GroupEntry } from './group-entry';
import { routes } from '../../app.routes';

describe('GroupEntry', () => {
  let component: GroupEntry;
  let fixture: ComponentFixture<GroupEntry>;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [GroupEntry],
      providers: [
        provideRouter(routes),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: convertToParamMap({ groupCode: 'group1' }) },
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(GroupEntry);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('starts in the paste state', () => {
    expect(component.state()).toBe('paste');
  });

  it('parsing a roster message switches to the confirm state', () => {
    component.rawText.set(
      '1. ตั้ม\n2. เบส\n19.00-20.00 1 คอร์ท\n@All'
    );
    component.parse();
    expect(component.state()).toBe('confirm');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: FAIL — `component.state`/`rawText`/`parse` don't exist on the current placeholder `GroupEntry`.

- [ ] **Step 3: Write minimal implementation**

Replace `web/src/app/pages/group-entry/group-entry.ts`:

```ts
import { Component, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { parseLineRosterMessage } from '../../../../../parser.ts';

@Component({
  selector: 'app-group-entry',
  imports: [FormsModule],
  templateUrl: './group-entry.html',
  styleUrl: './group-entry.css',
})
export class GroupEntry {
  protected readonly groupCode: string;
  readonly state = signal<'paste' | 'confirm'>('paste');
  readonly rawText = signal('');

  constructor(route: ActivatedRoute) {
    this.groupCode = route.snapshot.paramMap.get('groupCode')!;
  }

  parse(): void {
    parseLineRosterMessage(this.rawText());
    this.state.set('confirm');
  }
}
```

Replace `web/src/app/pages/group-entry/group-entry.html`:

```html
@if (state() === 'paste') {
  <textarea [(ngModel)]="rawText" rows="15" placeholder="Paste the LINE roster message here"></textarea>
  <button type="button" (click)="parse()">Parse</button>
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: PASS — 3 tests green (this file replaced the CLI's original single "should create" test, net test count for this file goes from 1 to 3).

- [ ] **Step 5: Commit**

```bash
git add web/src/app/pages/group-entry
git commit -m "feat: add paste state to GroupEntry"
```

---

### Task 5: `GroupEntry` — confirm state (header + name reviews)

**Files:**
- Modify: `web/src/app/pages/group-entry/group-entry.ts`
- Modify: `web/src/app/pages/group-entry/group-entry.html`
- Modify: `web/src/app/pages/group-entry/group-entry.spec.ts`

**Interfaces:**
- Consumes: `buildReviews` (Task 2), `RosterService.getPlayers` (Task 1)
- Produces: `date`, `venue`, `courtCount`, `rosterReviews`, `waitlistReviews` signals on `GroupEntry`; `canConfirm()`; `toggleDecision(review)`

- [ ] **Step 1: Write the failing test**

Append to `web/src/app/pages/group-entry/group-entry.spec.ts` (add a `RosterService` import and seed known players before parsing):

```ts
import { RosterService } from '../../core/roster.service';

it('prefills header fields from the parsed message', () => {
  component.rawText.set(
    '@All แบดวินนิ่ง อังคาร 8/9/26\n19.00-20.00 2 คอร์ท @ KIP\n1. ตั้ม\n2. เบส'
  );
  component.parse();
  expect(component.date()).toBe('2026-09-08');
  expect(component.courtCount()).toBe(2);
  expect(component.venue()).toBe('KIP');
});

it('classifies parsed names against known players', () => {
  const rosterService = TestBed.inject(RosterService);
  rosterService.savePlayers('group1', [{ id: 'p1', name: 'ตั้ม', aliases: [] }]);

  component.rawText.set('1. ตั้ม\n2. เกียร์');
  component.parse();

  expect(component.rosterReviews()[0].match).toEqual({ type: 'exact', playerId: 'p1' });
  expect(component.rosterReviews()[1].match).toEqual({ type: 'new' });
});

it('canConfirm is false until date and courtCount are set', () => {
  component.rawText.set('1. ตั้ม');
  component.parse();
  component.date.set('');
  component.courtCount.set(null);
  expect(component.canConfirm()).toBe(false);
  component.date.set('2026-09-08');
  component.courtCount.set(2);
  expect(component.canConfirm()).toBe(true);
});

it('toggleDecision flips a fuzzy review between accept and reject-new', () => {
  const rosterService = TestBed.inject(RosterService);
  rosterService.savePlayers('group1', [{ id: 'p1', name: 'ตั้ม', aliases: [] }]);

  component.rawText.set('1. ตัม'); // one tone mark short of ตั้ม -> fuzzy
  component.parse();

  const review = component.rosterReviews()[0];
  expect(review.decision).toBe('accept');
  component.toggleDecision(review);
  expect(component.rosterReviews()[0].decision).toBe('reject-new');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: FAIL — `date`/`courtCount`/`venue`/`rosterReviews`/`waitlistReviews`/`canConfirm`/`toggleDecision` don't exist yet.

- [ ] **Step 3: Write minimal implementation**

Replace `web/src/app/pages/group-entry/group-entry.ts`:

```ts
import { Component, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { parseLineRosterMessage } from '../../../../../parser.ts';
import { buildReviews, type NameReview } from '../../core/roster-review';
import { RosterService } from '../../core/roster.service';

@Component({
  selector: 'app-group-entry',
  imports: [FormsModule],
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

  constructor(
    route: ActivatedRoute,
    private rosterService: RosterService
  ) {
    this.groupCode = route.snapshot.paramMap.get('groupCode')!;
  }

  parse(): void {
    const result = parseLineRosterMessage(this.rawText());
    this.date.set(result.header.isoDate ?? '');
    this.venue.set(result.header.venue ?? '');
    this.courtCount.set(result.header.timeSlots[0]?.courtCount ?? null);

    const players = this.rosterService.getPlayers(this.groupCode);
    const rosterNames = result.roster
      .map((slot) => slot.name)
      .filter((name): name is string => name !== null);
    const waitlistNames = result.waitlist
      .map((slot) => slot.name)
      .filter((name): name is string => name !== null);

    this.rosterReviews.set(buildReviews(rosterNames, players));
    this.waitlistReviews.set(buildReviews(waitlistNames, players));

    this.state.set('confirm');
  }

  canConfirm(): boolean {
    return this.date().length > 0 && this.courtCount() !== null && this.courtCount()! > 0;
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
}
```

Replace `web/src/app/pages/group-entry/group-entry.html`:

```html
@if (state() === 'paste') {
  <textarea [(ngModel)]="rawText" rows="15" placeholder="Paste the LINE roster message here"></textarea>
  <button type="button" (click)="parse()">Parse</button>
}

@if (state() === 'confirm') {
  <label>
    Date
    <input type="date" [(ngModel)]="date" required />
  </label>
  <label>
    Court count
    <input type="number" [ngModel]="courtCount()" (ngModelChange)="courtCount.set($event)" required />
  </label>
  <label>
    Venue
    <input type="text" [(ngModel)]="venue" />
  </label>

  <h3>Roster</h3>
  @for (review of rosterReviews(); track review.inputName) {
    <div>
      {{ review.inputName }} —
      @switch (review.match.type) {
        @case ('exact') { <span>matched</span> }
        @case ('fuzzy') {
          <span>ใช่ [{{ review.match.playerId }}] ไหม?</span>
          <button type="button" (click)="toggleDecision(review)">
            {{ review.decision === 'accept' ? 'confirmed' : 'treat as new' }}
          </button>
        }
        @case ('new') { <span>new player</span> }
      }
    </div>
  }

  <h3>Waitlist</h3>
  @for (review of waitlistReviews(); track review.inputName) {
    <div>
      {{ review.inputName }} —
      @switch (review.match.type) {
        @case ('exact') { <span>matched</span> }
        @case ('fuzzy') {
          <span>ใช่ [{{ review.match.playerId }}] ไหม?</span>
          <button type="button" (click)="toggleDecision(review)">
            {{ review.decision === 'accept' ? 'confirmed' : 'treat as new' }}
          </button>
        }
        @case ('new') { <span>new player</span> }
      }
    </div>
  }

  <button type="button" [disabled]="!canConfirm()">Confirm roster</button>
}
```

The "Confirm roster" button has no click handler yet — Task 6 wires it up.

- [ ] **Step 4: Run test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: PASS — 4 new tests green.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/pages/group-entry
git commit -m "feat: add confirm state (header + name review) to GroupEntry"
```

---

### Task 6: `GroupEntry` — confirm submission

**Files:**
- Modify: `web/src/app/pages/group-entry/group-entry.ts`
- Modify: `web/src/app/pages/group-entry/group-entry.html`
- Modify: `web/src/app/pages/group-entry/group-entry.spec.ts`

**Interfaces:**
- Consumes: `resolveReviews` (Task 3), `RosterService.savePlayers`/`createSession` (Task 1), `interface Session` (Task 1)
- Produces: `confirmRoster()` on `GroupEntry`, navigates to `/s/:sessionCode` on success

- [ ] **Step 1: Write the failing test**

Append to `web/src/app/pages/group-entry/group-entry.spec.ts` (add `Router` to imports):

```ts
import { Router } from '@angular/router';

it('confirmRoster persists players and session, then navigates to the new session', async () => {
  const rosterService = TestBed.inject(RosterService);
  const router = TestBed.inject(Router);

  component.rawText.set('1. ตั้ม\n2. เกียร์');
  component.parse();
  component.date.set('2026-09-08');
  component.courtCount.set(2);
  component.venue.set('KIP');

  component.confirmRoster();

  const players = rosterService.getPlayers('group1');
  expect(players).toHaveLength(2);
  expect(players.map((p) => p.name)).toEqual(['ตั้ม', 'เกียร์']);

  expect(router.url).toMatch(/^\/s\//);
  const sessionCode = router.url.split('/s/')[1];
  const session = rosterService.getSession(sessionCode);
  expect(session).toMatchObject({
    groupCode: 'group1',
    date: '2026-09-08',
    courtCount: 2,
    venue: 'KIP',
  });
  expect(session?.rosterPlayerIds).toHaveLength(2);
});
```

(This test navigates for real via the router configured with `provideRouter(routes)` in Task 4's `beforeEach` — confirmed necessary: `provideRouter([])` with an empty route table makes `navigateByUrl` reject with `NG04002: Cannot match any routes`, it does not just quietly update `router.url`. Using the real `routes` (which do have a matching `/s/:sessionCode` route) is required, not optional.)

- [ ] **Step 2: Run test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: FAIL — `confirmRoster` does not exist on `GroupEntry` yet.

- [ ] **Step 3: Write minimal implementation**

Modify `web/src/app/pages/group-entry/group-entry.ts` — add the `Router` and `resolveReviews`/`Session` imports, inject `Router`, and add the method:

```ts
import { Router } from '@angular/router';
import { buildReviews, resolveReviews, type NameReview } from '../../core/roster-review';
import type { Session } from '../../core/session.model';

// inside the constructor, alongside the existing params:
  constructor(
    route: ActivatedRoute,
    private rosterService: RosterService,
    private router: Router
  ) {
    this.groupCode = route.snapshot.paramMap.get('groupCode')!;
  }

// new method on the class:
  confirmRoster(): void {
    let players = this.rosterService.getPlayers(this.groupCode);

    const roster = resolveReviews(this.rosterReviews(), players);
    players = roster.players;
    const waitlist = resolveReviews(this.waitlistReviews(), players);
    players = waitlist.players;

    this.rosterService.savePlayers(this.groupCode, players);

    const session: Session = {
      code: crypto.randomUUID().slice(0, 8),
      groupCode: this.groupCode,
      date: this.date(),
      venue: this.venue() || null,
      courtCount: this.courtCount(),
      rawImportText: this.rawText(),
      rosterPlayerIds: roster.playerIds,
      waitlistPlayerIds: waitlist.playerIds,
    };
    this.rosterService.createSession(session);

    this.router.navigateByUrl(`/s/${session.code}`);
  }
```

Modify `web/src/app/pages/group-entry/group-entry.html` — wire up the button:

```html
<button type="button" [disabled]="!canConfirm()" (click)="confirmRoster()">Confirm roster</button>
```

- [ ] **Step 4: Run test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: PASS. If the `router.url` assertion behaves unexpectedly against an empty route table (per the Step 1 note), fix by switching that one spec's `provideRouter([])` to `provideRouter(routes)` (imported from `../../app.routes`) and re-run — do not change `confirmRoster`'s implementation to work around a test-setup issue.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/pages/group-entry
git commit -m "feat: wire up roster confirmation submission in GroupEntry"
```

---

### Task 7: `SessionDashboard` — roster chips

**Files:**
- Modify: `web/src/app/pages/session-dashboard/session-dashboard.ts`
- Modify: `web/src/app/pages/session-dashboard/session-dashboard.html`
- Modify: `web/src/app/pages/session-dashboard/session-dashboard.spec.ts`

**Interfaces:**
- Consumes: `RosterService.getSession`/`getPlayers` (Task 1)
- Produces: `SessionDashboard` component with a `rosterNames: Signal<string[]>` computed from the stored session

- [ ] **Step 1: Write the failing test**

Replace `web/src/app/pages/session-dashboard/session-dashboard.spec.ts`:

```ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { SessionDashboard } from './session-dashboard';
import { RosterService } from '../../core/roster.service';

describe('SessionDashboard', () => {
  let component: SessionDashboard;
  let fixture: ComponentFixture<SessionDashboard>;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [SessionDashboard],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { paramMap: convertToParamMap({ sessionCode: 'sess1' }) },
          },
        },
      ],
    }).compileComponents();
  });

  it('renders the confirmed roster as chips', async () => {
    const rosterService = TestBed.inject(RosterService);
    rosterService.savePlayers('group1', [
      { id: 'p1', name: 'ตั้ม', aliases: [] },
      { id: 'p2', name: 'เบส', aliases: [] },
    ]);
    rosterService.createSession({
      code: 'sess1',
      groupCode: 'group1',
      date: '2026-09-08',
      venue: null,
      courtCount: 1,
      rawImportText: '',
      rosterPlayerIds: ['p1', 'p2'],
      waitlistPlayerIds: [],
    });

    fixture = TestBed.createComponent(SessionDashboard);
    component = fixture.componentInstance;
    await fixture.whenStable();

    expect(component.rosterNames()).toEqual(['ตั้ม', 'เบส']);

    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('ตั้ม');
    expect(text).toContain('เบส');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: FAIL — `rosterNames` does not exist on the current placeholder `SessionDashboard`.

- [ ] **Step 3: Write minimal implementation**

Replace `web/src/app/pages/session-dashboard/session-dashboard.ts`:

```ts
import { Component, computed, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { RosterService } from '../../core/roster.service';

@Component({
  selector: 'app-session-dashboard',
  imports: [],
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

  constructor(
    route: ActivatedRoute,
    private rosterService: RosterService
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/pages/session-dashboard
git commit -m "feat: render confirmed roster as chips on SessionDashboard"
```

---

## Post-implementation

Update `PROJECT.md`:
- §7.4: note the roster panel (paste → confirm → collapsed chips) is built; court panels, waiting queue, and display content remain.
- §8 checklist: build-order item 4 stays unchecked (court panels + display are still outstanding) — do not check it off yet.
