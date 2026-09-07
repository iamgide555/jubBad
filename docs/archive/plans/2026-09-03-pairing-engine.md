# Pairing/Rotation Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Given a confirmed roster, court count, and cross-session partner/opponent history, produce one round's court assignments — minimizing repeat partners (primary), softly balancing repeat opponents (secondary, tie-break only), and rotating who sits out fairly within the current session.

**Architecture:** A single pure, dependency-free TS module (`pairing.ts`) at repo root, sibling to `parser.ts` and `fuzzy-match.ts`, following their no-framework/no-npm-dependency style. Sit-out selection is deterministic (ranked by games-played-this-session); court assignment uses randomized search (shuffle-and-score, keep best of 200 trials) since exhaustive enumeration is combinatorially infeasible at realistic group sizes. All randomness is injected via a `random: () => number` parameter (defaults to `Math.random`) so tests are deterministic.

**Tech Stack:** TypeScript, run via Node 22's native type-stripping (`node --experimental-strip-types`). Tests use Node's built-in `node:test` + `node:assert/strict` — zero npm dependencies, matching `fuzzy-match.ts`'s plan.

**Spec:** `PROJECT.md` §6.3 ("Pairing/rotation engine — decided, not built") — this plan implements that section verbatim; read it alongside this plan.

## Global Constraints

- No npm dependencies, for implementation or test running — use Node's built-in `node:test`/`node:assert/strict`, executed via `node --experimental-strip-types` (`PROJECT.md` §6.3).
- All relative imports in test files MUST use an explicit `.ts` extension (e.g. `from './pairing.ts'`) — Node's native ESM resolver does not do extension-guessing, confirmed while building `fuzzy-match.ts`.
- Score formula: `score = 10 × (repeat-partner pairs in this arrangement) + 1 × (repeat-opponent pairs in this arrangement)`. Each repeated pair contributes its flat weight once (binary — "has this pair met before, yes/no" — not multiplied by how many times before). Lower score wins (`PROJECT.md` §6.3).
- Partner/opponent history (`partnerCounts`, `opponentCounts`) is **all-time across sessions**. Games-played for sit-out (`gamesPlayedThisSession`) is **this session only** — deliberately a different scope (`PROJECT.md` §6.3).
- Sit-out is deterministic, not part of the weighted score: rank by games-played-this-session descending (most-played sits first), ties broken randomly. `usableCourts = min(courtCount, floor(roster.length / 4))`; `sitOutCount = roster.length - usableCourts * 4` (`PROJECT.md` §6.3).
- Court search is randomized (shuffle the playing roster, score, repeat 200 times, keep the best) — not exhaustive enumeration, not a real matching-theory optimizer (`PROJECT.md` §6.3).

---

## File Structure

- Create: `pairing.ts` — types (`PlayerId`, `MatchHistory`, `CourtAssignment`, `RoundResult`) + all pairing functions.
- Create: `pairing.test.ts` — `node:test` suite, grows one `test()` block per task. Includes a small seeded-random helper (`makeSeededRandom`) local to the test file, used only to make search/shuffle behavior deterministic for assertions — production code always defaults to `Math.random`.

Both live at repo root, matching the existing flat layout (`parser.ts`, `fuzzy-match.ts` — no `src/` directory in this repo).

---

### Task 1: `pairKey`

**Files:**
- Create: `pairing.ts`
- Create: `pairing.test.ts`

**Interfaces:**
- Produces: `pairKey(a: string, b: string): string`

- [ ] **Step 1: Write the failing test**

Create `pairing.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairKey } from './pairing.ts';

test('pairKey is order-independent', () => {
  assert.equal(pairKey('a', 'b'), pairKey('b', 'a'));
});

test('pairKey produces a stable, distinct key per pair', () => {
  assert.equal(pairKey('a', 'b'), 'a|b');
  assert.notEqual(pairKey('a', 'b'), pairKey('a', 'c'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test pairing.test.ts`
Expected: FAIL — `pairing.ts` doesn't exist yet (module not found).

- [ ] **Step 3: Write minimal implementation**

