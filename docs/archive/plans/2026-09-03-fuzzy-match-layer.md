# Fuzzy-Match Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match parsed roster/waitlist names (from `parser.ts`) against known `Player` records for a group, using exact match for auto-link and normalized Levenshtein similarity for fuzzy suggestions — never silently auto-linking a fuzzy guess.

**Architecture:** A single pure, dependency-free TS module (`fuzzy-match.ts`) at repo root, sibling to `parser.ts`, following its no-framework/no-npm-dependency style. All functions operate on plain in-memory `Player[]` arrays — no DB/backend exists yet (per `PROJECT.md` §7 checklist), so persistence (saving a confirmed alias) is modeled as a pure function returning a new array, ready for a future caller to persist.

**Tech Stack:** TypeScript, run via Node 22's native type-stripping (`node --experimental-strip-types`, verified working on this machine — Node v22.22.2). Tests use Node's built-in `node:test` + `node:assert/strict` — zero npm dependencies, nothing to install.

**Spec:** `PROJECT.md` §6.2 ("Fuzzy-match layer — decided, not built") — this plan implements that section verbatim; read it alongside this plan.

## Global Constraints

- No npm dependencies, for implementation or test running — use Node's built-in `node:test`/`node:assert/strict`, executed via `node --experimental-strip-types` (matches `parser.ts`'s zero-dependency style; `PROJECT.md` §6.2 point 5).
- Fuzzy match never auto-links — only an exact match (post-normalize) auto-links. A fuzzy match (score ≥ 0.7) always surfaces as a suggestion requiring host confirm/reject (`PROJECT.md` §6.2).
- Fuzzy threshold is 0.7, inclusive. Similarity = `1 - levenshteinDistance(a, b) / max(a.length, b.length)` (`PROJECT.md` §6.2 step 3).
- Normalization = strip a trailing `(...)` note, trim, Unicode NFC — applied at match time to both the input name and each known name/alias. Stored `Player.aliases` keep the raw pasted text, not the normalized form (`PROJECT.md` §6.2 steps 1 and 4).

---

## File Structure

- Create: `fuzzy-match.ts` — types (`Player`, `NameMatch`, `RosterNameMatch`) + all matching/confirm functions.
- Create: `fuzzy-match.test.ts` — `node:test` suite, grows one `test()` block per task.

Both live at repo root, matching the existing flat layout (`parser.ts`, `test-examples.ts` — no `src/` directory in this repo).

---

### Task 1: `normalizeName`

**Files:**
- Create: `fuzzy-match.ts`
- Create: `fuzzy-match.test.ts`

**Interfaces:**
- Produces: `normalizeName(name: string): string`

- [ ] **Step 1: Write the failing test**

Create `fuzzy-match.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName } from './fuzzy-match.ts';

test('normalizeName strips a trailing (...) note', () => {
  assert.equal(normalizeName('พี่แวน(พี่ที่ทำงานไกด์)'), 'พี่แวน');
});

test('normalizeName trims surrounding whitespace', () => {
  assert.equal(normalizeName('  ตั้ม  '), 'ตั้ม');
});

test('normalizeName applies Unicode NFC', () => {
  // 'e' + combining acute accent (U+0301) -> precomposed 'é' (U+00E9)
  assert.equal(normalizeName('é'), 'é');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test fuzzy-match.test.ts`
Expected: FAIL — `fuzzy-match.ts` doesn't exist yet (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `fuzzy-match.ts`:

```ts
/**
 * Matches parsed roster/waitlist names against known Player records for a
 * group. Exact match (post-normalize) auto-links; fuzzy match only ever
 * surfaces as a suggestion — never auto-links. See PROJECT.md §6.2.
 */

const TRAILING_PAREN_NOTE_RE = /\s*\([^)]*\)\s*$/;

export function normalizeName(name: string): string {
  return name.replace(TRAILING_PAREN_NOTE_RE, '').trim().normalize('NFC');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test fuzzy-match.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add fuzzy-match.ts fuzzy-match.test.ts
git commit -m "feat: add normalizeName for fuzzy-match layer"
```

---

### Task 2: `levenshteinDistance`

**Files:**
- Modify: `fuzzy-match.ts`
- Modify: `fuzzy-match.test.ts`

**Interfaces:**
- Produces: `levenshteinDistance(a: string, b: string): number`

- [ ] **Step 1: Write the failing test**

