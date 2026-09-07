# Display View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the read-only venue display (`/s/:sessionCode/display`) — big text, no host controls, manual refresh. Last of 4 pieces implementing `PROJECT.md` §7's UI/UX design. Along the way, add a real `Group` entity (name, editable) that was always in the schema (§5) but never actually built — `GroupEntry` only ever used the opaque `groupCode`, nothing nameable, and the display's header needs a name to show.

**Architecture:** `SessionDisplay` gets its own component-scoped `LiveSessionService` instance (same pattern as `SessionDashboard` — both read the same `localStorage` key for a given `sessionCode`, so no new plumbing needed there). Only `active` courts render a pairing; `idle`/`pending` courts render as "waiting" — a confirmed decision, so players never see a pairing that might still get reshuffled away. A small `resolvePlayerNames` pure function replaces the id→name lookup pattern duplicated across `SessionDashboard` and the new `SessionDisplay`.

**Tech Stack:** Angular 22 standalone components + signals (same as prior pieces).

**Spec:** `PROJECT.md` §7.3 ("Display view") and §5 (`Group — id, name/link-code`, not yet built).

## Global Constraints

- Group naming is a real feature, not a display-view-only convenience: it persists on the `Group` record (`localStorage` key `group:${groupCode}`), editable from `GroupEntry`, and used across every future session under that group — not just this one display's header.
- Display only ever shows `active` court pairings. `idle` and `pending` courts render identically as "waiting" from the display's perspective — confirmed with the user: a court's proposed-but-unconfirmed pairing must never reach the venue screen, since the host might still reshuffle it.
- Header fallback when no `Group.name` is set: `session.venue ? \`${session.date} · ${session.venue}\` : session.date` — `session.date` is guaranteed non-empty for any existing `Session` (`GroupEntry.canConfirm()` already requires it before a session can be created).
- `LiveSessionService.refresh()` re-runs the existing private load-from-storage logic and re-sets the `courts`/`matches` signals — this is the same state-loading code already proven at construction time (the court-panels plan's "fresh instance picks up persisted state" test), just made re-callable so the display's `[↻ refresh]` button has something to call without recreating the whole component.
- Run tests with `npx ng test --watch=false` from `web/` (prefix `PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"` if Node needs pinning).

---

## File Structure

- Create: `web/src/app/core/group.model.ts` — the `Group` interface.
- Modify: `web/src/app/core/roster.service.ts` — add `getGroup`/`saveGroup`.
- Create: `web/src/app/core/player-names.ts` — `resolvePlayerNames(ids, players): string[]`.
- Modify: `web/src/app/core/live-session.service.ts` — add `refresh()`.
- Modify: `web/src/app/pages/group-entry/group-entry.ts` + `.html` — editable group-name field.
- Modify: `web/src/app/pages/session-dashboard/session-dashboard.ts` — use `resolvePlayerNames` instead of the inline `Map` pattern (no behavior change, just de-duplication).
- Modify: `web/src/app/pages/session-display/session-display.ts` + `.html` — the actual display view.
- Create/modify matching `.spec.ts` for each piece above.

---

### Task 1: `Group` model + `RosterService.getGroup`/`saveGroup`

**Files:**
- Create: `web/src/app/core/group.model.ts`
- Modify: `web/src/app/core/roster.service.ts`
- Modify: `web/src/app/core/roster.service.spec.ts`

**Interfaces:**
- Produces:
  - `interface Group { code: string; name: string | null }`
  - `RosterService.getGroup(groupCode: string): Group | null`
  - `RosterService.saveGroup(group: Group): void`

- [ ] **Step 1: Write the failing test**

Create `web/src/app/core/group.model.ts`:

```ts
export interface Group {
  code: string;
  name: string | null;
}
```

Append to `web/src/app/core/roster.service.spec.ts` (add `Group` to the existing `type Session` import line as a separate import):

```ts
import type { Group } from './group.model';

it('getGroup returns null when nothing is stored', () => {
  expect(service.getGroup('group1')).toBeNull();
});

it('saveGroup then getGroup round-trips', () => {
  const group: Group = { code: 'group1', name: 'Group A' };
  service.saveGroup(group);
  expect(service.getGroup('group1')).toEqual(group);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: FAIL — `getGroup`/`saveGroup` do not exist on `RosterService` yet.

- [ ] **Step 3: Write minimal implementation**

Modify `web/src/app/core/roster.service.ts` — add the import and two methods:

```ts
import type { Group } from './group.model';

// add as methods on the class:
  getGroup(groupCode: string): Group | null {
    const raw = localStorage.getItem(`group:${groupCode}`);
    return raw ? JSON.parse(raw) : null;
  }

  saveGroup(group: Group): void {
    localStorage.setItem(`group:${group.code}`, JSON.stringify(group));
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: PASS — 2 new tests green.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/core/group.model.ts web/src/app/core/roster.service.ts web/src/app/core/roster.service.spec.ts
git commit -m "feat: add Group model and RosterService.getGroup/saveGroup"
```

---

### Task 2: `resolvePlayerNames` + refactor `SessionDashboard`

**Files:**
- Create: `web/src/app/core/player-names.ts`
- Create: `web/src/app/core/player-names.spec.ts`
- Modify: `web/src/app/pages/session-dashboard/session-dashboard.ts`

**Interfaces:**
- Consumes: `type Player` from `../../../../fuzzy-match.ts` (already built)
- Produces: `resolvePlayerNames(ids: string[], players: Player[]): string[]`

- [ ] **Step 1: Write the failing test**

Create `web/src/app/core/player-names.spec.ts`:

```ts
import { resolvePlayerNames } from './player-names';
import type { Player } from '../../../../fuzzy-match.ts';

const players: Player[] = [
  { id: 'p1', name: 'ตั้ม', aliases: [] },
  { id: 'p2', name: 'เบส', aliases: [] },
];

describe('resolvePlayerNames', () => {
  it('resolves ids to names in order', () => {
    expect(resolvePlayerNames(['p2', 'p1'], players)).toEqual(['เบส', 'ตั้ม']);
  });

  it('falls back to the raw id when a player is not found', () => {
    expect(resolvePlayerNames(['p1', 'ghost'], players)).toEqual(['ตั้ม', 'ghost']);
  });

  it('returns an empty array for an empty input', () => {
    expect(resolvePlayerNames([], players)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: FAIL — `player-names.ts` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `web/src/app/core/player-names.ts`:

```ts
import type { Player } from '../../../../fuzzy-match.ts';

export function resolvePlayerNames(ids: string[], players: Player[]): string[] {
  const byId = new Map(players.map((p) => [p.id, p.name]));
  return ids.map((id) => byId.get(id) ?? id);
}
```

Modify `web/src/app/pages/session-dashboard/session-dashboard.ts` — replace the two inline `Map`-building blocks with calls to `resolvePlayerNames` (no behavior change, this is a pure refactor covered by the existing `session-dashboard.spec.ts` tests):

```ts
import { resolvePlayerNames } from '../../core/player-names';

// replace the body of `rosterNames`:
  readonly rosterNames = computed(() => {
    const session = this.rosterService.getSession(this.sessionCode);
    if (!session) return [];
    const players = this.rosterService.getPlayers(session.groupCode);
    return resolvePlayerNames(session.rosterPlayerIds, players);
  });

// replace the body of `waitingNames`:
  readonly waitingNames = computed(() => {
    const session = this.rosterService.getSession(this.sessionCode);
    if (!session) return [];
    const players = this.rosterService.getPlayers(session.groupCode);
    return resolvePlayerNames(this.liveSession.waitingPlayerIds(), players);
  });
```

- [ ] **Step 4: Run test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: PASS — 3 new tests in `player-names.spec.ts`, plus all pre-existing `session-dashboard.spec.ts` tests still green (this step is also the verification that the refactor didn't change behavior).

- [ ] **Step 5: Commit**

```bash
git add web/src/app/core/player-names.ts web/src/app/core/player-names.spec.ts web/src/app/pages/session-dashboard/session-dashboard.ts
git commit -m "feat: add resolvePlayerNames, de-duplicate id-to-name lookup in SessionDashboard"
```

---

### Task 3: `LiveSessionService.refresh()`

**Files:**
- Modify: `web/src/app/core/live-session.service.ts`
- Modify: `web/src/app/core/live-session.service.spec.ts`

**Interfaces:**
- Produces: `refresh(): void`

- [ ] **Step 1: Write the failing test**

Append to `web/src/app/core/live-session.service.spec.ts`:

```ts
it('refresh picks up state written to localStorage by another instance', () => {
  setUpSession('sess1', 1, ['p1', 'p2', 'p3', 'p4']);
  const first = TestBed.inject(LiveSessionService);
  expect(first.courts()[0]).toEqual({ status: 'idle' });

  const second = new LiveSessionService(
    TestBed.inject(ActivatedRoute),
    TestBed.inject(RosterService)
  );
  second.proposeMatch(1, () => 0.5);

  first.refresh();
  expect(first.courts()).toEqual(second.courts());
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: FAIL — `refresh` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Modify `web/src/app/core/live-session.service.ts` — extract the constructor's load logic so both the constructor and `refresh()` call it:

```ts
  constructor(
    route: ActivatedRoute,
    private rosterService: RosterService
  ) {
    this.sessionCode = route.snapshot.paramMap.get('sessionCode')!;
    const session = this.rosterService.getSession(this.sessionCode);
    this.rosterPlayerIds = session?.rosterPlayerIds ?? [];
    this.courtCount = session?.courtCount ?? 0;

    this.refresh();
  }

  refresh(): void {
    const stored = this.load();
    this.courts.set(
      stored?.courts ??
        Array.from({ length: this.courtCount }, () => ({ status: 'idle' as const }))
    );
    this.matches.set(stored?.matches ?? []);
  }
```

Add `private readonly courtCount: number;` alongside the existing `private readonly sessionCode: string;` field declaration, so `refresh()` can rebuild the default idle-courts array without re-reading `RosterService` every time.

- [ ] **Step 4: Run test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: PASS — 1 new test green, and all pre-existing tests in this file still green (this refactor must not change construction behavior).

- [ ] **Step 5: Commit**

```bash
git add web/src/app/core/live-session.service.ts web/src/app/core/live-session.service.spec.ts
git commit -m "feat: add LiveSessionService.refresh"
```

---

### Task 4: `GroupEntry` — editable group name

**Files:**
- Modify: `web/src/app/pages/group-entry/group-entry.ts`
- Modify: `web/src/app/pages/group-entry/group-entry.html`
- Modify: `web/src/app/pages/group-entry/group-entry.spec.ts`

**Interfaces:**
- Consumes: `RosterService.getGroup`/`saveGroup` (Task 1)
- Produces: `groupName: WritableSignal<string>`, `saveGroupName(): void` on `GroupEntry`

- [ ] **Step 1: Write the failing test**

Append to `web/src/app/pages/group-entry/group-entry.spec.ts`:

```ts
it('groupName is empty when no Group has been saved yet', () => {
  expect(component.groupName()).toBe('');
});

it('groupName prefills from a previously saved Group', async () => {
  const rosterService = TestBed.inject(RosterService);
  rosterService.saveGroup({ code: 'group1', name: 'Group A' });

  const other = TestBed.createComponent(GroupEntry);
  await other.whenStable();
  expect(other.componentInstance.groupName()).toBe('Group A');
});

it('saveGroupName persists the current groupName', () => {
  const rosterService = TestBed.inject(RosterService);
  component.groupName.set('Group A');
  component.saveGroupName();
  expect(rosterService.getGroup('group1')).toEqual({ code: 'group1', name: 'Group A' });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: FAIL — `groupName`/`saveGroupName` do not exist on `GroupEntry` yet.

- [ ] **Step 3: Write minimal implementation**

Modify `web/src/app/pages/group-entry/group-entry.ts` — add the field and method:

```ts
  readonly groupName = signal('');

  // inside the constructor body, after `this.groupCode = ...`:
    this.groupName.set(this.rosterService.getGroup(this.groupCode)?.name ?? '');

  // new method on the class:
  saveGroupName(): void {
    this.rosterService.saveGroup({ code: this.groupCode, name: this.groupName() || null });
  }
```

Modify `web/src/app/pages/group-entry/group-entry.html` — add the field above the `@if (state() === 'paste')` block, so it's visible in every state:

```html
<label>
  Group name
  <input type="text" [(ngModel)]="groupName" (blur)="saveGroupName()" placeholder="e.g. Group A" />
</label>
```

- [ ] **Step 4: Run test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: PASS — 3 new tests green.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/pages/group-entry
git commit -m "feat: add editable group name to GroupEntry"
```

---

### Task 5: `SessionDisplay`

**Files:**
- Modify: `web/src/app/pages/session-display/session-display.ts`
- Modify: `web/src/app/pages/session-display/session-display.html`
- Modify: `web/src/app/pages/session-display/session-display.spec.ts`

**Interfaces:**
- Consumes: `LiveSessionService` (component-scoped, own instance), `RosterService.getGroup`/`getSession`/`getPlayers`, `resolvePlayerNames` (Task 2)
- Produces: `SessionDisplay` with `header: Signal<string>`, `courtLines: Signal<{ courtNumber: number; text: string }[]>`, `waitingNames: Signal<string[]>`, `refresh(): void`

- [ ] **Step 1: Write the failing test**

Replace `web/src/app/pages/session-display/session-display.spec.ts`:

```ts
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { SessionDisplay } from './session-display';
import { LiveSessionService } from '../../core/live-session.service';
import { RosterService } from '../../core/roster.service';

describe('SessionDisplay', () => {
  let fixture: ComponentFixture<SessionDisplay>;
  let component: SessionDisplay;
  let rosterService: RosterService;

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [SessionDisplay],
      providers: [
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ sessionCode: 'sess1' }) } },
        },
      ],
    }).compileComponents();

    rosterService = TestBed.inject(RosterService);
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
      venue: 'KIP',
      courtCount: 1,
      rawImportText: '',
      rosterPlayerIds: ['p1', 'p2', 'p3', 'p4'],
      waitlistPlayerIds: [],
    });
  });

  it('shows the Group name as the header when one is set', async () => {
    rosterService.saveGroup({ code: 'group1', name: 'Group A' });
    fixture = TestBed.createComponent(SessionDisplay);
    component = fixture.componentInstance;
    await fixture.whenStable();
    expect(component.header()).toBe('Group A');
  });

  it('falls back to date + venue when no Group name is set', async () => {
    fixture = TestBed.createComponent(SessionDisplay);
    component = fixture.componentInstance;
    await fixture.whenStable();
    expect(component.header()).toBe('2026-09-08 · KIP');
  });

  it('shows "waiting" for an idle or pending court, never a proposed pairing', async () => {
    fixture = TestBed.createComponent(SessionDisplay);
    component = fixture.componentInstance;
    await fixture.whenStable();

    const liveSession = fixture.debugElement.injector.get(LiveSessionService);
    liveSession.proposeMatch(1, () => 0.5); // pending, not confirmed

    expect(component.courtLines()[0].text).toBe('waiting');
  });

  it('shows the pairing for an active court', async () => {
    fixture = TestBed.createComponent(SessionDisplay);
    component = fixture.componentInstance;
    await fixture.whenStable();

    const liveSession = fixture.debugElement.injector.get(LiveSessionService);
    liveSession.proposeMatch(1, () => 0.5);
    liveSession.confirmMatch(1);

    const line = component.courtLines()[0];
    expect(line.text).toContain('vs');
    expect(line.text).not.toBe('waiting');
  });

  it('clicking refresh calls liveSession.refresh', async () => {
    fixture = TestBed.createComponent(SessionDisplay);
    component = fixture.componentInstance;
    await fixture.whenStable();
    fixture.detectChanges();

    const liveSession = fixture.debugElement.injector.get(LiveSessionService);
    const spy = vi.spyOn(liveSession, 'refresh');

    const button = (fixture.nativeElement as HTMLElement).querySelector(
      'button'
    ) as HTMLButtonElement;
    button.click();

    expect(spy).toHaveBeenCalled();
  });

  it('lists waiting players by name', async () => {
    fixture = TestBed.createComponent(SessionDisplay);
    component = fixture.componentInstance;
    await fixture.whenStable();
    expect(component.waitingNames().sort()).toEqual(['ตั้ม', 'ปอม', 'เบส', 'ไม้'].sort());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: FAIL — `header`/`courtLines`/`waitingNames`/`refresh` do not exist on the current placeholder `SessionDisplay`.

- [ ] **Step 3: Write minimal implementation**

Replace `web/src/app/pages/session-display/session-display.ts`:

```ts
import { Component, computed } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { RosterService } from '../../core/roster.service';
import { LiveSessionService } from '../../core/live-session.service';
import { resolvePlayerNames } from '../../core/player-names';

@Component({
  selector: 'app-session-display',
  imports: [],
  providers: [LiveSessionService],
  templateUrl: './session-display.html',
  styleUrl: './session-display.css',
})
export class SessionDisplay {
  private readonly sessionCode: string;

  readonly header = computed(() => {
    const session = this.rosterService.getSession(this.sessionCode);
    if (!session) return '';
    const group = this.rosterService.getGroup(session.groupCode);
    if (group?.name) return group.name;
    return session.venue ? `${session.date} · ${session.venue}` : (session.date ?? '');
  });

  readonly courtLines = computed(() => {
    const session = this.rosterService.getSession(this.sessionCode);
    const players = session ? this.rosterService.getPlayers(session.groupCode) : [];
    return this.liveSession.courts().map((court, i) => {
      if (court.status !== 'active') {
        return { courtNumber: i + 1, text: 'waiting' };
      }
      const [a1, a2] = resolvePlayerNames(court.teamA, players);
      const [b1, b2] = resolvePlayerNames(court.teamB, players);
      return { courtNumber: i + 1, text: `${a1} + ${a2} vs ${b1} + ${b2}` };
    });
  });

  readonly waitingNames = computed(() => {
    const session = this.rosterService.getSession(this.sessionCode);
    if (!session) return [];
    const players = this.rosterService.getPlayers(session.groupCode);
    return resolvePlayerNames(this.liveSession.waitingPlayerIds(), players);
  });

  constructor(
    route: ActivatedRoute,
    private rosterService: RosterService,
    protected liveSession: LiveSessionService
  ) {
    this.sessionCode = route.snapshot.paramMap.get('sessionCode')!;
  }

  refresh(): void {
    this.liveSession.refresh();
  }
}
```

Replace `web/src/app/pages/session-display/session-display.html`:

```html
<h1>{{ header() }}</h1>

<div class="courts">
  @for (line of courtLines(); track line.courtNumber) {
    <div class="court-line">
      <h2>COURT {{ line.courtNumber }}</h2>
      <p>{{ line.text }}</p>
    </div>
  }
</div>

<p class="waiting-queue">รอคิว: {{ waitingNames().join(', ') }}</p>

<button type="button" (click)="refresh()">↻ refresh</button>
```

- [ ] **Step 4: Run test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: PASS — all 5 tests in this file green.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/pages/session-display
git commit -m "feat: build read-only SessionDisplay view"
```

---

## Post-implementation

Update `PROJECT.md`:
- §7.4: note the display view is built, and that `Group` (name, editable) is now a real entity.
- §8 checklist: check off build-order item 4 (`Angular screens`) — all 4 UI/UX pieces from §7 are now built.