Create `pairing.ts`:

```ts
/**
 * Pairing/rotation engine: given a confirmed roster, court count, and
 * cross-session partner/opponent history, produces one round's court
 * assignments. See PROJECT.md §6.3.
 */

export type PlayerId = string;

export function pairKey(a: PlayerId, b: PlayerId): string {
  return [a, b].sort().join('|');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test pairing.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add pairing.ts pairing.test.ts
git commit -m "feat: add pairKey for pairing engine"
```

---

### Task 2: `shuffle`

**Files:**
- Modify: `pairing.ts`
- Modify: `pairing.test.ts`

**Interfaces:**
- Produces: `shuffle<T>(items: T[], random: () => number): T[]`

- [ ] **Step 1: Write the failing test**

Append to `pairing.test.ts` (add `shuffle` to the existing import, and add the seeded-random test helper below the imports):

```ts
import { pairKey, shuffle } from './pairing.ts';

function makeSeededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

test('shuffle is deterministic for a given random source', () => {
  const result = shuffle(['a', 'b', 'c', 'd', 'e'], makeSeededRandom(42));
  assert.deepEqual(result, ['a', 'b', 'd', 'e', 'c']);
});

test('shuffle does not mutate the input array', () => {
  const input = ['a', 'b', 'c'];
  shuffle(input, makeSeededRandom(1));
  assert.deepEqual(input, ['a', 'b', 'c']);
});

test('shuffle preserves all elements', () => {
  const result = shuffle(['a', 'b', 'c', 'd'], makeSeededRandom(5));
  assert.deepEqual([...result].sort(), ['a', 'b', 'c', 'd']);
});
```

