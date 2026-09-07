# Angular Scaffold + Routing Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold a fresh Angular app at `web/` with the three routes from `PROJECT.md` §7.1 wired to empty placeholder components — no panel logic yet (that's the next plan). First of 4 pieces implementing §7's UI/UX design; each piece ships working, testable software on its own.

**Architecture:** Standalone Angular components (no NgModules — Angular's current default), client-side only (`--ssr=false`, no server rendering needed for a share-link tool with no SEO surface), route-level code-splitting via `loadComponent` dynamic imports. Angular's own Vitest+jsdom test runner (confirmed the current CLI default — not Karma/Jasmine). Lives in `web/` at repo root, separate from the existing zero-dependency `parser.ts`/`fuzzy-match.ts`/`pairing.ts` engines and their `node --experimental-strip-types --test` setup, which this plan does not touch.

**Tech Stack:** Angular 22.x (current latest via `@angular/cli@latest`), TypeScript ~6.0, Vitest 4.x + jsdom (bundled by the CLI scaffold, not a manual choice), plain CSS.

**Spec:** `PROJECT.md` §7 ("UI/UX design") — this plan implements §7.1's routes only (`/g/:groupCode`, `/s/:sessionCode`, `/s/:sessionCode/display`); §7.2/§7.3's actual panel content is out of scope, deferred to the next plan.

## Global Constraints

- **Node ≥22.22.3 required.** Angular CLI 22.1.7 refuses to run on 22.22.2 (confirmed on this machine — `EBADENGINE`/explicit version check error). If on nvm, run `nvm install 22.22.3` once first. Each command in this plan prefixes `PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"` rather than `source nvm.sh && nvm use` — a sandboxed/worktree-isolated session may refuse `source`/`export`-based shell-init patterns as unverifiable, while a plain inline `PATH=... cmd` prefix is unambiguous and always works. Adjust the path if not using nvm, or if using a different installed version satisfying the CLI's requirement.
- Standalone components only — do not generate NgModules (`ng generate module` is not used anywhere in this plan; the CLI defaults to standalone already).
- SSR is disabled for this app (`--ssr=false` at scaffold time) — do not add `@angular/ssr` later without an explicit decision; this is a client-side SPA.
- Test runner is whatever `ng new` scaffolds by default (confirmed: Vitest + jsdom, via `@angular/build`'s `test` builder) — do not introduce Karma/Jasmine/Jest manually.
- Run tests with `npx ng test --watch=false` (from inside `web/`) — the default `watch: true` would hang a non-interactive session.
- The existing root-level engines (`parser.ts`, `fuzzy-match.ts`, `pairing.ts`, their `.test.ts` files, and `node --experimental-strip-types --test`) are untouched by this plan. How the Angular app will consume them is an open question for the *next* plan (roster panel / court panels) — do not attempt to wire that up here.

---

## File Structure

- Create: `web/` — the entire scaffolded Angular app (created by `ng new`, not hand-written).
- Modify: `web/src/app/app.html`, `web/src/app/app.ts`, `web/src/app/app.spec.ts` — strip the CLI's default marketing welcome page down to just a router outlet.
- Create: `web/src/app/pages/group-entry/`, `web/src/app/pages/session-dashboard/`, `web/src/app/pages/session-display/` — one placeholder component each, generated via `ng generate component`.
- Modify: `web/src/app/app.routes.ts` — the three routes.
- Create: `web/src/app/app.routes.spec.ts` — routing test.

---

### Task 1: Scaffold the Angular app

**Files:**
- Create: `web/` (entire scaffolded project)

**Interfaces:**
- Produces: a working Angular app skeleton at `web/`, buildable and testable, with an empty `routes` array.

- [ ] **Step 1: Confirm Node version**

Run: `PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" node --version`
Expected: `v22.22.3` (or higher — Angular CLI 22.1.7 requires `^22.22.3 || ^24.15.0 || >=26.0.0`)

- [ ] **Step 2: Scaffold the project**

From the repo root:

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" \
npx --yes @angular/cli@latest new web --routing --style=css --ssr=false --skip-git --defaults
```

This creates `web/` with a standalone-component app, `web/src/app/app.routes.ts` (initially `export const routes: Routes = [];`), and Vitest already configured — nothing to set up manually.

- [ ] **Step 3: Verify the baseline builds and tests pass**

```bash
cd web
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: `Test Files  1 passed (1)`, `Tests  2 passed (2)` (the CLI's own generated `app.spec.ts`, unmodified).

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng build
```

Expected: `Application bundle generation complete.` with no errors.

- [ ] **Step 4: Commit**

```bash
git add web
git commit -m "chore: scaffold Angular app"
```

---

### Task 2: Strip the default marketing template

The CLI scaffolds a full welcome/marketing page in `app.html` (~20KB) with a `<router-outlet />` buried inside it. Replace it with just the outlet — this app has no landing page, every route is a real screen.

**Files:**
- Modify: `web/src/app/app.html`
- Modify: `web/src/app/app.ts`
- Modify: `web/src/app/app.spec.ts`

**Interfaces:**
- No exported interface changes — `App` remains the root standalone component bootstrapped in `main.ts`.

- [ ] **Step 1: Replace `app.html`**

```html
<router-outlet />
```

- [ ] **Step 2: Simplify `app.ts`** (drop the unused `title` signal from the default scaffold)

```ts
import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  imports: [RouterOutlet],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {}
```

- [ ] **Step 3: Simplify `app.spec.ts`** (drop the assertion on the removed "Hello, web" title text)

```ts
import { TestBed } from '@angular/core/testing';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run tests to verify still passing**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: `Test Files  1 passed (1)`, `Tests  1 passed (1)`.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/app.html web/src/app/app.ts web/src/app/app.spec.ts
git commit -m "chore: strip default marketing template from app shell"
```

---

### Task 3: Generate the three page components

Plain `ng generate component` — each comes with its own passing "should create" spec already, nothing to hand-write.

**Files:**
- Create: `web/src/app/pages/group-entry/{group-entry.ts,group-entry.html,group-entry.css,group-entry.spec.ts}`
- Create: `web/src/app/pages/session-dashboard/{session-dashboard.ts,session-dashboard.html,session-dashboard.css,session-dashboard.spec.ts}`
- Create: `web/src/app/pages/session-display/{session-display.ts,session-display.html,session-display.css,session-display.spec.ts}`

**Interfaces:**
- Produces: `GroupEntry`, `SessionDashboard`, `SessionDisplay` — standalone components, no inputs/outputs yet.

- [ ] **Step 1: Generate the components**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng generate component pages/group-entry
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng generate component pages/session-dashboard
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng generate component pages/session-display
```

(Each line needs its own `PATH=...` prefix — it only applies to the single command it prefixes, not later lines in the same block.)

Each generates a component like:

```ts
import { Component } from '@angular/core';

@Component({
  imports: [],
  selector: 'app-group-entry',
  styleUrl: './group-entry.css',
  templateUrl: './group-entry.html',
})
export class GroupEntry {}
```

with a matching spec asserting `expect(component).toBeTruthy()` — the CLI writes this automatically, don't hand-edit it.

- [ ] **Step 2: Run tests to verify all three create successfully**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: `Test Files  4 passed (4)`, `Tests  4 passed (4)` (root `App` + 3 new components).

- [ ] **Step 3: Commit**

```bash
git add web/src/app/pages
git commit -m "feat: generate group-entry, session-dashboard, session-display placeholder components"
```

---

### Task 4: Wire up routing (TDD)

**Files:**
- Create: `web/src/app/app.routes.spec.ts`
- Modify: `web/src/app/app.routes.ts`

**Interfaces:**
- Consumes: `GroupEntry`, `SessionDashboard`, `SessionDisplay` (Task 3)
- Produces: `routes: Routes` — `/g/:groupCode`, `/s/:sessionCode`, `/s/:sessionCode/display` (per `PROJECT.md` §7.1)

- [ ] **Step 1: Write the failing test**

Create `web/src/app/app.routes.spec.ts`:

```ts
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from './app.routes';
import { GroupEntry } from './pages/group-entry/group-entry';
import { SessionDashboard } from './pages/session-dashboard/session-dashboard';
import { SessionDisplay } from './pages/session-display/session-display';

describe('app routes', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter(routes)],
    });
  });

  it('/g/:groupCode resolves to GroupEntry', async () => {
    const harness = await RouterTestingHarness.create();
    const component = await harness.navigateByUrl('/g/abc123', GroupEntry);
    expect(component).toBeInstanceOf(GroupEntry);
  });

  it('/s/:sessionCode resolves to SessionDashboard', async () => {
    const harness = await RouterTestingHarness.create();
    const component = await harness.navigateByUrl(
      '/s/xyz789',
      SessionDashboard
    );
    expect(component).toBeInstanceOf(SessionDashboard);
  });

  it('/s/:sessionCode/display resolves to SessionDisplay', async () => {
    const harness = await RouterTestingHarness.create();
    const component = await harness.navigateByUrl(
      '/s/xyz789/display',
      SessionDisplay
    );
    expect(component).toBeInstanceOf(SessionDisplay);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: FAIL — all 3 new tests fail with `Error: NG04002: Cannot match any routes. URL Segment: '...'` (confirmed exact error text; `routes` is still the empty array from scaffold).

- [ ] **Step 3: Write minimal implementation**

Replace `web/src/app/app.routes.ts`:

```ts
import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: 'g/:groupCode',
    loadComponent: () =>
      import('./pages/group-entry/group-entry').then((m) => m.GroupEntry),
  },
  {
    path: 's/:sessionCode/display',
    loadComponent: () =>
      import('./pages/session-display/session-display').then(
        (m) => m.SessionDisplay
      ),
  },
  {
    path: 's/:sessionCode',
    loadComponent: () =>
      import('./pages/session-dashboard/session-dashboard').then(
        (m) => m.SessionDashboard
      ),
  },
];
```

The `/display` route is listed before the plain `/s/:sessionCode` route — not load-bearing (Angular's router matches by segment count, so a 2-segment and 3-segment path never collide), but keeps the more specific route visually first for readers.

- [ ] **Step 4: Run test to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: PASS — `Test Files  5 passed (5)`, `Tests  7 passed (7)`.

- [ ] **Step 5: Commit**

```bash
git add web/src/app/app.routes.ts web/src/app/app.routes.spec.ts
git commit -m "feat: wire up routing for group entry, session dashboard, and display views"
```

---

### Task 5: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng test --watch=false
```

Expected: `Test Files  5 passed (5)`, `Tests  7 passed (7)`.

- [ ] **Step 2: Run a production build**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx ng build
```

Expected: `Application bundle generation complete.` — confirmed output includes separate lazy chunks per page (`group-entry`, `session-dashboard`, `session-display`), proving route-level code-splitting is actually working, not just configured. `web/.gitignore` already excludes `/dist` (confirmed — the CLI scaffold includes this by default), so the build output won't get committed.

No commit for this task — it's verification only, nothing changed.

---

## Post-implementation

Update `PROJECT.md`:
- §8 checklist: check off `Angular frontend scaffolded` under Infra.
- Note in §7 (or a new §7.4) that routing is built; panel content (roster/court/waiting-queue/display) is the next plan.
