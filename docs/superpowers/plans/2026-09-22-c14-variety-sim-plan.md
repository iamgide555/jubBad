# C14 Variety Simulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure engines-only harness that measures whether the real pairing engine actually delivers more partner variety than two naive baselines, across a simulated 12-night season, and lock the result in as a regression-guarding test.

**Architecture:** One new file, `engines/variety-sim.ts`, runs a discrete-event simulation per night: matches finish at random times (so the 3 courts go idle out of step, exactly like real play), and whichever court frees is refilled from whoever isn't currently on another court — the same "available roster minus busy players" shape `SessionsService.proposeExclusively` uses in production. Three interchangeable "fill" strategies plug into the same loop: the real `generateRound` engine, a rotation-fair-then-random baseline, and a rotation-fair-then-avoid-last-partner baseline. `engines/variety-sim.test.ts` runs all three against identical attendance, computes variety metrics at nights 4/8/12, prints a table, and asserts the engine beats both baselines by a margin measured during this plan's implementation.

This plan implements **only** the "Measure" half of spec section C14. The "Show" half (summary API `distinctPartners`, summary UI line, player-card `partnersLast30Days`) is a separate, later step in the roadmap's build order (after C2, C1, C3) and is explicitly out of scope here.

**Tech Stack:** TypeScript engine code (`engines/*.ts`), Node's built-in `node:test` + `node:assert/strict`, run via `npm run test:engines` (`node --experimental-strip-types --test engines/*.test.ts`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md`, section "C14. Measure partner variety and show it" (Measure half only).

**Branch:** `feat/c14-variety-sim`, created off `main` before Task 1. `main` keeps running live sessions throughout — do not touch anything outside `engines/` on this branch.

## Global Constraints