(Define `makeSeededRandom` once, near the top of the file below the imports — later tasks reuse it rather than redefining it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test pairing.test.ts`
Expected: FAIL — `shuffle` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Append to `pairing.ts`:

```ts
export function shuffle<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test pairing.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add pairing.ts pairing.test.ts
git commit -m "feat: add shuffle for pairing engine"
```

---

### Task 3: `selectSittingOut`

**Files:**
- Modify: `pairing.ts`
- Modify: `pairing.test.ts`

**Interfaces:**
- Consumes: `shuffle<T>(items: T[], random: () => number): T[]` (Task 2)
- Produces: `selectSittingOut(roster: PlayerId[], courtCount: number, gamesPlayedThisSession: Map<PlayerId, number>, random: () => number): { playing: PlayerId[]; sittingOut: PlayerId[] }`

- [ ] **Step 1: Write the failing test**

Append to `pairing.test.ts` (add `selectSittingOut` to the existing import):

```ts
test('selectSittingOut: roster not a multiple of 4 leaves a remainder sitting out even when courtCount is not exceeded', () => {
  const roster = Array.from({ length: 10 }, (_, i) => `p${i + 1}`);
  const gamesPlayed = new Map([
    ['p1', 3],
    ['p2', 2],
    ['p3', 1],
  ]);
  const result = selectSittingOut(roster, 3, gamesPlayed, makeSeededRandom(7));
  assert.deepEqual(result.sittingOut, ['p1', 'p2']);
  assert.deepEqual(result.playing, ['p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10']);
});

test('selectSittingOut: exact fit means nobody sits out', () => {
  const roster = Array.from({ length: 8 }, (_, i) => `p${i + 1}`);
  const result = selectSittingOut(roster, 2, new Map(), makeSeededRandom(1));
  assert.deepEqual(result.sittingOut, []);
  assert.deepEqual(result.playing, roster);
});

test('selectSittingOut: fewer than 4 players means everyone sits out', () => {
  const result = selectSittingOut(['a', 'b', 'c'], 1, new Map(), makeSeededRandom(1));
  assert.deepEqual(result.playing, []);
  assert.deepEqual(result.sittingOut, ['c', 'a', 'b']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test pairing.test.ts`
Expected: FAIL — `selectSittingOut` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Append to `pairing.ts`:

```ts
export function selectSittingOut(
  roster: PlayerId[],
  courtCount: number,
  gamesPlayedThisSession: Map<PlayerId, number>,
  random: () => number
): { playing: PlayerId[]; sittingOut: PlayerId[] } {
  const usableCourts = Math.min(courtCount, Math.floor(roster.length / 4));
  const sitOutCount = roster.length - usableCourts * 4;

  if (sitOutCount <= 0) {
    return { playing: [...roster], sittingOut: [] };
  }

  const shuffled = shuffle(roster, random);
  const sorted = [...shuffled].sort(
    (a, b) => (gamesPlayedThisSession.get(b) ?? 0) - (gamesPlayedThisSession.get(a) ?? 0)
  );

  const sittingOut = sorted.slice(0, sitOutCount);
  const sittingOutSet = new Set(sittingOut);
  const playing = roster.filter((p) => !sittingOutSet.has(p));

  return { playing, sittingOut };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test pairing.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add pairing.ts pairing.test.ts
git commit -m "feat: add selectSittingOut for pairing engine"
```

---

### Task 4: `scoreArrangement`

**Files:**
- Modify: `pairing.ts`
- Modify: `pairing.test.ts`

**Interfaces:**
- Consumes: `pairKey(a: PlayerId, b: PlayerId): string` (Task 1)
- Produces:
  - `interface CourtAssignment { court: number; teamA: [PlayerId, PlayerId]; teamB: [PlayerId, PlayerId] }`
  - `scoreArrangement(courts: { teamA: [PlayerId, PlayerId]; teamB: [PlayerId, PlayerId] }[], partnerCounts: Map<string, number>, opponentCounts: Map<string, number>): number`

- [ ] **Step 1: Write the failing test**

Append to `pairing.test.ts` (add `scoreArrangement` to the existing import). This is the exact worked example from `PROJECT.md` §6.3:

```ts
test('scoreArrangement matches the PROJECT.md §6.3 worked example', () => {
  const partnerCounts = new Map([[pairKey('tam', 'base'), 2]]);
  const opponentCounts = new Map([[pairKey('pom', 'mai'), 3]]);

  const repeatsPartner = [{ teamA: ['tam', 'base'] as [string, string], teamB: ['pom', 'mai'] as [string, string] }];
  const tiedA = [{ teamA: ['tam', 'pom'] as [string, string], teamB: ['base', 'mai'] as [string, string] }];
  const tiedB = [{ teamA: ['tam', 'mai'] as [string, string], teamB: ['base', 'pom'] as [string, string] }];

  assert.equal(scoreArrangement(repeatsPartner, partnerCounts, opponentCounts), 10);
  assert.equal(scoreArrangement(tiedA, partnerCounts, opponentCounts), 1);
  assert.equal(scoreArrangement(tiedB, partnerCounts, opponentCounts), 1);
});

test('scoreArrangement is 0 when nothing in the arrangement has met before', () => {
  const arrangement = [{ teamA: ['a', 'b'] as [string, string], teamB: ['c', 'd'] as [string, string] }];
  assert.equal(scoreArrangement(arrangement, new Map(), new Map()), 0);
});

test('scoreArrangement sums across multiple courts', () => {
  const partnerCounts = new Map([[pairKey('a', 'b'), 1]]);
  const arrangement = [
    { teamA: ['a', 'b'] as [string, string], teamB: ['c', 'd'] as [string, string] },
    { teamA: ['e', 'f'] as [string, string], teamB: ['g', 'h'] as [string, string] },
  ];
  assert.equal(scoreArrangement(arrangement, partnerCounts, new Map()), 10);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test pairing.test.ts`
Expected: FAIL — `scoreArrangement` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Append to `pairing.ts`:

```ts
export interface CourtAssignment {
  court: number;
  teamA: [PlayerId, PlayerId];
  teamB: [PlayerId, PlayerId];
}

const PARTNER_WEIGHT = 10;
const OPPONENT_WEIGHT = 1;

export function scoreArrangement(
  courts: { teamA: [PlayerId, PlayerId]; teamB: [PlayerId, PlayerId] }[],
  partnerCounts: Map<string, number>,
  opponentCounts: Map<string, number>
): number {
  let score = 0;

  for (const { teamA, teamB } of courts) {
    const partnerPairs = [pairKey(teamA[0], teamA[1]), pairKey(teamB[0], teamB[1])];
    for (const key of partnerPairs) {
      if ((partnerCounts.get(key) ?? 0) > 0) score += PARTNER_WEIGHT;
    }

    const opponentPairs = [
      pairKey(teamA[0], teamB[0]),
      pairKey(teamA[0], teamB[1]),
      pairKey(teamA[1], teamB[0]),
      pairKey(teamA[1], teamB[1]),
    ];
    for (const key of opponentPairs) {
      if ((opponentCounts.get(key) ?? 0) > 0) score += OPPONENT_WEIGHT;
    }
  }

  return score;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test pairing.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add pairing.ts pairing.test.ts
git commit -m "feat: add scoreArrangement for pairing engine"
```

---

### Task 5: `buildRandomArrangement`

**Files:**
- Modify: `pairing.ts`
- Modify: `pairing.test.ts`

**Interfaces:**
- Consumes: `shuffle<T>(items: T[], random: () => number): T[]` (Task 2), `interface CourtAssignment` (Task 4)
- Produces: `buildRandomArrangement(playing: PlayerId[], usableCourts: number, random: () => number): CourtAssignment[]`

- [ ] **Step 1: Write the failing test**

Append to `pairing.test.ts` (add `buildRandomArrangement` to the existing import):

```ts
test('buildRandomArrangement groups players into the requested number of 4-player courts', () => {
  const playing = Array.from({ length: 8 }, (_, i) => `p${i + 1}`);
  const result = buildRandomArrangement(playing, 2, makeSeededRandom(3));
  assert.deepEqual(result, [
    { court: 1, teamA: ['p4', 'p3'], teamB: ['p1', 'p7'] },
    { court: 2, teamA: ['p6', 'p8'], teamB: ['p2', 'p5'] },
  ]);
});

test('buildRandomArrangement includes every playing player exactly once', () => {
  const playing = Array.from({ length: 8 }, (_, i) => `p${i + 1}`);
  const result = buildRandomArrangement(playing, 2, makeSeededRandom(11));
  const allAssigned = result.flatMap((c) => [...c.teamA, ...c.teamB]);
  assert.deepEqual([...allAssigned].sort(), [...playing].sort());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test pairing.test.ts`
Expected: FAIL — `buildRandomArrangement` is not exported yet.

- [ ] **Step 3: Write minimal implementation**

Append to `pairing.ts`:

```ts
export function buildRandomArrangement(
  playing: PlayerId[],
  usableCourts: number,
  random: () => number
): CourtAssignment[] {
  const shuffled = shuffle(playing, random);
  const courts: CourtAssignment[] = [];
  for (let i = 0; i < usableCourts; i++) {
    const group = shuffled.slice(i * 4, i * 4 + 4);
    courts.push({
      court: i + 1,
      teamA: [group[0], group[1]],
      teamB: [group[2], group[3]],
    });
  }
  return courts;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test pairing.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add pairing.ts pairing.test.ts
git commit -m "feat: add buildRandomArrangement for pairing engine"
```

---

### Task 6: `generateRound`

**Files:**
- Modify: `pairing.ts`
- Modify: `pairing.test.ts`

**Interfaces:**
- Consumes: `selectSittingOut(...)` (Task 3), `scoreArrangement(...)` (Task 4), `buildRandomArrangement(...)` (Task 5)
- Produces:
  - `interface MatchHistory { partnerCounts: Map<string, number>; opponentCounts: Map<string, number>; gamesPlayedThisSession: Map<PlayerId, number> }`
  - `interface RoundResult { courts: CourtAssignment[]; sittingOut: PlayerId[] }`
  - `generateRound(roster: PlayerId[], courtCount: number, history: MatchHistory, random?: () => number): RoundResult`

- [ ] **Step 1: Write the failing test**

Append to `pairing.test.ts` (add `generateRound` and `type MatchHistory` to the existing import):

```ts
test('generateRound picks the lowest-scoring arrangement out of its search trials', () => {
  const history: MatchHistory = {
    partnerCounts: new Map([[pairKey('tam', 'base'), 2]]),
    opponentCounts: new Map([[pairKey('pom', 'mai'), 3]]),
    gamesPlayedThisSession: new Map(),
  };
  const result = generateRound(['tam', 'base', 'pom', 'mai'], 1, history, makeSeededRandom(1));
  assert.deepEqual(result, {
    courts: [{ court: 1, teamA: ['base', 'mai'], teamB: ['tam', 'pom'] }],
    sittingOut: [],
  });
  // never the score-10 arrangement (tam+base vs pom+mai repeating the known partner pair)
  assert.equal(scoreArrangement(result.courts, history.partnerCounts, history.opponentCounts), 1);
});

test('generateRound integrates sit-out selection: 10 players, 3 courts', () => {
  const history: MatchHistory = {
    partnerCounts: new Map(),
    opponentCounts: new Map(),
    gamesPlayedThisSession: new Map([
      ['p1', 3],
      ['p2', 2],
    ]),
  };
  const roster = Array.from({ length: 10 }, (_, i) => `p${i + 1}`);
  const result = generateRound(roster, 3, history, makeSeededRandom(99));

  assert.deepEqual(result.sittingOut, ['p1', 'p2']);
  assert.equal(result.courts.length, 2);
  const allAssigned = result.courts.flatMap((c) => [...c.teamA, ...c.teamB]);
  assert.deepEqual(
    [...allAssigned].sort(),
    roster.filter((p) => p !== 'p1' && p !== 'p2').sort()
  );
});

test('generateRound returns no courts when fewer than 4 players are available to play', () => {
  const history: MatchHistory = {
    partnerCounts: new Map(),
    opponentCounts: new Map(),
    gamesPlayedThisSession: new Map(),
  };
  const result = generateRound(['a', 'b', 'c'], 1, history, makeSeededRandom(1));
  assert.deepEqual(result.courts, []);
  assert.equal(result.sittingOut.length, 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test pairing.test.ts`
Expected: FAIL — `generateRound`/`MatchHistory` are not exported yet.

- [ ] **Step 3: Write minimal implementation**

Append to `pairing.ts`:

```ts
export interface MatchHistory {
  /** All-time across sessions — variety over the group's whole life. */
  partnerCounts: Map<string, number>;
  /** All-time across sessions. */
  opponentCounts: Map<string, number>;
  /** This session only — resets each session for fair rotation today. */
  gamesPlayedThisSession: Map<PlayerId, number>;
}

export interface RoundResult {
  courts: CourtAssignment[];
  sittingOut: PlayerId[];
}

const SEARCH_TRIALS = 200;

export function generateRound(
  roster: PlayerId[],
  courtCount: number,
  history: MatchHistory,
  random: () => number = Math.random
): RoundResult {
  const { playing, sittingOut } = selectSittingOut(
    roster,
    courtCount,
    history.gamesPlayedThisSession,
    random
  );

  const usableCourts = Math.min(courtCount, Math.floor(playing.length / 4));

  if (usableCourts === 0) {
    return { courts: [], sittingOut };
  }

  let best: CourtAssignment[] | null = null;
  let bestScore = Infinity;

  for (let trial = 0; trial < SEARCH_TRIALS; trial++) {
    const candidate = buildRandomArrangement(playing, usableCourts, random);
    const score = scoreArrangement(candidate, history.partnerCounts, history.opponentCounts);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return { courts: best as CourtAssignment[], sittingOut };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test pairing.test.ts`
Expected: PASS (16 tests)

- [ ] **Step 5: Commit**

```bash
git add pairing.ts pairing.test.ts
git commit -m "feat: add generateRound for pairing engine"
```

---

## Post-implementation

Update `PROJECT.md`:
- §6.3 heading: `**decided, not built**` → `**built** (\`pairing.ts\`)`
- §7 checklist: check off `3. Pairing/rotation engine (repeat-partner avoidance + sit-out balancing)`
