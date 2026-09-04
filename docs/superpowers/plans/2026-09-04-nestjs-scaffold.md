# NestJS Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold a NestJS app at `server/` (sibling to `web/`) and prove it can import the root-level engines (`parser.ts`/`fuzzy-match.ts`/`pairing.ts`) by relative path, correctly at both compile time and runtime — no business logic yet. First piece of building the real backend decided in `PROJECT.md` §8 (engines run server-side, §8.1).

**Architecture:** `server/` lives at the repo root alongside `web/`, `parser.ts`, `fuzzy-match.ts`, `pairing.ts`. The engines stay exactly where they are — one source of truth, imported by relative path from `server/` the same way `web/` already imports them, with NestJS-specific tsconfig adjustments (different from, and stricter than, Angular's — verified empirically below, including one repo-root-level fix that was missing until now).

**Tech Stack:** NestJS 12 (current latest via `@nestjs/cli@latest`), TypeScript, ESM (`"type": "module"` — the current CLI default), Vitest (also the current CLI default, replacing the historical Jest default).

**Spec:** `PROJECT.md` §8 ("Backend design") — this plan implements the scaffold only; the API endpoints in §8.3 and the Prisma/DB schema in §8.2/§8.4 are separate, later plans.

## Global Constraints

- **The repo root already has a `package.json`** (`{"private": true, "type": "module"}`, added and committed as a prerequisite to this plan — not something this plan creates). This matters because under `"module": "nodenext"`, TypeScript determines each file's *compiled output format* (CJS vs ESM) by the nearest `package.json` walking up from that file. Without a root one, `parser.ts`/`fuzzy-match.ts`/`pairing.ts` (which have no closer `package.json` of their own) would compile to CommonJS when built via NestJS's `tsc`, while `server/`'s own files compile to ESM (its own `package.json` says so) — a format mismatch that fails at **runtime**, not compile time, with `SyntaxError: The requested module '../../pairing.js' does not provide an export named 'pairKey'`. Confirmed via a real build-and-run reproduction before this fix existed. Verified the fix doesn't affect `web/`'s build or the engines' own `node:test` suite (both still pass).
- **`npm install` needs `--legacy-peer-deps` in this project.** A plain `npm install` fails with `Cannot read properties of null (reading 'edgesOut')` — a known npm Arborist bug in peer-dependency resolution, not specific to this project (reproduces on a stock `nest new` with nothing added). Fix: `.npmrc` with `legacy-peer-deps=true` so every future install in `server/` picks it up automatically.
- **Cross-boundary engine imports need three tsconfig changes** (confirmed empirically — and confirmed that `nest build`, not `npm test`, is the thing that actually enforces two of them; NestJS's Vitest setup does not):
  1. `allowImportingTsExtensions: true` + `rewriteRelativeImportExtensions: true` in `tsconfig.json` (same two flags Angular needed).
  2. **`rootDir` widened past `src/`** in `tsconfig.build.json`, to the repo root: `"rootDir": ".."`, with each engine file explicitly added to `"include"` (`"include": ["src", "../parser.ts", "../fuzzy-match.ts", "../pairing.ts"]`) — do not `include` the whole repo root, just the specific files needed. Angular's esbuild-based bundler never enforced `rootDir` boundaries at all; NestJS's `tsc`-based build does, failing with `TS6059: File '...' is not under 'rootDir'` otherwise.
  3. **`npm test` (Vitest) does not exercise either of the above** — it passes even without them, since NestJS's Vitest setup transpiles per-file without NestJS's own stricter type constraints. Only `nest build` (the actual `tsc` compile) catches `TS5097`/`TS6059`. Any test proving this cross-boundary import works must include running `nest build`, not just `npm test`.
- **Widening `rootDir` changes the compiled output layout.** `dist/` now mirrors the wider root: `dist/pairing.js`, `dist/fuzzy-match.js`, `dist/parser.js` sit at the top of `dist/`, and the app's own files land one level deeper at `dist/server/src/...` instead of the default `dist/src/...`. The scaffold's default `"start:prod": "node dist/main"` script is wrong after this change (there is no `dist/main.js` — the entry point is `dist/server/src/main.js`) and must be updated as part of this plan, not left broken.
- A file only importing the engines from a **`.spec.ts` file** does not prove the cross-boundary import works for `nest build` — `tsconfig.build.json` excludes `**/*spec.ts` from the build entirely, so a spec-only import would never hit `TS6059` and give a false sense that the fix isn't needed. The proof must come from a plain (non-spec) `.ts` file, with the spec file testing *that* file.
- Run tests with `npx vitest run` (via `npm test`) from `server/`. Build with `npx nest build`; dev server with `npx nest start` (confirmed boots and serves on `:3000` by default).

---

## File Structure

- Create: `server/` — the entire scaffolded NestJS app (via `nest new`, not hand-written).
- Modify: `server/.npmrc` — `legacy-peer-deps=true`.
- Modify: `server/tsconfig.json` — the two extension flags.
- Modify: `server/tsconfig.build.json` — widened `rootDir` + explicit engine-file `include`.
- Modify: `server/package.json` — fix the `start:prod` script's path.
- Create: `server/src/engines-import-check.ts` — plain file proving the cross-boundary import compiles and runs.
- Create: `server/src/engines-import-check.spec.ts` — tests the file above.

---

### Task 1: Scaffold the NestJS app

**Files:**
- Create: `server/` (entire scaffolded project)

**Interfaces:**
- Produces: a working NestJS app skeleton at `server/`, buildable, testable, and runnable, with the default `AppController`/`AppService` untouched.

- [ ] **Step 1: Scaffold the project**

From the repo root:

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" \
npx --yes @nestjs/cli@latest new server --skip-git --package-manager npm --skip-install
```

`--skip-install` is deliberate — Step 2 installs with the required flag instead of the CLI's own (unflagged) install, which would otherwise fail per the Global Constraints note above.

- [ ] **Step 2: Add `.npmrc` and install**

Create `server/.npmrc`:

```
legacy-peer-deps=true
```

```bash
cd server
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npm install
```

Expected: installs cleanly (no `edgesOut` error).

- [ ] **Step 3: Verify the baseline builds, tests, and runs**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npm test
```

Expected: `Test Files  1 passed (1)`, `Tests  1 passed (1)` (the CLI's own generated `app.controller.spec.ts`, unmodified).

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx nest build
```

Expected: completes with no output (NestJS's build is silent on success) and produces `dist/src/main.js` (this default path is only correct *before* Task 2 widens `rootDir` — it moves in Task 2).

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx nest start &
```

Wait for `Nest application successfully started` in the output, then:

```bash
curl -s http://localhost:3000
```

Expected: `Hello World!`. Stop the server afterward (`lsof -ti:3000 -sTCP:LISTEN | xargs -r kill`).

- [ ] **Step 4: Commit**

```bash
git add server
git commit -m "chore: scaffold NestJS app"
```

---

### Task 2: Cross-boundary engine imports (TDD)

**Files:**
- Create: `server/src/engines-import-check.ts`
- Create: `server/src/engines-import-check.spec.ts`
- Modify: `server/tsconfig.json`
- Modify: `server/tsconfig.build.json`
- Modify: `server/package.json`

**Interfaces:**
- Consumes: `pairKey` from `../../pairing.ts` (already built)
- Produces: `checkPairKey` (re-exported `pairKey`) — exists only to prove the import path is viable for future tasks to build real engine-backed endpoints on

- [ ] **Step 1: Write the failing files**

Create `server/src/engines-import-check.ts`:

```ts
import { pairKey } from '../../pairing.ts';

export const checkPairKey = pairKey;
```

Create `server/src/engines-import-check.spec.ts`:

```ts
import { checkPairKey } from './engines-import-check';

describe('cross-boundary engine import', () => {
  it('can call a real function from the root-level pairing.ts', () => {
    expect(checkPairKey('b', 'a')).toBe('a|b');
  });
});
```

- [ ] **Step 2: Run `nest build` to verify it fails**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx nest build
```

Expected: FAIL, two errors on the same import line:
`TS5097: An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled.`
`TS6059: File '.../pairing.ts' is not under 'rootDir' '.../server/src'.`

(`npm test` at this point already **passes** — that's expected and not a signal anything is fine; Vitest doesn't enforce either error here. Don't skip the `nest build` check based on a passing `npm test`.)

- [ ] **Step 3: Write minimal implementation**

Modify `server/tsconfig.json` — add to `compilerOptions`:

```json
"allowImportingTsExtensions": true,
"rewriteRelativeImportExtensions": true,
```

Modify `server/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": ".."
  },
  "include": ["src", "../parser.ts", "../fuzzy-match.ts", "../pairing.ts"],
  "exclude": ["node_modules", "test", "dist", "**/*spec.ts"]
}
```

Modify `server/package.json`'s `start:prod` script (the widened `rootDir` moves the compiled entry point):

```json
"start:prod": "node dist/server/src/main",
```

- [ ] **Step 4: Run `nest build` to verify it passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npx nest build
```

Expected: PASS (no output). Confirm the new output layout:

```bash
ls dist/pairing.js dist/fuzzy-match.js dist/parser.js dist/server/src/main.js
```

Expected: all four paths exist.

- [ ] **Step 5: Verify the compiled cross-boundary import actually runs, not just compiles**

```bash
"$HOME/.nvm/versions/node/v22.22.3/bin/node" -e "import('./dist/server/src/engines-import-check.js').then(m => console.log('checkPairKey result:', m.checkPairKey('b', 'a')))"
```

Expected: `checkPairKey result: a|b`. If this instead throws `does not provide an export named 'pairKey'`, the repo-root `package.json`'s `"type": "module"` is missing or was reverted — re-check the Global Constraints prerequisite, don't try to work around it here.

- [ ] **Step 6: Run `npm test` to confirm it still passes**

```bash
PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH" npm test
```

Expected: `Test Files  2 passed (2)`, `Tests  2 passed (2)`.

- [ ] **Step 7: Commit**

```bash
git add server
git commit -m "feat: prove cross-boundary import of root-level engines works in NestJS"
```

---

## Post-implementation

Update `PROJECT.md`:
- §9 checklist: check off `NestJS backend scaffolded` under Infra.
- Note in §8 that the scaffold is built and the cross-boundary import is proven (including the repo-root `package.json` fix and the `dist/server/src/main.js` output-path change); the actual API endpoints (§8.3) and Prisma schema (§8.2/§8.4) are the next plans.