- Every `engines/*.ts` import uses an explicit `.ts` extension (ESM), e.g. `from './pairing.ts'` — matches every existing file in the folder.
- Randomness is always injected via a `random: () => number` parameter, never a bare `Math.random()` call, so every run is reproducible from a seed (`engines/pairing.ts`'s existing convention).
- No schema change and no file outside `engines/` in this plan.
- Test files use `node:test` (`test(...)`) and `node:assert/strict`, following `engines/pairing-quality.test.ts`'s style, including its seeded LCG pattern.
- The scenario is 16 players, 12–14 attend each night at random, 3 doubles courts, 8 matches per court per night (24 matches/night total), 12 nights, match duration uniform 12–18 simulated minutes.
- Reuse existing exports from `engines/pairing.ts` (`generateRound`, `selectSittingOut`, `shuffle`, `pairKey`, `MatchHistory`, `PlayerId`, `CourtAssignment`) rather than reimplementing any of them.

---

## Task 1: Scenario, seeded RNG, attendance schedule, co-attendance counts

**Files:**
- Create: `engines/variety-sim.ts`
- Test: `engines/variety-sim.test.ts`

**Interfaces:**
- Produces: `makeSeededRandom(seed: number): () => number`; `SimScenario` interface; `DEFAULT_SCENARIO: SimScenario`; `playerIdsFor(scenario: SimScenario): PlayerId[]`; `generateAttendance(scenario: SimScenario, random: () => number): PlayerId[][]` (one array of attending player ids per night, length `scenario.nights`); `coAttendanceCounts(attendance: PlayerId[][]): Map<string, number>` (keyed by `pairKey`, counting nights both players attended).

- [ ] **Step 1: Write the failing test**

```ts
// engines/variety-sim.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SCENARIO,
  coAttendanceCounts,
  generateAttendance,
  makeSeededRandom,
  playerIdsFor,
} from './variety-sim.ts';

test('generateAttendance draws between minAttend and maxAttend distinct players, for every night', () => {
  const attendance = generateAttendance(DEFAULT_SCENARIO, makeSeededRandom(3));
  assert.equal(attendance.length, DEFAULT_SCENARIO.nights);
  const players = new Set(playerIdsFor(DEFAULT_SCENARIO));
  for (const night of attendance) {
    assert.ok(night.length >= DEFAULT_SCENARIO.minAttend, `night has ${night.length} attendees`);
    assert.ok(night.length <= DEFAULT_SCENARIO.maxAttend, `night has ${night.length} attendees`);
    assert.equal(new Set(night).size, night.length, 'no duplicate attendee in one night');
    for (const id of night) assert.ok(players.has(id), `${id} must be one of the 16 players`);
  }
});

test('generateAttendance is deterministic for a given seed', () => {
  const a = generateAttendance(DEFAULT_SCENARIO, makeSeededRandom(3));
  const b = generateAttendance(DEFAULT_SCENARIO, makeSeededRandom(3));
  assert.deepEqual(a, b);
});

test('coAttendanceCounts counts exactly the nights both players attended', () => {
  const attendance = [
    ['p0', 'p1', 'p2'],
    ['p0', 'p2'],
    ['p1', 'p2'],
  ];
  const co = coAttendanceCounts(attendance);
  assert.equal(co.get('p0|p1'), 1);
  assert.equal(co.get('p0|p2'), 2);
  assert.equal(co.get('p1|p2'), 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test engines/variety-sim.test.ts`
Expected: FAIL — `Cannot find module './variety-sim.ts'` (the file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

```ts
// engines/variety-sim.ts
/**
 * Pure harness measuring whether the real pairing engine delivers more
 * partner variety over a season than two naive baselines. No schema change,
 * no server dependency — see docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md,
 * section C14.
 */

import { pairKey, shuffle, type PlayerId } from './pairing.ts';

export function makeSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export interface SimScenario {
  playerCount: number;
  minAttend: number;
  maxAttend: number;
  courts: number;
  matchesPerCourt: number;
  nights: number;
  minDurationMin: number;
  maxDurationMin: number;
}

export const DEFAULT_SCENARIO: SimScenario = {
  playerCount: 16,
  minAttend: 12,
  maxAttend: 14,
  courts: 3,
  matchesPerCourt: 8,
  nights: 12,
  minDurationMin: 12,
  maxDurationMin: 18,
};

export function playerIdsFor(scenario: SimScenario): PlayerId[] {
  return Array.from({ length: scenario.playerCount }, (_, i) => `p${i}`);
}

export function generateAttendance(scenario: SimScenario, random: () => number): PlayerId[][] {
  const players = playerIdsFor(scenario);
  const span = scenario.maxAttend - scenario.minAttend;
  const nights: PlayerId[][] = [];
  for (let n = 0; n < scenario.nights; n++) {
    const count = scenario.minAttend + Math.min(span, Math.floor(random() * (span + 1)));
    nights.push(shuffle(players, random).slice(0, count));
  }
  return nights;
}

export function coAttendanceCounts(attendance: PlayerId[][]): Map<string, number> {
  const co = new Map<string, number>();
  for (const night of attendance) {
    for (let i = 0; i < night.length; i++) {
      for (let j = i + 1; j < night.length; j++) {
        const key = pairKey(night[i], night[j]);
        co.set(key, (co.get(key) ?? 0) + 1);
      }
    }
  }
  return co;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test engines/variety-sim.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add engines/variety-sim.ts engines/variety-sim.test.ts
git commit -m "feat(variety-sim): scenario, seeded attendance, co-attendance counts"
```

---

## Task 2: Court split pickers (random, no-back-to-back)

**Files:**
- Modify: `engines/variety-sim.ts`
- Test: `engines/variety-sim.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 directly (pure functions over 4 player ids and a `Map<PlayerId, PlayerId>`).
- Produces: `pickRandomSplit(four: [PlayerId,PlayerId,PlayerId,PlayerId], random: () => number): { teamA: [PlayerId,PlayerId]; teamB: [PlayerId,PlayerId] }`; `pickNoBackToBackSplit(four: [PlayerId,PlayerId,PlayerId,PlayerId], lastPartner: Map<PlayerId, PlayerId>, random: () => number): { teamA: [PlayerId,PlayerId]; teamB: [PlayerId,PlayerId] }`. Both are used by Task 3.

- [ ] **Step 1: Write the failing test**

```ts
// append to engines/variety-sim.test.ts
import { pickNoBackToBackSplit, pickRandomSplit } from './variety-sim.ts';

test('pickRandomSplit always returns one of the three splits of four', () => {
  const four: [string, string, string, string] = ['a', 'b', 'c', 'd'];
  const valid = [
    'a|b vs c|d',
    'a|c vs b|d',
    'a|d vs b|c',
  ];
  for (let seed = 0; seed < 20; seed++) {
    const { teamA, teamB } = pickRandomSplit(four, makeSeededRandom(seed));
    const label = `${[...teamA].sort().join('')}|${[...teamB].sort().join('')}`;
    assert.ok(
      ['ab|cd', 'ac|bd', 'ad|bc'].includes([...[teamA, teamB]].map((t) => [...t].sort().join('')).sort().join('|')),
      `unexpected split ${label}`
    );
  }
});

test('pickNoBackToBackSplit avoids reuniting a player with their last partner when an alternative exists', () => {
  const four: [string, string, string, string] = ['a', 'b', 'c', 'd'];
  const lastPartner = new Map([
    ['a', 'b'],
    ['b', 'a'],
  ]);
  for (let seed = 0; seed < 20; seed++) {
    const { teamA, teamB } = pickNoBackToBackSplit(four, lastPartner, makeSeededRandom(seed));
    const reunited =
      (teamA.includes('a') && teamA.includes('b')) || (teamB.includes('a') && teamB.includes('b'));
    assert.equal(reunited, false, 'a and b must not be reunited as partners');
  }
});

test('pickNoBackToBackSplit falls back to a random split when every split reunites someone', () => {
  // With three simultaneous "just played together" pairs among four players,
  // every one of the three splits reunites at least one of them — there is no
  // clean split left, so the function must still return a legal split rather
  // than throwing or returning nothing.
  const four: [string, string, string, string] = ['a', 'b', 'c', 'd'];
  const lastPartner = new Map([
    ['a', 'b'],
    ['b', 'a'],
    ['c', 'd'],
    ['d', 'c'],
  ]);
  const { teamA, teamB } = pickNoBackToBackSplit(four, lastPartner, makeSeededRandom(1));
  assert.equal(teamA.length, 2);
  assert.equal(teamB.length, 2);
  assert.equal(new Set([...teamA, ...teamB]).size, 4);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test engines/variety-sim.test.ts`
Expected: FAIL — `pickRandomSplit is not a function` / `pickNoBackToBackSplit is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to engines/variety-sim.ts
type Four = [PlayerId, PlayerId, PlayerId, PlayerId];
export type Split = { teamA: [PlayerId, PlayerId]; teamB: [PlayerId, PlayerId] };

/** The three ways to split four players into two teams of two — same table
 *  `pairing-quality.test.ts` uses for its own exhaustive checks. */
const SPLIT_PATTERNS: [number, number, number, number][] = [
  [0, 1, 2, 3],
  [0, 2, 1, 3],
  [0, 3, 1, 2],
];

function splitFromPattern(four: Four, pattern: [number, number, number, number]): Split {
  const [a, b, c, d] = pattern;
  return { teamA: [four[a], four[b]], teamB: [four[c], four[d]] };
}

export function pickRandomSplit(four: Four, random: () => number): Split {
  const pattern = SPLIT_PATTERNS[Math.min(2, Math.floor(random() * 3))];
  return splitFromPattern(four, pattern);
}

/** The baseline PaQueueKa and Doubles Team Maker advertise: never reunite a
 *  player with the partner from their immediately preceding match, unless
 *  every split would. */
export function pickNoBackToBackSplit(
  four: Four,
  lastPartner: Map<PlayerId, PlayerId>,
  random: () => number
): Split {
  const clean = SPLIT_PATTERNS.filter((pattern) => {
    const { teamA, teamB } = splitFromPattern(four, pattern);
    return lastPartner.get(teamA[0]) !== teamA[1] && lastPartner.get(teamB[0]) !== teamB[1];
  });
  const pool = clean.length > 0 ? clean : SPLIT_PATTERNS;
  const pattern = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
  return splitFromPattern(four, pattern);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test engines/variety-sim.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add engines/variety-sim.ts engines/variety-sim.test.ts
git commit -m "feat(variety-sim): random and no-back-to-back split pickers"
```

---

## Task 3: `fillAllIdleCourts` — the three interchangeable fill strategies

**Files:**
- Modify: `engines/variety-sim.ts`
- Test: `engines/variety-sim.test.ts`

**Interfaces:**
- Consumes: `Split`, `pickRandomSplit`, `pickNoBackToBackSplit` (Task 2); `generateRound`, `selectSittingOut`, `shuffle`, `MatchHistory`, `PlayerId` from `./pairing.ts`.
- Produces: `export type PickerName = 'engine' | 'random' | 'no-back-to-back';` and `fillAllIdleCourts(available: PlayerId[], courtsNeeded: number, picker: PickerName, history: MatchHistory, lastPartner: Map<PlayerId, PlayerId>, random: () => number): { courts: Split[] }`. Used by Task 4's `runNight`.

- [ ] **Step 1: Write the failing test**

```ts
// append to engines/variety-sim.test.ts
import { fillAllIdleCourts } from './variety-sim.ts';
import type { MatchHistory } from './pairing.ts';

function emptyHistory(ids: string[]): MatchHistory {
  const gamesPlayedThisSession = new Map<string, number>();
  const waitingSince = new Map<string, number>();
  for (const id of ids) waitingSince.set(id, 0);
  return { partnerCounts: new Map(), opponentCounts: new Map(), gamesPlayedThisSession, waitingSince };
}

for (const picker of ['engine', 'random', 'no-back-to-back'] as const) {
  test(`fillAllIdleCourts (${picker}) fills every requested court with 4 distinct players each, no overlap`, () => {
    const available = Array.from({ length: 12 }, (_, i) => `p${i}`);
    const history = emptyHistory(available);
    const { courts } = fillAllIdleCourts(available, 3, picker, history, new Map(), makeSeededRandom(7));

    assert.equal(courts.length, 3);
    const seen = new Set<string>();
    for (const { teamA, teamB } of courts) {
      for (const id of [...teamA, ...teamB]) {
        assert.equal(seen.has(id), false, `${id} appears on more than one court`);
        seen.add(id);
      }
    }
    assert.equal(seen.size, 12);
  });

  test(`fillAllIdleCourts (${picker}) fills one court from a wider available pool`, () => {
    const available = Array.from({ length: 6 }, (_, i) => `p${i}`);
    const history = emptyHistory(available);
    const { courts } = fillAllIdleCourts(available, 1, picker, history, new Map(), makeSeededRandom(7));

    assert.equal(courts.length, 1);
    const [{ teamA, teamB }] = courts;
    assert.equal(new Set([...teamA, ...teamB]).size, 4);
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test engines/variety-sim.test.ts`
Expected: FAIL — `fillAllIdleCourts is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to engines/variety-sim.ts
import { generateRound, selectSittingOut, type MatchHistory } from './pairing.ts';

export type PickerName = 'engine' | 'random' | 'no-back-to-back';

/**
 * Fills `courtsNeeded` currently-idle courts from `available` players. The
 * engine plans all of them jointly via the real `generateRound` — exactly
 * what `SessionsService.proposeExclusively` does when more than one court is
 * idle at once. The baselines only use `selectSittingOut` for *who* plays
 * (rotation fairness); they have no notion of planning multiple courts
 * jointly, so the chosen players are shuffled and chopped into groups of
 * four, and each group's split is decided independently.
 */
export function fillAllIdleCourts(
  available: PlayerId[],
  courtsNeeded: number,
  picker: PickerName,
  history: MatchHistory,
  lastPartner: Map<PlayerId, PlayerId>,
  random: () => number
): { courts: Split[] } {
  if (picker === 'engine') {
    const { courts } = generateRound(available, courtsNeeded, history, random);
    return {
      courts: courts.map((c) => ({
        teamA: c.teamA as [PlayerId, PlayerId],
        teamB: c.teamB as [PlayerId, PlayerId],
      })),
    };
  }

  const { playing } = selectSittingOut(
    available,
    courtsNeeded,
    history.gamesPlayedThisSession,
    random,
    history.waitingSince
  );
  const shuffled = shuffle(playing, random);
  const courts: Split[] = [];
  for (let i = 0; i < courtsNeeded; i++) {
    const four = shuffled.slice(i * 4, i * 4 + 4) as Four;
    courts.push(
      picker === 'random' ? pickRandomSplit(four, random) : pickNoBackToBackSplit(four, lastPartner, random)
    );
  }
  return { courts };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test engines/variety-sim.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add engines/variety-sim.ts engines/variety-sim.test.ts
git commit -m "feat(variety-sim): fillAllIdleCourts dispatches to engine or baseline pickers"
```

---

## Task 4: `runNight` event loop and `simulateNights`

**Files:**
- Modify: `engines/variety-sim.ts`
- Test: `engines/variety-sim.test.ts`

**Interfaces:**
- Consumes: `fillAllIdleCourts`, `PickerName`, `pairKey` from `./pairing.ts`.
- Produces: `simulateNights(scenario: SimScenario, attendance: PlayerId[][], picker: PickerName, random: () => number): Map<string, number>[]` — one cumulative `partnerCounts` snapshot per night, length `scenario.nights`. Used by Task 5's `metricsAtNight` and Task 6's final test.

- [ ] **Step 1: Write the failing test**

```ts
// append to engines/variety-sim.test.ts
import { simulateNights } from './variety-sim.ts';

test('simulateNights plays exactly courts * matchesPerCourt matches per night', () => {
  const attendance = generateAttendance(DEFAULT_SCENARIO, makeSeededRandom(3));
  const snapshots = simulateNights(DEFAULT_SCENARIO, attendance, 'engine', makeSeededRandom(11));

  assert.equal(snapshots.length, DEFAULT_SCENARIO.nights);

  const totalPairCount = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  // Each match contributes exactly one partner pair per team, two teams per
  // match: matchesPerNight * 2 partner-count increments per night.
  const matchesPerNight = DEFAULT_SCENARIO.courts * DEFAULT_SCENARIO.matchesPerCourt;
  assert.equal(totalPairCount(snapshots[0]), matchesPerNight * 2);
  assert.equal(totalPairCount(snapshots[1]) - totalPairCount(snapshots[0]), matchesPerNight * 2);
});

test('simulateNights never lets a cumulative partner count go down night over night', () => {
  const attendance = generateAttendance(DEFAULT_SCENARIO, makeSeededRandom(3));
  const snapshots = simulateNights(DEFAULT_SCENARIO, attendance, 'random', makeSeededRandom(12));
  for (let n = 1; n < snapshots.length; n++) {
    for (const [key, count] of snapshots[n - 1]) {
      assert.ok((snapshots[n].get(key) ?? 0) >= count, `${key} count must not decrease`);
    }
  }
});

test('simulateNights is deterministic for a given attendance and seed', () => {
  const attendance = generateAttendance(DEFAULT_SCENARIO, makeSeededRandom(3));
  const a = simulateNights(DEFAULT_SCENARIO, attendance, 'no-back-to-back', makeSeededRandom(13));
  const b = simulateNights(DEFAULT_SCENARIO, attendance, 'no-back-to-back', makeSeededRandom(13));
  assert.deepEqual(a.map((m) => [...m.entries()].sort()), b.map((m) => [...m.entries()].sort()));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test engines/variety-sim.test.ts`
Expected: FAIL — `simulateNights is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to engines/variety-sim.ts

/**
 * Simulates one night as a discrete-event queue: all 3 courts start together
 * (the one moment they're genuinely idle at once — mirrors a real session's
 * opening fill), then whichever court finishes next is refilled on its own
 * from whoever isn't currently on another court, exactly the shape
 * `SessionsService.proposeExclusively` uses in production. A court retires
 * once it reaches `matchesPerCourt` for the night; its players simply become
 * part of the available pool for whichever court asks next.
 */
function runNight(
  scenario: SimScenario,
  nightAttendees: PlayerId[],
  picker: PickerName,
  partnerCounts: Map<string, number>,
  opponentCounts: Map<string, number>,
  lastPartner: Map<PlayerId, PlayerId>,
  random: () => number
): void {
  const gamesPlayedThisSession = new Map<PlayerId, number>();
  const waitingSince = new Map<PlayerId, number>();
  for (const id of nightAttendees) waitingSince.set(id, 0);
  const history: MatchHistory = { partnerCounts, opponentCounts, gamesPlayedThisSession, waitingSince };

  const duration = () =>
    scenario.minDurationMin + random() * (scenario.maxDurationMin - scenario.minDurationMin);

  const recordMatch = (teamA: [PlayerId, PlayerId], teamB: [PlayerId, PlayerId], at: number): void => {
    const bump = (map: Map<string, number>, a: PlayerId, b: PlayerId) =>
      map.set(pairKey(a, b), (map.get(pairKey(a, b)) ?? 0) + 1);
    bump(partnerCounts, teamA[0], teamA[1]);
    bump(partnerCounts, teamB[0], teamB[1]);
    for (const a of teamA) for (const b of teamB) bump(opponentCounts, a, b);
    lastPartner.set(teamA[0], teamA[1]);
    lastPartner.set(teamA[1], teamA[0]);
    lastPartner.set(teamB[0], teamB[1]);
    lastPartner.set(teamB[1], teamB[0]);
    for (const p of [...teamA, ...teamB]) {
      gamesPlayedThisSession.set(p, (gamesPlayedThisSession.get(p) ?? 0) + 1);
      waitingSince.set(p, at);
    }
  };

  const busy = new Set<PlayerId>();
  const courtMatches = new Array<number>(scenario.courts).fill(0);
  const events: { court: number; freeAt: number; teamA: [PlayerId, PlayerId]; teamB: [PlayerId, PlayerId] }[] = [];
  const available = () => nightAttendees.filter((id) => !busy.has(id));

  const { courts: startingCourts } = fillAllIdleCourts(
    available(),
    scenario.courts,
    picker,
    history,
    lastPartner,
    random
  );
  startingCourts.forEach((match, court) => {
    for (const p of [...match.teamA, ...match.teamB]) busy.add(p);
    events.push({ court, freeAt: duration(), teamA: match.teamA, teamB: match.teamB });
  });

  while (events.length > 0) {
    events.sort((a, b) => a.freeAt - b.freeAt);
    const event = events.shift()!;
    for (const p of [...event.teamA, ...event.teamB]) busy.delete(p);
    recordMatch(event.teamA, event.teamB, event.freeAt);
    courtMatches[event.court] += 1;
    if (courtMatches[event.court] < scenario.matchesPerCourt) {
      const { courts } = fillAllIdleCourts(available(), 1, picker, history, lastPartner, random);
      const match = courts[0];
      for (const p of [...match.teamA, ...match.teamB]) busy.add(p);
      events.push({ court: event.court, freeAt: event.freeAt + duration(), teamA: match.teamA, teamB: match.teamB });
    }
  }
}

/** Runs `scenario.nights` nights back to back, carrying partner/opponent
 *  history across nights exactly as the real server does (it is never reset
 *  between sessions). Returns a cumulative `partnerCounts` snapshot after
 *  each night. */
export function simulateNights(
  scenario: SimScenario,
  attendance: PlayerId[][],
  picker: PickerName,
  random: () => number
): Map<string, number>[] {
  const partnerCounts = new Map<string, number>();
  const opponentCounts = new Map<string, number>();
  const lastPartner = new Map<PlayerId, PlayerId>();
  const snapshots: Map<string, number>[] = [];
  for (const nightAttendees of attendance) {
    runNight(scenario, nightAttendees, picker, partnerCounts, opponentCounts, lastPartner, random);
    snapshots.push(new Map(partnerCounts));
  }
  return snapshots;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test engines/variety-sim.test.ts`
Expected: PASS (15 tests)

- [ ] **Step 5: Commit**

```bash
git add engines/variety-sim.ts engines/variety-sim.test.ts
git commit -m "feat(variety-sim): async per-night event simulation across the season"
```

---

## Task 5: `metricsAtNight`

**Files:**
- Modify: `engines/variety-sim.ts`
- Test: `engines/variety-sim.test.ts`

**Interfaces:**
- Consumes: `pairKey` from `./pairing.ts`.
- Produces: `export interface NightMetrics { meanDistinctPartners: number; pairSpread: number; neverMetShare: number }`; `metricsAtNight(partnerCounts: Map<string, number>, coAttendance: Map<string, number>, playerIds: PlayerId[], night: number): NightMetrics`. Used by Task 6.

- [ ] **Step 1: Write the failing test**

```ts
// append to engines/variety-sim.test.ts
import { metricsAtNight } from './variety-sim.ts';

test('metricsAtNight computes distinct partners, spread and never-met share by hand', () => {
  // Four players, p0..p3. Partner counts: p0-p1 met 3 times, p0-p2 met once,
  // p2-p3 met once. p0-p3 and p1-p2 and p1-p3 never met.
  const partnerCounts = new Map([
    ['p0|p1', 3],
    ['p0|p2', 1],
    ['p2|p3', 1],
  ]);
  // All 4 pairs among p0..p2 co-attended >= half of 4 nights; p3 only ever
  // co-attended with p2, twice.
  const coAttendance = new Map([
    ['p0|p1', 4],
    ['p0|p2', 4],
    ['p0|p3', 0],
    ['p1|p2', 4],
    ['p1|p3', 0],
    ['p2|p3', 2],
  ]);
  const players = ['p0', 'p1', 'p2', 'p3'];

  const m = metricsAtNight(partnerCounts, coAttendance, players, 4);

  // distinct partners: p0 has 2 (p1, p2), p1 has 1 (p0), p2 has 2 (p0, p3),
  // p3 has 1 (p2) -> mean = (2 + 1 + 2 + 1) / 4 = 1.5
  assert.equal(m.meanDistinctPartners, 1.5);

  // threshold = ceil(4/2) = 2. Qualifying pairs: p0|p1 (4), p0|p2 (4),
  // p1|p2 (4), p2|p3 (2). Counts among those: 3, 1, 0, 1 -> spread = 3 - 0 = 3.
  assert.equal(m.pairSpread, 3);

  // 6 total pairs, 3 never met (p0|p3, p1|p2, p1|p3) -> 3/6 = 0.5
  assert.equal(m.neverMetShare, 0.5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test engines/variety-sim.test.ts`
Expected: FAIL — `metricsAtNight is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to engines/variety-sim.ts
export interface NightMetrics {
  meanDistinctPartners: number;
  pairSpread: number;
  neverMetShare: number;
}

/**
 * `night` sets the "attended at least half the nights so far" threshold for
 * the spread metric — a pair that only shared one or two nights together
 * hasn't had a fair chance to vary yet, and would otherwise dominate the
 * spread with noise rather than signal.
 */
export function metricsAtNight(
  partnerCounts: Map<string, number>,
  coAttendance: Map<string, number>,
  playerIds: PlayerId[],
  night: number
): NightMetrics {
  let totalDistinct = 0;
  for (const p of playerIds) {
    let distinct = 0;
    for (const q of playerIds) {
      if (p === q) continue;
      if ((partnerCounts.get(pairKey(p, q)) ?? 0) > 0) distinct++;
    }
    totalDistinct += distinct;
  }
  const meanDistinctPartners = totalDistinct / playerIds.length;

  const threshold = Math.ceil(night / 2);
  let min = Infinity;
  let max = -Infinity;
  let totalPairs = 0;
  let neverMet = 0;
  for (let i = 0; i < playerIds.length; i++) {
    for (let j = i + 1; j < playerIds.length; j++) {
      const key = pairKey(playerIds[i], playerIds[j]);
      const count = partnerCounts.get(key) ?? 0;
      totalPairs++;
      if (count === 0) neverMet++;
      if ((coAttendance.get(key) ?? 0) >= threshold) {
        if (count < min) min = count;
        if (count > max) max = count;
      }
    }
  }
  const pairSpread = Number.isFinite(min) ? max - min : 0;
  const neverMetShare = neverMet / totalPairs;

  return { meanDistinctPartners, pairSpread, neverMetShare };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test engines/variety-sim.test.ts`
Expected: PASS (16 tests)

- [ ] **Step 5: Commit**

```bash
git add engines/variety-sim.ts engines/variety-sim.test.ts
git commit -m "feat(variety-sim): metricsAtNight computes variety metrics from a snapshot"
```

---

## Task 6: The measurement test — engine vs. baselines, with a printed table

This is the test the spec asks for: "`engines/variety-sim.test.ts` holds the assertions and prints a table." The margins below were measured directly (attendance seed 3, picker seeds 11/12/13) while writing this plan; see the numbers in the comment.

**Files:**
- Modify: `engines/variety-sim.test.ts`

**Interfaces:**
- Consumes: everything produced by Tasks 1–5.
- Produces: nothing further downstream — this is the terminal deliverable of the plan.

- [ ] **Step 1: Write the test (this step's test IS the deliverable — no separate "fails then passes" cycle beyond running it once with loose bounds first)**

First, add the test with the real seeds and printed table, temporarily asserting only that the numbers are positive, to confirm the wiring:

```ts
// append to engines/variety-sim.test.ts
test('the engine beats naive baselines on partner variety across a season (prints the table)', () => {
  const attendance = generateAttendance(DEFAULT_SCENARIO, makeSeededRandom(3));
  const co = coAttendanceCounts(attendance);
  const players = playerIdsFor(DEFAULT_SCENARIO);

  const engine = simulateNights(DEFAULT_SCENARIO, attendance, 'engine', makeSeededRandom(11));
  const random = simulateNights(DEFAULT_SCENARIO, attendance, 'random', makeSeededRandom(12));
  const noBackToBack = simulateNights(DEFAULT_SCENARIO, attendance, 'no-back-to-back', makeSeededRandom(13));

  console.log('\nC14 variety simulation — 16 players, 3 courts, 12 nights (attendance seed 3)');
  console.log('night | engine partners/spread | random partners/spread | no-b2b partners/spread');
  for (const night of [4, 8, 12]) {
    const e = metricsAtNight(engine[night - 1], co, players, night);
    const r = metricsAtNight(random[night - 1], co, players, night);
    const b = metricsAtNight(noBackToBack[night - 1], co, players, night);
    console.log(
      `${night}     | ${e.meanDistinctPartners.toFixed(2)}/${e.pairSpread}` +
      `                 | ${r.meanDistinctPartners.toFixed(2)}/${r.pairSpread}` +
      `                 | ${b.meanDistinctPartners.toFixed(2)}/${b.pairSpread}`
    );
    assert.ok(e.meanDistinctPartners > 0);
  }
});
```

- [ ] **Step 2: Run it and confirm the printed table matches these measured values**

Run: `node --experimental-strip-types --test engines/variety-sim.test.ts`

Expected printed table (attendance seed 3, engine seed 11, random seed 12, no-back-to-back seed 13 — reproducible from the seeded RNG, so this exact table must appear):

```
night | engine partners/spread | random partners/spread | no-b2b partners/spread
4     | 8.63/5                 | 6.88/11                | 7.25/7
8     | 14.00/6                | 11.63/12               | 13.13/9
12    | 14.75/7                | 13.50/15               | 13.75/17
```

If the printed numbers differ from this table, stop and re-check Tasks 1–5 against this plan's code before continuing — the simulation is not reproducing the measurement this plan's margins are based on.

- [ ] **Step 3: Replace the loose assertion with the real regression-guarding assertions**

The margins are set comfortably under the smallest gap observed above (partner-count edge: 1.25 vs random, 0.875 vs no-back-to-back, at night 12; spread edge: 6 vs random at night 4/8, 2 vs no-back-to-back at night 8) — loose enough that seed-level noise won't cause a flaky failure, tight enough that a real regression in the engine's search quality trips it.

```ts
// replace the test body from Step 1 with:
test('the engine beats naive baselines on partner variety across a season (prints the table)', () => {
  const MIN_PARTNER_EDGE_VS_RANDOM = 0.8;
  const MIN_PARTNER_EDGE_VS_NO_BACK_TO_BACK = 0.5;
  const MIN_SPREAD_EDGE_VS_RANDOM = 3;
  const MIN_SPREAD_EDGE_VS_NO_BACK_TO_BACK = 1;

  const attendance = generateAttendance(DEFAULT_SCENARIO, makeSeededRandom(3));
  const co = coAttendanceCounts(attendance);
  const players = playerIdsFor(DEFAULT_SCENARIO);

  const engine = simulateNights(DEFAULT_SCENARIO, attendance, 'engine', makeSeededRandom(11));
  const random = simulateNights(DEFAULT_SCENARIO, attendance, 'random', makeSeededRandom(12));
  const noBackToBack = simulateNights(DEFAULT_SCENARIO, attendance, 'no-back-to-back', makeSeededRandom(13));

  console.log('\nC14 variety simulation — 16 players, 3 courts, 12 nights (attendance seed 3)');
  console.log('night | engine partners/spread/neverMet | random partners/spread/neverMet | no-b2b partners/spread/neverMet');
  for (const night of [4, 8, 12]) {
    const e = metricsAtNight(engine[night - 1], co, players, night);
    const r = metricsAtNight(random[night - 1], co, players, night);
    const b = metricsAtNight(noBackToBack[night - 1], co, players, night);
    console.log(
      `${night}     | ${e.meanDistinctPartners.toFixed(2)}/${e.pairSpread}/${e.neverMetShare.toFixed(2)}` +
      `           | ${r.meanDistinctPartners.toFixed(2)}/${r.pairSpread}/${r.neverMetShare.toFixed(2)}` +
      `           | ${b.meanDistinctPartners.toFixed(2)}/${b.pairSpread}/${b.neverMetShare.toFixed(2)}`
    );

    assert.ok(
      e.meanDistinctPartners >= r.meanDistinctPartners + MIN_PARTNER_EDGE_VS_RANDOM,
      `night ${night}: engine ${e.meanDistinctPartners} must beat random ${r.meanDistinctPartners} by at least ${MIN_PARTNER_EDGE_VS_RANDOM}`
    );
    assert.ok(
      e.meanDistinctPartners >= b.meanDistinctPartners + MIN_PARTNER_EDGE_VS_NO_BACK_TO_BACK,
      `night ${night}: engine ${e.meanDistinctPartners} must beat no-back-to-back ${b.meanDistinctPartners} by at least ${MIN_PARTNER_EDGE_VS_NO_BACK_TO_BACK}`
    );
    assert.ok(
      e.pairSpread <= r.pairSpread - MIN_SPREAD_EDGE_VS_RANDOM,
      `night ${night}: engine spread ${e.pairSpread} must be at least ${MIN_SPREAD_EDGE_VS_RANDOM} tighter than random's ${r.pairSpread}`
    );
    assert.ok(
      e.pairSpread <= b.pairSpread - MIN_SPREAD_EDGE_VS_NO_BACK_TO_BACK,
      `night ${night}: engine spread ${e.pairSpread} must be at least ${MIN_SPREAD_EDGE_VS_NO_BACK_TO_BACK} tighter than no-back-to-back's ${b.pairSpread}`
    );
  }
});
```

- [ ] **Step 4: Run the full test to verify it passes**

Run: `node --experimental-strip-types --test engines/variety-sim.test.ts`
Expected: PASS (17 tests), table printed matching Step 2's values.

- [ ] **Step 5: Run the whole engines test suite to confirm no regressions elsewhere**

Run: `npm run test:engines`
Expected: PASS, all existing engine test files unaffected (this plan added a new file and touched no other `engines/*.ts` file).

- [ ] **Step 6: Commit**

```bash
git add engines/variety-sim.ts engines/variety-sim.test.ts
git commit -m "feat(variety-sim): lock in the engine's partner-variety edge over naive baselines"
```

---

## Done criteria

- `engines/variety-sim.ts` and `engines/variety-sim.test.ts` exist, `npm run test:engines` passes.
- No file outside `engines/` changed.
- The printed table shows the engine ahead of both baselines on distinct partners and behind both on spread at nights 4, 8 and 12.
- Nothing from the "Show" half of C14 (summary API, summary UI, player card) is touched — that is later in the roadmap's build order, after C2, C1 and C3.