Append to `fuzzy-match.test.ts`:

```ts
import { levenshteinDistance } from './fuzzy-match.ts';

test('levenshteinDistance is 0 for identical strings', () => {
  assert.equal(levenshteinDistance('ตั้ม', 'ตั้ม'), 0);
});

test('levenshteinDistance counts one substitution', () => {
  assert.equal(levenshteinDistance('ตั้ม', 'ตัม'), 1);
});

test('levenshteinDistance counts appended characters', () => {
  // real example from PROJECT.md §6.2: เกีย -> เกียร์ is 2 chars appended (ร, ์)
  assert.equal(levenshteinDistance('เกีย', 'เกียร์'), 2);
});

test('levenshteinDistance handles an empty string', () => {
  assert.equal(levenshteinDistance('', 'abc'), 3);
  assert.equal(levenshteinDistance('abc', ''), 3);
});
```

(Add the new `import { levenshteinDistance } from './fuzzy-match.ts';` line alongside the existing `normalizeName` import at the top of the file rather than duplicating the import statement.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test fuzzy-match.test.ts`
Expected: FAIL — `levenshteinDistance` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Append to `fuzzy-match.ts`:

```ts
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test fuzzy-match.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add fuzzy-match.ts fuzzy-match.test.ts
git commit -m "feat: add levenshteinDistance for fuzzy-match layer"
```

---

### Task 3: `similarity`

**Files:**
- Modify: `fuzzy-match.ts`
- Modify: `fuzzy-match.test.ts`

**Interfaces:**
- Consumes: `levenshteinDistance(a: string, b: string): number` (Task 2)
- Produces: `similarity(a: string, b: string): number`

- [ ] **Step 1: Write the failing test**

Append to `fuzzy-match.test.ts` (add `similarity` to the existing `from './fuzzy-match.ts'` import):

```ts
test('similarity is 1 for identical strings', () => {
  assert.equal(similarity('ตั้ม', 'ตั้ม'), 1);
});

test('similarity of a one-char-off pair clears the 0.7 threshold', () => {
  // ตั้ม vs ตัม: distance 1, maxLen 4 -> 0.75
  assert.equal(similarity('ตั้ม', 'ตัม'), 0.75);
});

test('similarity of เกีย vs เกียร์ falls below the 0.7 threshold', () => {
  // distance 2, maxLen 6 -> 0.6667 — PROJECT.md §6.2 calls these distinct players
  assert.ok(similarity('เกีย', 'เกียร์') < 0.7);
});

test('similarity handles two empty strings', () => {
  assert.equal(similarity('', ''), 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test fuzzy-match.test.ts`
Expected: FAIL — `similarity` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Append to `fuzzy-match.ts`:

```ts
export function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test fuzzy-match.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add fuzzy-match.ts fuzzy-match.test.ts
git commit -m "feat: add similarity for fuzzy-match layer"
```

---

### Task 4: `Player`/`NameMatch` types + `matchName`

**Files:**
- Modify: `fuzzy-match.ts`
- Modify: `fuzzy-match.test.ts`

**Interfaces:**
- Consumes: `normalizeName(name: string): string` (Task 1), `similarity(a: string, b: string): number` (Task 3)
- Produces:
  - `interface Player { id: string; name: string; aliases: string[] }`
  - `type NameMatch = { type: 'exact'; playerId: string } | { type: 'fuzzy'; playerId: string; score: number } | { type: 'new' }`
  - `matchName(inputName: string, players: Player[]): NameMatch`

- [ ] **Step 1: Write the failing test**

Append to `fuzzy-match.test.ts` (add `matchName` and the type imports to the existing import — types can be imported the same way as values in this codebase's `import type`-free style, matching `parser.ts`):

```ts
import { matchName, type Player } from './fuzzy-match.ts';

const players: Player[] = [
  { id: 'p1', name: 'ตั้ม', aliases: [] },
  { id: 'p2', name: 'เบส', aliases: [] },
  { id: 'p3', name: 'พี่แวน', aliases: [] },
];

test('matchName exact-matches on Player.name after normalizing', () => {
  const result = matchName('ตั้ม', players);
  assert.deepEqual(result, { type: 'exact', playerId: 'p1' });
});

test('matchName exact-matches a parenthetical note against the stored name', () => {
  const result = matchName('พี่แวน(พี่ที่ทำงานไกด์)', players);
  assert.deepEqual(result, { type: 'exact', playerId: 'p3' });
});

test('matchName exact-matches on an alias', () => {
  const withAlias: Player[] = [{ id: 'p1', name: 'ตั้ม', aliases: ['ตั้มมี่'] }];
  const result = matchName('ตั้มมี่', withAlias);
  assert.deepEqual(result, { type: 'exact', playerId: 'p1' });
});

test('matchName suggests a fuzzy match above the 0.7 threshold', () => {
  const result = matchName('ตัม', players); // one tone mark short of ตั้ม
  assert.equal(result.type, 'fuzzy');
  assert.equal((result as { playerId: string }).playerId, 'p1');
});

test('matchName flags a name below the 0.7 threshold as new', () => {
  const result = matchName('เกียร์', players); // real example from PROJECT.md §6.2 — no close match here
  assert.deepEqual(result, { type: 'new' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test fuzzy-match.test.ts`
Expected: FAIL — `matchName`/`Player` are not exported yet.

- [ ] **Step 3: Write minimal implementation**

Append to `fuzzy-match.ts`:

```ts
export interface Player {
  id: string;
  name: string;
  aliases: string[];
}

export type NameMatch =
  | { type: 'exact'; playerId: string }
  | { type: 'fuzzy'; playerId: string; score: number }
  | { type: 'new' };

const FUZZY_THRESHOLD = 0.7;

export function matchName(inputName: string, players: Player[]): NameMatch {
  const normalizedInput = normalizeName(inputName);

  for (const player of players) {
    const candidates = [player.name, ...player.aliases];
    if (candidates.some((c) => normalizeName(c) === normalizedInput)) {
      return { type: 'exact', playerId: player.id };
    }
  }

  let bestPlayerId: string | null = null;
  let bestScore = 0;
  for (const player of players) {
    const candidates = [player.name, ...player.aliases];
    for (const candidate of candidates) {
      const score = similarity(normalizedInput, normalizeName(candidate));
      if (score > bestScore) {
        bestScore = score;
        bestPlayerId = player.id;
      }
    }
  }

  if (bestPlayerId !== null && bestScore >= FUZZY_THRESHOLD) {
    return { type: 'fuzzy', playerId: bestPlayerId, score: bestScore };
  }

  return { type: 'new' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test fuzzy-match.test.ts`
Expected: PASS (16 tests)

- [ ] **Step 5: Commit**

```bash
git add fuzzy-match.ts fuzzy-match.test.ts
git commit -m "feat: add matchName for fuzzy-match layer"
```

---

### Task 5: `matchRoster`

**Files:**
- Modify: `fuzzy-match.ts`
- Modify: `fuzzy-match.test.ts`

**Interfaces:**
- Consumes: `matchName(inputName: string, players: Player[]): NameMatch` (Task 4)
- Produces:
  - `interface RosterNameMatch { inputName: string; match: NameMatch }`
  - `matchRoster(names: string[], players: Player[]): RosterNameMatch[]`

- [ ] **Step 1: Write the failing test**

Append to `fuzzy-match.test.ts` (add `matchRoster` to the existing import):

```ts
test('matchRoster maps each name through matchName, preserving order', () => {
  const result = matchRoster(['ตั้ม', 'เกียร์'], players);
  assert.deepEqual(result, [
    { inputName: 'ตั้ม', match: { type: 'exact', playerId: 'p1' } },
    { inputName: 'เกียร์', match: { type: 'new' } },
  ]);
});

test('matchRoster returns an empty array for an empty input', () => {
  assert.deepEqual(matchRoster([], players), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test fuzzy-match.test.ts`
Expected: FAIL — `matchRoster` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Append to `fuzzy-match.ts`:

```ts
export interface RosterNameMatch {
  inputName: string;
  match: NameMatch;
}

export function matchRoster(names: string[], players: Player[]): RosterNameMatch[] {
  return names.map((inputName) => ({ inputName, match: matchName(inputName, players) }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test fuzzy-match.test.ts`
Expected: PASS (18 tests)

- [ ] **Step 5: Commit**

```bash
git add fuzzy-match.ts fuzzy-match.test.ts
git commit -m "feat: add matchRoster for fuzzy-match layer"
```

---

### Task 6: `confirmExistingPlayerAlias`

**Files:**
- Modify: `fuzzy-match.ts`
- Modify: `fuzzy-match.test.ts`

**Interfaces:**
- Consumes: `interface Player` (Task 4)
- Produces: `confirmExistingPlayerAlias(players: Player[], playerId: string, rawInputName: string): Player[]`

- [ ] **Step 1: Write the failing test**

Append to `fuzzy-match.test.ts` (add `confirmExistingPlayerAlias` to the existing import):

```ts
test('confirmExistingPlayerAlias adds the raw pasted text as a new alias', () => {
  const before: Player[] = [{ id: 'p1', name: 'ตั้ม', aliases: [] }];
  const after = confirmExistingPlayerAlias(before, 'p1', 'ตัม');
  assert.deepEqual(after, [{ id: 'p1', name: 'ตั้ม', aliases: ['ตัม'] }]);
});

test('confirmExistingPlayerAlias does not duplicate an existing alias', () => {
  const before: Player[] = [{ id: 'p1', name: 'ตั้ม', aliases: ['ตัม'] }];
  const after = confirmExistingPlayerAlias(before, 'p1', 'ตัม');
  assert.deepEqual(after, [{ id: 'p1', name: 'ตั้ม', aliases: ['ตัม'] }]);
});

test('confirmExistingPlayerAlias leaves other players untouched', () => {
  const before: Player[] = [
    { id: 'p1', name: 'ตั้ม', aliases: [] },
    { id: 'p2', name: 'เบส', aliases: [] },
  ];
  const after = confirmExistingPlayerAlias(before, 'p1', 'ตัม');
  assert.deepEqual(after[1], { id: 'p2', name: 'เบส', aliases: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test fuzzy-match.test.ts`
Expected: FAIL — `confirmExistingPlayerAlias` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Append to `fuzzy-match.ts`:

```ts
export function confirmExistingPlayerAlias(
  players: Player[],
  playerId: string,
  rawInputName: string
): Player[] {
  return players.map((player) => {
    if (player.id !== playerId) return player;
    if (player.aliases.includes(rawInputName)) return player;
    return { ...player, aliases: [...player.aliases, rawInputName] };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test fuzzy-match.test.ts`
Expected: PASS (21 tests)

- [ ] **Step 5: Commit**

```bash
git add fuzzy-match.ts fuzzy-match.test.ts
git commit -m "feat: add confirmExistingPlayerAlias for fuzzy-match layer"
```

---

### Task 7: `createNewPlayer`

**Files:**
- Modify: `fuzzy-match.ts`
- Modify: `fuzzy-match.test.ts`

**Interfaces:**
- Consumes: `interface Player` (Task 4)
- Produces: `createNewPlayer(players: Player[], newId: string, rawInputName: string): Player[]`

- [ ] **Step 1: Write the failing test**

Append to `fuzzy-match.test.ts` (add `createNewPlayer` to the existing import):

```ts
test('createNewPlayer appends a new player with the raw pasted text as name and no aliases', () => {
  const before: Player[] = [{ id: 'p1', name: 'ตั้ม', aliases: [] }];
  const after = createNewPlayer(before, 'p2', 'เกียร์');
  assert.deepEqual(after, [
    { id: 'p1', name: 'ตั้ม', aliases: [] },
    { id: 'p2', name: 'เกียร์', aliases: [] },
  ]);
});

test('createNewPlayer does not mutate the input array', () => {
  const before: Player[] = [{ id: 'p1', name: 'ตั้ม', aliases: [] }];
  createNewPlayer(before, 'p2', 'เกียร์');
  assert.equal(before.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test fuzzy-match.test.ts`
Expected: FAIL — `createNewPlayer` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Append to `fuzzy-match.ts`:

```ts
export function createNewPlayer(players: Player[], newId: string, rawInputName: string): Player[] {
  return [...players, { id: newId, name: rawInputName, aliases: [] }];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test fuzzy-match.test.ts`
Expected: PASS (23 tests)

- [ ] **Step 5: Commit**

```bash
git add fuzzy-match.ts fuzzy-match.test.ts
git commit -m "feat: add createNewPlayer for fuzzy-match layer"
```

---

## Post-implementation

Update `PROJECT.md`:
- §6.2 heading: `**decided, not built**` → `**built** (\`fuzzy-match.ts\`)`
- §7 checklist: check off `2. Fuzzy-match layer (parsed names → Player + aliases[])`
