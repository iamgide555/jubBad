# Level-Mode Rework + Per-Court Mode Implementation Plan

> **Archived 2026-09-30:** Sub-project B shipped. The step and verification
> checkboxes below were not maintained during implementation; they are not a
> current task list or a claim that each historical step was followed.
> This plan predates the later multi-newcomer carry-game decision. See
> `docs/overview.md` for current behavior and
> `docs/archive/2026-09-27-real-host-feedback.md` for remaining feedback items.
> Implementation steps retain original file paths and may differ from shipped
> behavior; use the Spec link below to find its current archived location.

> **Historical execution note:** This plan originally used superpowers:subagent-driven-development or superpowers:executing-plans with checkbox steps; do not execute it as current work.

**Goal:** Level mode (ตามระดับ) queues by wait time instead of games played, and gives a player far below the group's level one "carry" game partnered with the strongest available player before normal level pairing resumes; custom sessions (เลือกเอง) get a sticky per-court mode so each court can independently run สลับคู่ / สูสี / ระดับ / เลือกเอง.

**Architecture:** The pairing engine (`engines/pairing.ts`) gains a `queueBy` selector for games-vs-wait ordering and a self-contained "carry court" builder that locks the requested court's group *before* the normal search runs, so the search can never split it apart — the search then runs unmodified on whoever is left. The server adds a `Session.courtModes` column (JSON array, same pattern as the existing `courtFormats`) and one `effectiveCourtMode(session, courtNumber)` helper that every per-court call site reads instead of the session-wide mode. The web dashboard adds a 4-segment toggle to each court panel, visible only in custom sessions.

**Tech Stack:** TypeScript (engines, dependency-free), NestJS + Prisma/SQLite (server), Angular standalone components + signals (web), `node:test` (engines), Vitest (server), Angular's `ng test` (web).

**Spec:** `docs/archive/specs/2026-09-27-level-rework-design.md`

## Global Constraints

- Engines stay dependency-free, pure TypeScript — no new imports outside `engines/`'s own files.
- Every new/changed engine function keeps existing callers' behaviour unchanged when new parameters are omitted (all new params get defaults).
- `generateRound`/`selectSittingOut` must never throw for a carry scenario — every carry fallback in the spec resolves to *some* legal round, never an exception.
- History (partner/opponent counts, games played) updates only on confirm, never on propose — nothing in this plan changes that rule.
- A per-court mode change must never rewrite a pending pairing (same rule as the existing session-mode switch).
- Server routes stay owner-guarded exactly like `setCourtFormat`/`setMode`; no new public (`@Public()`) routes.
- All new user-facing strings use `i18n="@@id"` / `$localize` with a Thai source and an English target, following the existing `messages.xlf` / `messages.en.xlf` pair.
- SQLite has no array type — `courtModes` is JSON-encoded text, exactly like `courtFormats`.
- `main` runs real weekly sessions (memory `feedback_poc_branch`) — this plan's branch is `feat/level-rework` (already created, spec committed as `a2bd608`). Do not merge to `main` until this plan's own verification passes.

## Review Focus

- **A far-below player with no waiting-list wait data at all (first ever proposal of the night, before any match).** `history.waitingSince` may be an empty/undefined map for a session's very first propose. `buildCarryCourt` must not crash on a missing `waitingSince` entry (`?? 0` everywhere) — pinned in Task 3.
- **`courtModes` shorter than `courtCount`, or a session that shrank and regrew its court count.** `court-modes.ts`'s `modeAt` must default a missing/out-of-range entry to `'custom'`, matching how `formatAt` defaults to `'doubles'` — pinned in Task 4.
- **Reshuffling a carry court when the pro is also the *only* tagged player left waiting.** Both the "new opponents" and "new pro" paths can fail, and `buildCarryCourt` must fall back to returning the unchanged court rather than `null` (which would read as "not enough players") — pinned in Task 3.
- **A session mid-switch from `custom` back to `level` (or vice versa) with a pending custom draft on one court.** `effectiveCourtMode` must read the *session's* mode once it is no longer `custom`, ignoring any stale `courtModes` entries, and the pending draft must survive the switch untouched — pinned in Task 6.
- **Two far-below players whose *only* possible pro is the same single tagged player.** The second carry (once the first is confirmed) must still produce a valid game (the fallback path, not a thrown error) even though `carriedTonight` now excludes that pro from being picked first — pinned in Task 3.

---

## File Structure

```
engines/
  levels.ts                    # + isFarBelow
  levels.test.ts                # + isFarBelow cases
  pairing.ts                    # + queueBy on selectSittingOut; + buildCarryCourt/pickOpponents; generateRound wiring
  pairing-levels.test.ts        # + wait-only queue, carry, reshuffle cases
server/src/
  player-levels.ts              # + loadLevelSetAt
  sessions/
    court-modes.ts              # NEW — parseCourtModes/modeAt/withModeAt (mirrors court-formats.ts)
    court-modes.spec.ts         # NEW
    session-mode.ts             # + effectiveCourtMode
    session-mode.spec.ts        # + effectiveCourtMode cases
    carry-eligibility.ts        # NEW — pure computeCarryEligibility
    carry-eligibility.spec.ts   # NEW
    dto/set-court-mode.dto.ts   # NEW
    sessions.controller.ts      # + POST :code/courts/:n/mode
    sessions.controller.spec.ts # + endpoint, propose/fill/substitute per-court-mode, carry e2e cases
    sessions.service.ts         # + setCourtMode; courtModes migration read/write; per-court mode wiring in
                                 #   proposeExclusively, fillIdleCourts, swapPlayerExclusively, getSession
  prisma/schema.prisma           # + Session.courtModes
  prisma/migrations/…            # NEW migration
web/src/app/core/
  live-session.model.ts         # CourtState gains `mode` per court
  session.model.ts               # queueBy field
  live-session.service.ts       # + setCourtMode
  waiting-time.ts                # buildWaitingList gains queueBy
  waiting-time.spec.ts           # + queueBy cases
web/src/app/pages/session-dashboard/
  court-panel/court-panel.ts     # + court mode toggle logic
  court-panel/court-panel.html   # + court mode toggle markup
  court-panel/court-panel.spec.ts# + toggle visibility/behaviour cases
  session-dashboard.ts           # queueBy wired into waiting(); custom ระดับ hint condition
  session-dashboard.html         # carry-game line in level hint; custom-mode ระดับ hint
web/src/locale/
  messages.xlf, messages.en.xlf  # regenerated + hand-translated
docs/
  overview.md                    # Pairing section updates
  2026-09-21-feature-review-and-roadmap.md  # A–E items logged
CLAUDE.md                        # engine-rules bullet update
```

---

### Task 1: `isFarBelow` (engines/levels.ts)

**Files:**
- Modify: `engines/levels.ts`
- Test: `engines/levels.test.ts`

**Interfaces:**
- Produces: `isFarBelow(id: string, activeLevels: ReadonlyMap<string, Level | null>): boolean`

- [ ] **Step 1: Write the failing tests**

Append to `engines/levels.test.ts`:

```ts
import { isFarBelow } from './levels.ts';

describe('isFarBelow', () => {
  it('is false for an untagged player', () => {
    const levels = new Map<string, Level | null>([
      ['a', null],
      ['b', 'P'],
    ]);
    assert.equal(isFarBelow('a', levels), false);
  });

  it('is true for a lone BG in an all-P group', () => {
    const levels = new Map<string, Level | null>([
      ['bg', 'BG'],
      ['p1', 'P'],
      ['p2', 'P'],
      ['p3', 'P'],
    ]);
    assert.equal(isFarBelow('bg', levels), true);
  });

  it('is true for both of two BGs in an all-P group', () => {
    const levels = new Map<string, Level | null>([
      ['bg1', 'BG'],
      ['bg2', 'BG'],
      ['p1', 'P'],
      ['p2', 'P'],
    ]);
    assert.equal(isFarBelow('bg1', levels), true);
    assert.equal(isFarBelow('bg2', levels), true);
  });

  it('is false for the lone top outlier (B in an N group)', () => {
    const levels = new Map<string, Level | null>([
      ['b', 'B'],
      ['n1', 'N'],
      ['n2', 'N'],
      ['n3', 'N'],
    ]);
    assert.equal(isFarBelow('b', levels), false);
  });

  it('is false for a middle outlier when someone below them exists', () => {
    const levels = new Map<string, Level | null>([
      ['bg', 'BG'],
      ['s', 'S'],
      ['p1', 'P'],
      ['p2', 'P'],
      ['p3', 'P'],
    ]);
    assert.equal(isFarBelow('s', levels), false);
    assert.equal(isFarBelow('bg', levels), true);
  });

  it('is false once four or more players share the band', () => {
    const levels = new Map<string, Level | null>([
      ['bg', 'BG'],
      ['n1', 'N'],
      ['n2', 'N'],
      ['n3', 'N'],
      ['p1', 'P'],
    ]);
    // bg is N's neighbour band (BG..N is within 1), so with 4 N's/BG already
    // sharing the band (bg + n1 + n2 + n3), it does not qualify.
    assert.equal(isFarBelow('bg', levels), false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test engines/levels.test.ts`
Expected: FAIL with "isFarBelow is not a function" / import error.

- [ ] **Step 3: Implement `isFarBelow`**

In `engines/levels.ts`, append after `withinBand`:

```ts
/**
 * Whether `id` is far enough below tonight's active roster to trigger a
 * carry game (see docs/archive/specs/2026-09-27-level-rework-design.md,
 * section 1b): tagged, fewer than 4 active players (self included) within
 * ±1 of them, and every other tagged player outside that band is above
 * them. An untagged player never qualifies, and — following the same
 * convention as `withinBand` — never counts toward "in band" or "above"
 * for anyone else.
 */
export function isFarBelow(id: string, activeLevels: ReadonlyMap<string, Level | null>): boolean {
  const level = activeLevels.get(id) ?? null;
  if (level === null) return false;

  let inBand = 0;
  for (const [otherId, otherLevel] of activeLevels) {
    if (otherId === id || otherLevel === null) continue;
    if (withinBand(level, otherLevel)) {
      inBand += 1;
    } else if (levelIndex(otherLevel) <= levelIndex(level)) {
      // Another tagged player sits at or below `id`, outside their band —
      // `id` is not at the bottom of the group, so this is never a carry case.
      return false;
    }
  }
  return inBand + 1 < 4; // +1 counts `id` itself.
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --test engines/levels.test.ts`
Expected: PASS, all `isFarBelow` cases green.

- [ ] **Step 5: Commit**

```bash
git add engines/levels.ts engines/levels.test.ts
git commit -m "feat(engine): add isFarBelow for the carry-game trigger"
```

---

### Task 2: `queueBy` on `selectSittingOut` (engines/pairing.ts)

**Files:**
- Modify: `engines/pairing.ts:76-167` (`selectSittingOut`)
- Test: `engines/pairing-levels.test.ts`

**Interfaces:**
- Produces: `selectSittingOut(..., band = false, queueBy: 'games' | 'wait' = 'games')` — unchanged return shape `{ playing, sittingOut }`.

- [ ] **Step 1: Write the failing test**

Append to `engines/pairing-levels.test.ts`:

```ts
test('selectSittingOut with queueBy "wait" ignores games played, orders by wait alone', () => {
  const random = makeSeededRandom(1);
  const gamesPlayedThisSession = new Map([
    ['a', 5], // most games, but longest wait
    ['b', 0],
    ['c', 0],
  ]);
  const waitingSince = new Map([
    ['a', 1000], // earliest = longest wait
    ['b', 3000],
    ['c', 2000],
  ]);
  // 1 doubles court (size 4) for 3 players sits everyone... use 2 for a size-2
  // (singles) cut instead, so exactly one player sits out.
  const result = selectSittingOut(
    ['a', 'b', 'c'],
    [2],
    gamesPlayedThisSession,
    random,
    waitingSince,
    null,
    undefined,
    false,
    'wait'
  );
  // Under 'games' ordering, 'a' (5 games) would sit out first. Under 'wait',
  // 'a' has the longest wait and must play; 'b' (shortest wait) sits.
  assert.deepEqual(result.sittingOut, ['b']);
  assert.deepEqual(new Set(result.playing), new Set(['a', 'c']));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test engines/pairing-levels.test.ts`
Expected: FAIL — `sittingOut` is `['a']` (games-first behaviour), not `['b']`.

- [ ] **Step 3: Implement `queueBy`**

In `engines/pairing.ts`, change `selectSittingOut`'s signature (around line 76) and its sort (around line 120):

```ts
export function selectSittingOut(
  roster: PlayerId[],
  courtCount: number | CourtSize[],
  gamesPlayedThisSession: Map<PlayerId, number>,
  random: () => number,
  waitingSince?: Map<PlayerId, number>,
  recentGroupKeys?: Set<string> | null,
  levels?: ReadonlyMap<PlayerId, Level | null>,
  band = false,
  /**
   * 'wait' (level mode) orders selection by longest wait alone — the "who's
   * waited longer" rule real hosts asked for (2026-09-27 real-host
   * feedback). 'games' (every existing caller, the default) keeps games
   * played first, wait as the tiebreak.
   */
  queueBy: 'games' | 'wait' = 'games'
): { playing: PlayerId[]; sittingOut: PlayerId[] } {
```

Then change the sort body:

```ts
  const shuffled = shuffle(roster, random);
  const sorted = [...shuffled].sort((a, b) => {
    if (queueBy === 'games') {
      const byGames = (gamesPlayedThisSession.get(b) ?? 0) - (gamesPlayedThisSession.get(a) ?? 0);
      if (byGames !== 0) return byGames;
    }
    // Later start of wait means a shorter wait, so that player sits out first.
    return (waitingSince?.get(b) ?? 0) - (waitingSince?.get(a) ?? 0);
  });
```

(The surrounding comments above the sort stay — only the `if (byGames !== 0)` guard and its wrapping `if (queueBy === 'games')` are new.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --test engines/pairing-levels.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full engine suite to confirm no regression**

Run: `npm run test:engines`
Expected: PASS — every existing call site omits `queueBy` and keeps `'games'` behaviour.

- [ ] **Step 6: Commit**

```bash
git add engines/pairing.ts engines/pairing-levels.test.ts
git commit -m "feat(engine): add queueBy to selectSittingOut for wait-only ordering"
```

---

### Task 3: Carry court (engines/pairing.ts)

**Files:**
- Modify: `engines/pairing.ts` — import `withinBand`; add `buildCarryCourt`/`pickOpponents`; rewrite `generateRound` (lines 1041-1188)
- Test: `engines/pairing-levels.test.ts`

**Interfaces:**
- Consumes: `isFarBelow` is NOT used here — the server precomputes `carryEligible`. `withinBand`, `levelIndex` from `./levels.ts`. `groupOf`, `pairKey`, `groupKey` already in this file.
- Produces: `generateRound(roster, courtCount, history, random?, avoidSplit?, ratings?, levels?, band = false, queueBy: 'games' | 'wait' = 'games', carryEligible?: ReadonlySet<PlayerId>, carriedTonight?: ReadonlySet<PlayerId>): RoundResult` — same `RoundResult` shape as before.

- [ ] **Step 1: Write the failing tests**

Append to `engines/pairing-levels.test.ts`:

```ts
function levelMap(entries: Record<string, Level | null>): Map<string, Level | null> {
  return new Map(Object.entries(entries));
}

function historyWithWait(waitingSince: Record<string, number>): MatchHistory {
  return {
    partnerCounts: new Map(),
    opponentCounts: new Map(),
    gamesPlayedThisSession: new Map(),
    waitingSince: new Map(Object.entries(waitingSince)),
  };
}

test('generateRound locks a carry court: far-below anchor partners the highest-level pro', () => {
  const history = historyWithWait({ p1: 1000, p2: 2000, p3: 3000, p4: 4000, p5: 5000 });
  const levels = levelMap({ p1: 'BG', p2: 'P-', p3: 'S', p4: 'P+', p5: 'P' });
  const result = generateRound(
    ['p1', 'p2', 'p3', 'p4', 'p5'],
    1,
    history,
    makeSeededRandom(1),
    undefined,
    undefined,
    levels,
    true, // band (level mode)
    'wait',
    new Set(['p1']), // carryEligible
    new Set() // carriedTonight
  );
  assert.equal(result.courts.length, 1);
  const [court] = result.courts;
  // p1 (anchor) partners p4 (P+, the highest tagged level available).
  assert.deepEqual(new Set(court.teamA), new Set(['p1', 'p4']));
  // Opponents: p5 (P, within ±1 of P+) plus a top-up (no second in-band
  // candidate exists), by longest wait: p2.
  assert.deepEqual(new Set(court.teamB), new Set(['p5', 'p2']));
  // p3 is the only player left over, with no second court offered.
  assert.deepEqual(result.sittingOut, ['p3']);
});

test('generateRound: no tagged player available leaves the round to normal band pairing', () => {
  const history = historyWithWait({ p1: 1000, p2: 2000, p3: 3000, p4: 4000 });
  const levels = levelMap({ p1: 'BG', p2: null, p3: null, p4: null });
  const result = generateRound(
    ['p1', 'p2', 'p3', 'p4'],
    1,
    history,
    makeSeededRandom(1),
    undefined,
    undefined,
    levels,
    true,
    'wait',
    new Set(['p1']),
    new Set()
  );
  assert.equal(result.courts.length, 1);
  const [court] = result.courts;
  // Every player is seated (no untouched carry pool member left dangling),
  // and nobody sits out — the normal path, not a locked carry split.
  assert.deepEqual(new Set([...court.teamA, ...court.teamB]), new Set(['p1', 'p2', 'p3', 'p4']));
  assert.deepEqual(result.sittingOut, []);
});

test('generateRound: reshuffling a carry court with alternates picks new opponents, same pro', () => {
  const history = historyWithWait({
    p1: 1000, // anchor
    p4: 4000, // pro (P+)
    p5: 5000, // first-choice opponent (P)
    p6: 5500, // first-choice opponent (P-)
    p7: 6000, // alternate opponent (P)
    p8: 6500, // alternate opponent (S, still within 1 of P- via the band chain — kept simple: also P)
  });
  const levels = levelMap({ p1: 'BG', p4: 'P+', p5: 'P', p6: 'P-', p7: 'P', p8: 'P' });
  const roster = ['p1', 'p4', 'p5', 'p6', 'p7', 'p8'];
  const first = generateRound(
    roster,
    1,
    history,
    makeSeededRandom(1),
    undefined,
    undefined,
    levels,
    true,
    'wait',
    new Set(['p1']),
    new Set()
  );
  const [firstCourt] = first.courts;
  assert.deepEqual(new Set(firstCourt.teamA), new Set(['p1', 'p4']));
  assert.deepEqual(new Set(firstCourt.teamB), new Set(['p5', 'p6']));

  const reshuffled = generateRound(
    roster,
    1,
    history,
    makeSeededRandom(2),
    { teamA: firstCourt.teamA, teamB: firstCourt.teamB },
    undefined,
    levels,
    true,
    'wait',
    new Set(['p1']),
    new Set()
  );
  const [again] = reshuffled.courts;
  assert.deepEqual(new Set(again.teamA), new Set(['p1', 'p4'])); // same anchor + pro
  assert.deepEqual(new Set(again.teamB), new Set(['p7', 'p8'])); // different opponents
});

test('generateRound: reshuffling falls back to a new pro when opponents cannot change', () => {
  // Same 5-player setup as the first test: only one true in-band opponent
  // (p5) exists for pro p4, so a reshuffle cannot vary the opponents and
  // must try a different pro instead (p5 itself, next-highest tagged).
  const history = historyWithWait({ p1: 1000, p2: 2000, p3: 3000, p4: 4000, p5: 5000 });
  const levels = levelMap({ p1: 'BG', p2: 'P-', p3: 'S', p4: 'P+', p5: 'P' });
  const roster = ['p1', 'p2', 'p3', 'p4', 'p5'];
  const first = generateRound(
    roster, 1, history, makeSeededRandom(1), undefined, undefined, levels, true, 'wait',
    new Set(['p1']), new Set()
  );
  const [firstCourt] = first.courts;
  assert.deepEqual(new Set(firstCourt.teamA), new Set(['p1', 'p4']));

  const reshuffled = generateRound(
    roster, 1, history, makeSeededRandom(3),
    { teamA: firstCourt.teamA, teamB: firstCourt.teamB },
    undefined, levels, true, 'wait', new Set(['p1']), new Set()
  );
  const [again] = reshuffled.courts;
  assert.deepEqual(new Set(again.teamA), new Set(['p1', 'p5'])); // pro changed
  assert.deepEqual(new Set(again.teamB), new Set(['p2', 'p4'])); // opponents changed too, as a side effect
});

test('generateRound: a singles-only offer never triggers a carry court', () => {
  const history = historyWithWait({ p1: 1000, p2: 2000 });
  const levels = levelMap({ p1: 'BG', p2: 'P' });
  const result = generateRound(
    ['p1', 'p2'],
    [2], // singles court
    history,
    makeSeededRandom(1),
    undefined,
    undefined,
    levels,
    true,
    'wait',
    new Set(['p1']),
    new Set()
  );
  assert.equal(result.courts.length, 1);
  assert.equal(result.courts[0].teamA.length, 1);
});
```

Add `MatchHistory` and `Level` types are already imported at the top of `engines/pairing-levels.test.ts` (per Task 2's file); confirm the import line includes `MatchHistory` — if not, add it:

```ts
import { selectSittingOut, generateRound, groupKey, type MatchHistory } from './pairing.ts';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --test engines/pairing-levels.test.ts`
Expected: FAIL — carry tests either throw (missing params accepted but ignored) or assert on team composition that doesn't match today's unconstrained search.

- [ ] **Step 3: Implement `buildCarryCourt`/`pickOpponents` and wire into `generateRound`**

In `engines/pairing.ts`, change the import at the top:

```ts
import { levelIndex, withinBand, type Level } from './levels.ts';
```

Add these two new functions immediately before `generateRound` (i.e. right after `validateRoundInput`, before line 1041):

```ts
/**
 * The best legal opponent pair for a carry court's pro: the two longest-
 * waiting players in `pool` within ±1 of `proLevel`, topped up with the
 * longest-waiting of any level when fewer than two are in band (the carry
 * rule must never make a round unsolvable). Null only when `pool` has fewer
 * than two players at all. An untagged candidate fits any level, matching
 * `withinBand`'s own convention.
 */
function pickOpponents(
  pool: PlayerId[],
  proLevel: Level,
  levels: ReadonlyMap<PlayerId, Level | null>,
  waitingSince: Map<PlayerId, number>
): Team | null {
  const byLongestWait = (a: PlayerId, b: PlayerId) =>
    (waitingSince.get(a) ?? 0) - (waitingSince.get(b) ?? 0);
  const inBand = pool.filter((id) => withinBand(levels.get(id) ?? null, proLevel)).sort(byLongestWait);
  const rest = pool.filter((id) => !inBand.includes(id)).sort(byLongestWait);
  const combined = [...inBand, ...rest];
  return combined.length >= 2 ? [combined[0], combined[1]] : null;
}

/**
 * The requested court's locked carry group, or null when no carry applies —
 * see docs/archive/specs/2026-09-27-level-rework-design.md, section 1b.
 *
 * Only ever considers the *single* longest-waiting player in `roster` as the
 * anchor: once band ordering runs, that player is always the requested
 * court's anchor (`bandOrderedByCourt` processes offered courts in order,
 * starting from the single most-deserving player) — so this function does
 * not need to reimplement band ordering to know who the anchor is.
 *
 * `avoidReshuffle`, when supplied, is the pairing this exact court currently
 * holds (a reshuffle). The pro stays the same and opponents change first;
 * only if no alternate opponents exist does the pro itself change too. If
 * neither changes anything, the original pairing is returned unchanged
 * (never null) — a reshuffle that cannot vary a locked carry court still
 * has to hand back *a* pairing, not "not enough players".
 */
function buildCarryCourt(
  roster: PlayerId[],
  waitingSince: Map<PlayerId, number>,
  levels: ReadonlyMap<PlayerId, Level | null>,
  carryEligible: ReadonlySet<PlayerId>,
  carriedTonight: ReadonlySet<PlayerId>,
  avoidReshuffle?: { teamA: Team; teamB: Team }
): CourtAssignment | null {
  const byLongestWait = [...roster].sort(
    (a, b) => (waitingSince.get(a) ?? 0) - (waitingSince.get(b) ?? 0)
  );
  const anchor = byLongestWait[0];
  if (!carryEligible.has(anchor)) return null;

  let currentTeam: Team | null = null;
  let currentOpponents: Team | null = null;
  if (avoidReshuffle) {
    if (avoidReshuffle.teamA.includes(anchor)) {
      currentTeam = avoidReshuffle.teamA;
      currentOpponents = avoidReshuffle.teamB;
    } else if (avoidReshuffle.teamB.includes(anchor)) {
      currentTeam = avoidReshuffle.teamB;
      currentOpponents = avoidReshuffle.teamA;
    }
  }
  const currentPro = currentTeam?.find((id) => id !== anchor) ?? null;

  const candidatePool = roster.filter((id) => id !== anchor);
  const proCandidates = candidatePool
    .filter((id) => levels.get(id) != null)
    .sort((a, b) => {
      const diff = levelIndex(levels.get(b)!) - levelIndex(levels.get(a)!);
      if (diff !== 0) return diff;
      const aCarried = carriedTonight.has(a) ? 1 : 0;
      const bCarried = carriedTonight.has(b) ? 1 : 0;
      if (aCarried !== bCarried) return aCarried - bCarried; // not-carried-tonight first
      return (waitingSince.get(a) ?? 0) - (waitingSince.get(b) ?? 0); // longest wait first
    });
  const proOrder = currentPro
    ? [currentPro, ...proCandidates.filter((id) => id !== currentPro)]
    : proCandidates;

  for (const pro of proOrder) {
    const proLevel = levels.get(pro)!;
    const opponentPool = candidatePool.filter(
      (id) => id !== pro && !(pro === currentPro && currentOpponents?.includes(id))
    );
    const opponents = pickOpponents(opponentPool, proLevel, levels, waitingSince);
    if (opponents) {
      return { court: 1, teamA: [anchor, pro], teamB: opponents };
    }
  }

  if (currentPro && currentOpponents) {
    return { court: 1, teamA: [anchor, currentPro], teamB: currentOpponents };
  }
  return null;
}
```

Now replace the whole `generateRound` function body (lines 1041-1188) with:

```ts
export function generateRound(
  roster: PlayerId[],
  courtCount: number | CourtSize[],
  history: MatchHistory,
  random: () => number = Math.random,
  avoidSplit?: { teamA: Team; teamB: Team },
  /** Supplied only in balanced mode; omitted, behaviour is unchanged. */
  ratings?: RatingsInput,
  /** A player's skill level. Omitted, or `band` false, behaviour is unchanged. */
  levels?: ReadonlyMap<PlayerId, Level | null>,
  /** The ±1 level band (D4, soft-dominant). Off by default. */
  band = false,
  /** 'wait' (level mode) orders selection by longest wait alone; 'games'
   *  (every pre-existing caller, the default) keeps games played first. */
  queueBy: 'games' | 'wait' = 'games',
  /** Players eligible for a carry game right now (level mode only) — see
   *  docs/archive/specs/2026-09-27-level-rework-design.md, section 1b. */
  carryEligible?: ReadonlySet<PlayerId>,
  /** Players who have already partnered a carry-eligible player tonight,
   *  deprioritised as the next carry's pro. */
  carriedTonight?: ReadonlySet<PlayerId>
): RoundResult {
  validateRoundInput(roster, courtCount, history, avoidSplit, ratings);

  const sizes = normalizeSizes(courtCount);

  // Carry game: once band ordering runs, the single longest-waiting player
  // in the whole roster is always the requested court's anchor
  // (bandOrderedByCourt processes offered courts in order, starting from
  // the single most-deserving player) — so whether *that* player is
  // carry-eligible fully decides whether the requested court becomes a
  // carry game. Resolved up front, and only ever touches court 0 (the
  // requested court), exactly like avoidSplit's own court-0-only reach.
  let carryCourt: CourtAssignment | null = null;
  let carryGroup: Set<PlayerId> | null = null;
  if (
    band &&
    levels &&
    carryEligible?.size &&
    sizes[0] === 4 &&
    roster.length >= 4 &&
    history.waitingSince
  ) {
    carryCourt = buildCarryCourt(
      roster,
      history.waitingSince,
      levels,
      carryEligible,
      carriedTonight ?? new Set(),
      avoidSplit
    );
    if (carryCourt) carryGroup = new Set(groupOf(carryCourt));
  }

  const effectiveRoster = carryGroup ? roster.filter((id) => !carryGroup!.has(id)) : roster;
  const effectiveSizes = carryCourt ? sizes.slice(1) : sizes;
  // A carry court already consumed avoidSplit (as buildCarryCourt's
  // avoidReshuffle) — it must not also exclude a split in the remaining
  // search, which no longer shares any court with it.
  const effectiveAvoidSplit = carryCourt ? undefined : avoidSplit;

  const avoidKeys =
    effectiveAvoidSplit && effectiveAvoidSplit.teamA.length === 2
      ? new Set([
          pairKey(effectiveAvoidSplit.teamA[0], effectiveAvoidSplit.teamA[1]),
          pairKey(effectiveAvoidSplit.teamB[0], effectiveAvoidSplit.teamB[1]),
        ])
      : null;

  const recentGroupKeys =
    effectiveAvoidSplit && effectiveAvoidSplit.teamA.length === 1
      ? new Set([
          ...(history.recentGroupKeys ?? []),
          groupKey([...effectiveAvoidSplit.teamA, ...effectiveAvoidSplit.teamB]),
        ])
      : history.recentGroupKeys ?? null;

  const { playing, sittingOut } = selectSittingOut(
    effectiveRoster,
    effectiveSizes,
    history.gamesPlayedThisSession,
    random,
    history.waitingSince,
    recentGroupKeys,
    levels,
    band,
    queueBy
  );

  const offered = consumedSizes(effectiveSizes, playing.length);

  if (offered.length === 0) {
    return { courts: carryCourt ? [carryCourt] : [], sittingOut };
  }

  const floors = historyFloors(playing, history.partnerCounts, history.opponentCounts);
  const ctx: SearchContext = {
    partnerCounts: history.partnerCounts,
    opponentCounts: history.opponentCounts,
    ratings,
    floors,
    avoidKeys,
    recentGroupKeys,
    levels: band ? levels : undefined,
  };

  const better = (candidate: CourtAssignment[], incumbent: CourtAssignment[] | null): boolean =>
    !incumbent ||
    compareArrangements(
      candidate,
      incumbent,
      history.partnerCounts,
      history.opponentCounts,
      ratings,
      floors,
      recentGroupKeys,
      ctx.levels
    ) < 0;

  let best: CourtAssignment[] | null = null;
  const uniform = offered.every((s) => s === offered[0]);

  if (playing.length <= EXACT_ENUMERATION_MAX_PLAYING) {
    forEachExactArrangement(shuffle(playing, random), offered, (groups) => {
      if (uniform) {
        for (let lead = 0; lead < groups.length; lead++) {
          const ordered = [...groups.slice(lead), ...groups.slice(0, lead)];
          const candidate = bestArrangementForGroups(ordered, ctx);
          if (candidate && better(candidate, best)) best = candidate;
        }
      } else {
        for (let j = 0; j < groups.length; j++) {
          if (offered[j] !== offered[0]) continue;
          const ordered = [...groups];
          if (j !== 0) [ordered[0], ordered[j]] = [ordered[j], ordered[0]];
          const candidate = bestArrangementForGroups(ordered, ctx);
          if (candidate && better(candidate, best)) best = candidate;
        }
      }
    });
  } else {
    let sinceImprovement = 0;
    for (let restart = 0; restart < SEARCH_RESTARTS; restart++) {
      const seed = bestArrangementForGroups(
        buildRandomArrangement(playing, offered, random).map(groupOf),
        ctx
      );
      if (!seed) continue;
      const improved = improveArrangement(seed, ctx);
      if (better(improved, best)) {
        best = improved;
        sinceImprovement = 0;
      } else if (++sinceImprovement >= SEARCH_RESTART_PATIENCE) {
        break;
      }
    }
  }

  const searched = (best ?? []).map((c) => (carryCourt ? { ...c, court: c.court + 1 } : c));
  return { courts: carryCourt ? [carryCourt, ...searched] : searched, sittingOut };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --test engines/pairing-levels.test.ts`
Expected: PASS, all 5 new carry tests green (plus Task 2's `queueBy` test).

- [ ] **Step 5: Run the full engine suite, including quality/golden regression**

Run: `npm run test:engines`
Expected: PASS. `pairing-quality.test.ts` and `pairing-golden.test.ts` call `generateRound`/`selectSittingOut` without `carryEligible`, so the new code paths are never entered — behaviour must be byte-identical to before this task.

- [ ] **Step 6: Commit**

```bash
git add engines/pairing.ts engines/pairing-levels.test.ts
git commit -m "feat(engine): lock a carry court for a far-below player's first game after tag"
```

---

### Task 4: `court-modes.ts` (server, mirrors `court-formats.ts`)

**Files:**
- Create: `server/src/sessions/court-modes.ts`
- Test: `server/src/sessions/court-modes.spec.ts`

**Interfaces:**
- Produces: `parseCourtModes(raw: string | null): SessionMode[]`, `modeAt(raw: string | null, courtNumber: number): SessionMode`, `withModeAt(raw: string | null, courtNumber: number, mode: SessionMode): string`, re-exports `InvalidCourtNumberError` semantics via its own class (mirroring `court-formats.ts`'s own).
- Consumes: `SESSION_MODES`, `type SessionMode` from `./session-mode.js`.

- [ ] **Step 1: Write the failing tests**

Create `server/src/sessions/court-modes.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  InvalidCourtNumberError,
  modeAt,
  parseCourtModes,
  withModeAt,
} from './court-modes.js';

describe('parseCourtModes', () => {
  it('reads a null column as no entries', () => {
    expect(parseCourtModes(null)).toEqual([]);
  });

  it('reads a malformed value as no entries rather than throwing', () => {
    expect(parseCourtModes('not json')).toEqual([]);
  });

  it('normalises an unrecognised entry to custom', () => {
    expect(parseCourtModes('["level","garbage",42]')).toEqual(['level', 'custom', 'custom']);
  });
});

describe('modeAt', () => {
  it('defaults to custom for a null column', () => {
    expect(modeAt(null, 1)).toBe('custom');
  });

  it('defaults to custom past the end of a short array', () => {
    expect(modeAt('["level"]', 3)).toBe('custom');
  });

  it('reads the entry for the requested court', () => {
    expect(modeAt('["variety","level"]', 2)).toBe('level');
  });
});

describe('withModeAt', () => {
  it('pads gaps with custom, never with the new value', () => {
    const result = withModeAt(null, 3, 'level');
    expect(JSON.parse(result)).toEqual(['custom', 'custom', 'level']);
  });

  it('preserves an existing entry when setting another court', () => {
    const withCourt2 = withModeAt(null, 2, 'level');
    const withCourt1Too = withModeAt(withCourt2, 1, 'variety');
    expect(JSON.parse(withCourt1Too)).toEqual(['variety', 'level']);
  });

  it('overwrites an existing entry for the same court', () => {
    const set = withModeAt('["level"]', 1, 'balanced');
    expect(JSON.parse(set)).toEqual(['balanced']);
  });

  it('throws rather than silently dropping a write for a court beyond the maximum', () => {
    expect(() => withModeAt(null, 25, 'level')).toThrow(InvalidCourtNumberError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/sessions/court-modes.spec.ts`
Expected: FAIL — `./court-modes.js` does not exist.

- [ ] **Step 3: Implement `court-modes.ts`**

Create `server/src/sessions/court-modes.ts`:

```ts
/**
 * `Session.courtModes` — a per-court pairing mode, JSON-encoded as a string
 * array in a TEXT column, the same convention as `courtFormats`
 * (`court-formats.ts`). Index 0 is court 1. Read only while the session's
 * own `mode` is `'custom'` — see `session-mode.ts`'s `effectiveCourtMode`.
 *
 * Null, missing, or an unrecognised entry all read as `'custom'` — every
 * custom session that predates this column, and every court a host has
 * never touched, keeps behaving exactly as it always did (an empty draft
 * the host fills by hand).
 */

import { InvalidCourtNumberError } from './court-formats.js';
import { SESSION_MODES, type SessionMode } from './session-mode.js';

/** Matches court-formats.ts's own cap. */
const MAX_COURTS = 20;

export { InvalidCourtNumberError };

export function parseCourtModes(raw: string | null): SessionMode[] {
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.map((entry) =>
    (SESSION_MODES as readonly string[]).includes(entry) ? (entry as SessionMode) : 'custom'
  );
}

/** The mode for one court, defaulting to custom when unset or out of range. */
export function modeAt(raw: string | null, courtNumber: number): SessionMode {
  const modes = parseCourtModes(raw);
  return modes[courtNumber - 1] ?? 'custom';
}

/** Sets one court's mode, padding any gap before it with 'custom'. Mirrors
 *  `withFormatAt`'s own reasoning, including the throw for a court number
 *  beyond `MAX_COURTS` rather than a silently-truncated write. */
export function withModeAt(raw: string | null, courtNumber: number, mode: SessionMode): string {
  if (courtNumber > MAX_COURTS) {
    throw new InvalidCourtNumberError(courtNumber);
  }
  const modes = parseCourtModes(raw);
  while (modes.length < courtNumber) modes.push('custom');
  modes[courtNumber - 1] = mode;
  return JSON.stringify(modes.slice(0, MAX_COURTS));
}
```

Note: `InvalidCourtNumberError` in `court-formats.ts` is currently declared but check whether it is exported — if not, export it there first (one-line change: `export class InvalidCourtNumberError ...` is already `export`ed per the file read during planning; if the running codebase disagrees, add `export` to that class declaration in `court-formats.ts` as part of this step).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/sessions/court-modes.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/sessions/court-modes.ts server/src/sessions/court-modes.spec.ts
git commit -m "feat(server): add court-modes.ts, per-court mode storage helpers"
```

---

### Task 5: `Session.courtModes` migration

**Files:**
- Modify: `server/prisma/schema.prisma`
- Create: `server/prisma/migrations/<timestamp>_add_session_court_modes/migration.sql` (generated)

**Interfaces:**
- Produces: `Session.courtModes String?` column, readable via `session.courtModes` on every Prisma query already selecting the `Session` model's scalar fields.

- [ ] **Step 1: Add the column to the schema**

In `server/prisma/schema.prisma`, inside `model Session`, add `courtModes` next to `courtFormats`:

```prisma
model Session {
  code          String          @id
  groupId       String
  date          String?
  venue         String?
  courtCount    Int?
  rawImportText String
  createdAt     DateTime        @default(now())
  endedAt       DateTime?
  mode          String          @default("variety")
  courtFormats  String?
  courtModes    String?
  shuttleCount        Int?
  shuttlePriceSatang  Int?
  billConfig          String?
  group         Group           @relation(fields: [groupId], references: [code])
  roster        SessionRoster[]
  waitlist      Waitlist[]
  pairings      Pairing[]
  creation      SessionCreation?
}
```

- [ ] **Step 2: Generate and apply the migration**

Run: `cd server && npx prisma migrate dev --name add_session_court_modes`
Expected: a new `server/prisma/migrations/<timestamp>_add_session_court_modes/migration.sql` file containing `ALTER TABLE "Session" ADD COLUMN "courtModes" TEXT;`, applied to the dev database, and the Prisma client regenerated (so `session.courtModes` type-checks).

- [ ] **Step 3: Verify the server still builds and its existing tests still pass**

Run: `cd server && npm test`
Expected: PASS — the new nullable column changes nothing for existing rows or code paths yet (nothing reads or writes it until Task 9).

- [ ] **Step 4: Commit**

```bash
git add server/prisma/schema.prisma server/prisma/migrations
git commit -m "feat(server): add Session.courtModes column"
```

---

### Task 6: `effectiveCourtMode` (server/src/sessions/session-mode.ts)

**Files:**
- Modify: `server/src/sessions/session-mode.ts`
- Test: `server/src/sessions/session-mode.spec.ts`

**Interfaces:**
- Consumes: `modeAt` from `./court-modes.js`.
- Produces: `effectiveCourtMode(session: { mode: string; courtModes: string | null }, courtNumber: number): SessionMode`.

- [ ] **Step 1: Write the failing tests**

Append to `server/src/sessions/session-mode.spec.ts`:

```ts
import { effectiveCourtMode } from './session-mode.js';

describe('effectiveCourtMode', () => {
  it('returns the session mode directly when the session is not custom', () => {
    expect(effectiveCourtMode({ mode: 'level', courtModes: '["variety"]' }, 1)).toBe('level');
    expect(effectiveCourtMode({ mode: 'balanced', courtModes: null }, 1)).toBe('balanced');
  });

  it('reads the court-specific entry when the session is custom', () => {
    expect(effectiveCourtMode({ mode: 'custom', courtModes: '["level","balanced"]' }, 1)).toBe(
      'level'
    );
    expect(effectiveCourtMode({ mode: 'custom', courtModes: '["level","balanced"]' }, 2)).toBe(
      'balanced'
    );
  });

  it('defaults an untouched court to custom while the session is custom', () => {
    expect(effectiveCourtMode({ mode: 'custom', courtModes: null }, 1)).toBe('custom');
    expect(effectiveCourtMode({ mode: 'custom', courtModes: '["level"]' }, 5)).toBe('custom');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/sessions/session-mode.spec.ts`
Expected: FAIL — `effectiveCourtMode` is not exported.

- [ ] **Step 3: Implement `effectiveCourtMode`**

In `server/src/sessions/session-mode.ts`, add the import and function:

```ts
import { modeAt } from './court-modes.js';

/**
 * The pairing mode that actually governs one court right now: the session's
 * own mode everywhere except a `custom` session, where each court has its
 * own sticky mode (2026-09-27 real-host feedback) — see `court-modes.ts`.
 * Every per-court engine call site reads this instead of `session.mode`
 * directly.
 */
export function effectiveCourtMode(
  session: { mode: string; courtModes: string | null },
  courtNumber: number
): SessionMode {
  if (!isCustomMode(session.mode)) return session.mode as SessionMode;
  return modeAt(session.courtModes, courtNumber);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/sessions/session-mode.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/sessions/session-mode.ts server/src/sessions/session-mode.spec.ts
git commit -m "feat(server): add effectiveCourtMode for per-court mode resolution"
```

---

### Task 7: `loadLevelSetAt` (server/src/player-levels.ts)

**Files:**
- Modify: `server/src/player-levels.ts`
- Test: `server/src/sessions/carry-eligibility.spec.ts` will cover this indirectly in Task 8; this task keeps its own smoke check inline (Step 3) since `player-levels.ts` has no dedicated spec file today.

**Interfaces:**
- Produces: `loadLevelSetAt(prisma: PrismaService, groupId: string): Promise<Map<string, number>>` — player id -> `levelSetAt` in epoch ms, only for players who have ever been tagged (matches `loadRatingAnchors`'s own query shape).

- [ ] **Step 1: Implement `loadLevelSetAt`**

In `server/src/player-levels.ts`, append:

```ts
/** Player id -> when their level was last set (epoch ms), for every player
 *  who has ever been tagged. Untagged players (never set) are absent, not 0
 *  — a carry check must never treat "never tagged" as "tagged just now". */
export async function loadLevelSetAt(
  prisma: PrismaService,
  groupId: string
): Promise<Map<string, number>> {
  const players = await prisma.player.findMany({
    where: { groupId, levelSetAt: { not: null } },
    select: { id: true, levelSetAt: true },
  });
  return new Map(players.map((p) => [p.id, p.levelSetAt!.getTime()]));
}
```

- [ ] **Step 2: Verify it compiles and the server test suite still passes**

Run: `cd server && npm test`
Expected: PASS (nothing calls this yet; a pure addition).

- [ ] **Step 3: Commit**

```bash
git add server/src/player-levels.ts
git commit -m "feat(server): add loadLevelSetAt for carry-eligibility timing"
```

---

### Task 8: `computeCarryEligibility` (server/src/sessions/carry-eligibility.ts)

**Files:**
- Create: `server/src/sessions/carry-eligibility.ts`
- Test: `server/src/sessions/carry-eligibility.spec.ts`

**Interfaces:**
- Consumes: `isFarBelow` from `../../../engines/levels.ts`.
- Produces: `computeCarryEligibility(input: CarryInputs): { carryEligible: Set<string>; carriedTonight: Set<string> }`, with `CarryInputs` as defined below — a pure function, no Prisma dependency, so it is directly unit-testable.

- [ ] **Step 1: Write the failing tests**

Create `server/src/sessions/carry-eligibility.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeCarryEligibility } from './carry-eligibility.js';

describe('computeCarryEligibility', () => {
  it('marks a far-below player eligible when never played tonight', () => {
    const { carryEligible } = computeCarryEligibility({
      activeRosterIds: ['bg', 'p1', 'p2', 'p3'],
      levels: new Map([
        ['bg', 'BG'],
        ['p1', 'P'],
        ['p2', 'P'],
        ['p3', 'P'],
      ]),
      levelSetAt: new Map([['bg', 1000]]),
      confirmedPairingsTonight: [],
    });
    expect(carryEligible.has('bg')).toBe(true);
  });

  it('is not eligible once they have a confirmed game since their tag', () => {
    const { carryEligible } = computeCarryEligibility({
      activeRosterIds: ['bg', 'p1', 'p2', 'p3'],
      levels: new Map([
        ['bg', 'BG'],
        ['p1', 'P'],
        ['p2', 'P'],
        ['p3', 'P'],
      ]),
      levelSetAt: new Map([['bg', 1000]]),
      confirmedPairingsTonight: [{ playerIds: ['bg', 'p1', 'p2', 'p3'], confirmedAt: 2000 }],
    });
    expect(carryEligible.has('bg')).toBe(false);
  });

  it('is eligible again for a confirmed game that predates the (re-)tag', () => {
    const { carryEligible } = computeCarryEligibility({
      activeRosterIds: ['bg', 'p1', 'p2', 'p3'],
      levels: new Map([
        ['bg', 'BG'],
        ['p1', 'P'],
        ['p2', 'P'],
        ['p3', 'P'],
      ]),
      levelSetAt: new Map([['bg', 5000]]), // tagged after that earlier game
      confirmedPairingsTonight: [{ playerIds: ['bg', 'p1', 'p2', 'p3'], confirmedAt: 2000 }],
    });
    expect(carryEligible.has('bg')).toBe(true);
  });

  it('never marks an untagged player eligible', () => {
    const { carryEligible } = computeCarryEligibility({
      activeRosterIds: ['x', 'p1', 'p2', 'p3'],
      levels: new Map([
        ['x', null],
        ['p1', 'P'],
        ['p2', 'P'],
        ['p3', 'P'],
      ]),
      levelSetAt: new Map(),
      confirmedPairingsTonight: [],
    });
    expect(carryEligible.size).toBe(0);
  });

  it('marks carriedTonight for whoever partnered a currently-eligible player tonight', () => {
    const { carriedTonight } = computeCarryEligibility({
      activeRosterIds: ['bg1', 'bg2', 'pro', 'p1', 'p2'],
      levels: new Map([
        ['bg1', 'BG'],
        ['bg2', 'BG'],
        ['pro', 'C'],
        ['p1', 'P'],
        ['p2', 'P'],
      ]),
      levelSetAt: new Map([
        ['bg1', 1000],
        ['bg2', 1000],
      ]),
      confirmedPairingsTonight: [{ playerIds: ['bg1', 'pro', 'p1', 'p2'], confirmedAt: 2000 }],
    });
    // bg1 already played (with pro) since being tagged, so bg1 is no longer
    // eligible — but bg2 still is, and `pro` carried a (then-)eligible
    // player tonight.
    expect(carriedTonight.has('pro')).toBe(true);
    expect(carriedTonight.has('bg1')).toBe(false); // bg1 is not "carried" for itself
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/sessions/carry-eligibility.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `carry-eligibility.ts`**

Create `server/src/sessions/carry-eligibility.ts`:

```ts
/**
 * Which active players are eligible for a carry game right now, and who has
 * already carried one tonight — pure, DB-agnostic derivation so it can be
 * unit-tested without Prisma. See
 * docs/archive/specs/2026-09-27-level-rework-design.md, section 1b.
 */

import { isFarBelow } from '../../../engines/levels.ts';
import type { Level } from '../../../engines/levels.ts';

export interface CarryInputs {
  /** Active roster player ids tonight. */
  activeRosterIds: string[];
  /** Every active player's tag, keyed by id. */
  levels: ReadonlyMap<string, Level | null>;
  /** Player id -> Player.levelSetAt (epoch ms), for players ever tagged. */
  levelSetAt: ReadonlyMap<string, number>;
  /** This session's confirmed pairings: each entry's player ids + confirmedAt (epoch ms). */
  confirmedPairingsTonight: { playerIds: string[]; confirmedAt: number }[];
}

export interface CarryEligibility {
  /** Far-below active players with no confirmed game tonight since their level was tagged. */
  carryEligible: Set<string>;
  /** Players who partnered a currently-far-below player in a confirmed game tonight. */
  carriedTonight: Set<string>;
}

export function computeCarryEligibility(input: CarryInputs): CarryEligibility {
  const activeLevels = new Map(
    input.activeRosterIds.map((id) => [id, input.levels.get(id) ?? null] as const)
  );

  const playedSince = (id: string, sinceMs: number): boolean =>
    input.confirmedPairingsTonight.some(
      (p) => p.confirmedAt >= sinceMs && p.playerIds.includes(id)
    );

  const carryEligible = new Set<string>();
  for (const id of input.activeRosterIds) {
    if (!isFarBelow(id, activeLevels)) continue;
    const setAt = input.levelSetAt.get(id);
    if (setAt === undefined) continue; // isFarBelow already requires a tag; guards a missing entry
    if (playedSince(id, setAt)) continue;
    carryEligible.add(id);
  }

  const carriedTonight = new Set<string>();
  for (const p of input.confirmedPairingsTonight) {
    if (!p.playerIds.some((id) => carryEligible.has(id))) continue;
    for (const id of p.playerIds) {
      if (!carryEligible.has(id)) carriedTonight.add(id);
    }
  }

  return { carryEligible, carriedTonight };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/sessions/carry-eligibility.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/sessions/carry-eligibility.ts server/src/sessions/carry-eligibility.spec.ts
git commit -m "feat(server): add computeCarryEligibility"
```

---

### Task 9: `POST :code/courts/:n/mode` endpoint

**Files:**
- Create: `server/src/sessions/dto/set-court-mode.dto.ts`
- Modify: `server/src/sessions/sessions.controller.ts`
- Modify: `server/src/sessions/sessions.service.ts` (add `setCourtMode`/`setCourtModeExclusively`, mirroring `setCourtFormat`/`setCourtFormatExclusively` at `:1630-1676`)
- Test: `server/src/sessions/sessions.controller.spec.ts`

**Interfaces:**
- Consumes: `withModeAt`, `modeAt` from `./court-modes.js`; `SESSION_MODES` from `./session-mode.js`.
- Produces: `SessionsService.setCourtMode(code, courtNumber, dto): Promise<{ code: string; courtNumber: number; mode: SessionMode }>`.

- [ ] **Step 1: Write the failing test**

Add to `server/src/sessions/sessions.controller.spec.ts` (near the existing court-format tests — search the file for `courts/1/format` to find that block and add this alongside it):

```ts
it('sets and reads back one court\'s mode in a custom session', async () => {
  const groupCode = randomUUID();
  await prisma.group.create({ data: { code: groupCode, name: 'G' } });
  const session = await createSessionWithRoster(prisma, service, groupCode, 4);
  await prisma.session.update({ where: { code: session.code }, data: { mode: 'custom' } });

  await request(server)
    .post(`/sessions/${session.code}/courts/1/mode`)
    .send({ mode: 'level' })
    .expect(201)
    .expect((res) => {
      expect(res.body).toEqual({ code: session.code, courtNumber: 1, mode: 'level' });
    });

  const read = await request(server).get(`/sessions/${session.code}`).expect(200);
  expect(read.body.courts[0].mode).toBe('level');
});

it('refuses to set a court mode after the session ends', async () => {
  const groupCode = randomUUID();
  await prisma.group.create({ data: { code: groupCode, name: 'G' } });
  const session = await createSessionWithRoster(prisma, service, groupCode, 4);
  await prisma.session.update({
    where: { code: session.code },
    data: { mode: 'custom', endedAt: new Date() },
  });

  await request(server)
    .post(`/sessions/${session.code}/courts/1/mode`)
    .send({ mode: 'level' })
    .expect(409)
    .expect((res) => {
      expect(res.body.code).toBe('SESSION_ENDED');
    });
});
```

If this spec file has no existing `createSessionWithRoster` test helper, use whichever helper the neighbouring `courts/1/format` tests already use to stand up a session with an active roster (search the file for the format-toggle test block and copy its setup exactly) rather than inventing a new one.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/sessions/sessions.controller.spec.ts -t "court's mode"`
Expected: FAIL — 404, no such route.

- [ ] **Step 3: Implement the DTO, service method, and route**

Create `server/src/sessions/dto/set-court-mode.dto.ts`:

```ts
import { IsIn } from 'class-validator';
import { SESSION_MODES, type SessionMode } from '../session-mode.js';

export class SetCourtModeDto {
  @IsIn(SESSION_MODES)
  mode!: SessionMode;
}
```

In `server/src/sessions/sessions.service.ts`, add near `setCourtFormat`/`setCourtFormatExclusively` (`:1630-1676`):

```ts
setCourtMode(code: string, courtNumber: number, dto: SetCourtModeDto) {
  return this.lock.run(code, () => this.setCourtModeExclusively(code, courtNumber, dto));
}

/**
 * Unlike the format toggle, allowed in any court state — a court's mode
 * changes only what the *next* propose/reshuffle does, and (like the
 * session-wide mode switch) never rewrites a pending pairing.
 */
private async setCourtModeExclusively(code: string, courtNumber: number, dto: SetCourtModeDto) {
  const session = await this.prisma.session.findUnique({ where: { code } });
  if (!session) throw this.notFound('SESSION_NOT_FOUND');
  if (session.endedAt !== null) throw this.conflict('SESSION_ENDED');
  this.assertCourtNumber(session.courtCount, courtNumber);

  let courtModes: string;
  try {
    courtModes = withModeAt(session.courtModes, courtNumber, dto.mode);
  } catch (error) {
    if (error instanceof InvalidCourtNumberError) throw this.badRequest('INVALID_COURT_NUMBER');
    throw error;
  }
  const updated = await this.prisma.session.update({
    where: { code },
    data: { courtModes },
  });
  return {
    code: updated.code,
    courtNumber,
    mode: modeAt(updated.courtModes, courtNumber),
  };
}
```

Add the imports at the top of `sessions.service.ts`:

```ts
import { InvalidCourtNumberError, modeAt, withModeAt } from './court-modes.js';
import { SetCourtModeDto } from './dto/set-court-mode.dto.js';
```

(If `InvalidCourtNumberError` is already imported from `court-formats.js` for the existing format endpoint, either import name works since Task 4 re-exports the same class — do not import it twice under the same name from two paths.)

In `server/src/sessions/sessions.controller.ts`, add the import and route next to `setCourtFormat`:

```ts
import { SetCourtModeDto } from './dto/set-court-mode.dto.js';
```

```ts
/**
 * Per-court sticky mode, custom sessions only in effect (see
 * effectiveCourtMode) — settable in any court state, unlike the format
 * toggle, since it never changes a live pairing's shape.
 */
@Post(':code/courts/:n/mode')
setCourtMode(
  @Param('code') code: string,
  @Param('n', ParseIntPipe) courtNumber: number,
  @Body() dto: SetCourtModeDto
) {
  return this.sessionsService.setCourtMode(code, courtNumber, dto);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/sessions/sessions.controller.spec.ts -t "court's mode"`
Expected: PASS.

Also run: `cd server && npx vitest run src/sessions/sessions.controller.spec.ts -t "refuses to set a court mode"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/sessions/dto/set-court-mode.dto.ts server/src/sessions/sessions.controller.ts server/src/sessions/sessions.service.ts server/src/sessions/sessions.controller.spec.ts
git commit -m "feat(server): add POST :code/courts/:n/mode endpoint"
```

---

### Task 10: Wire per-court mode + carry into `getSession` and `proposeExclusively`

**Files:**
- Modify: `server/src/sessions/sessions.service.ts` — `getSession` (`:396-500`), `proposeExclusively` (`:603-736`)
- Test: `server/src/sessions/sessions.controller.spec.ts`

**Interfaces:**
- Consumes: `effectiveCourtMode` (Task 6), `computeCarryEligibility` (Task 8), `loadLevelSetAt` (Task 7), `isLevelMode` from `./session-mode.js` (already imported).
- Produces: `getSession` response gains `courts[i].mode` and a top-level `queueBy: 'games' | 'wait'`. `proposeExclusively` honours the requested court's effective mode, including carry.

- [ ] **Step 1: Write the failing tests**

Add to `server/src/sessions/sessions.controller.spec.ts`, near the existing level-mode propose tests (search for `isLevelMode` or `'level'` in this file to find that block):

This spec file has no existing shared session-bootstrap helper — every test
creates its `Group`/`Player`/`Session`/`SessionRoster` rows directly via
`prisma.*.create` and cleans up in a `finally` block (see e.g. `'custom mode
proposes an empty pairing for the host to fill by hand'`, `:1875-1914`).
Follow that exact pattern:

```ts
it('proposes a level-mode court queued by wait, not games played', async () => {
  const groupCode = randomUUID();
  const sessionCode = randomUUID();
  await prisma.group.create({ data: { code: groupCode, name: 'G' } });
  const players = await Promise.all(
    ['P1', 'P2', 'P3', 'P4', 'P5', 'FillerA', 'FillerB'].map((name) =>
      prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
    )
  );
  const [p1, p2, p3, p4, p5, fillerA, fillerB] = players;
  const now = Date.now();
  await prisma.session.create({
    data: {
      code: sessionCode,
      groupId: groupCode,
      courtCount: 1,
      rawImportText: '',
      mode: 'level',
      createdAt: new Date(now - 60 * 60_000),
    },
  });
  for (const p of [p1, p2, p3, p4, p5]) {
    await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
  }
  // p1 already played two games, both finished long ago: the most games of
  // anyone, but also the longest wait since.
  await prisma.pairing.create({
    data: {
      sessionId: sessionCode,
      courtNumber: 1,
      matchNumber: 1,
      teamA: JSON.stringify([p1.id, fillerA.id]),
      teamB: JSON.stringify([fillerB.id, p2.id]),
      confirmedAt: new Date(now - 58 * 60_000),
      endedAt: new Date(now - 56 * 60_000),
    },
  });
  await prisma.pairing.create({
    data: {
      sessionId: sessionCode,
      courtNumber: 1,
      matchNumber: 2,
      teamA: JSON.stringify([p1.id, fillerA.id]),
      teamB: JSON.stringify([fillerB.id, p3.id]),
      confirmedAt: new Date(now - 54 * 60_000),
      endedAt: new Date(now - 52 * 60_000), // p1's wait starts here: ~52 minutes
    },
  });
  // p2..p5 have all only been waiting 5 minutes.
  for (const p of [p2, p3, p4, p5]) {
    await prisma.sessionRoster.update({
      where: { sessionId_playerId: { sessionId: sessionCode, playerId: p.id } },
      data: { activatedAt: new Date(now - 5 * 60_000) },
    });
  }

  try {
    const res = await request(server).post(`/sessions/${sessionCode}/courts/1/propose`).expect(201);
    expect(res.body.ok).toBe(true);
    const seated = new Set([...res.body.pairing.teamA, ...res.body.pairing.teamB]);
    // Games-first ordering would bench p1 (2 games, most of anyone).
    // Wait-only ordering (level mode) must play them instead: 52 minutes is
    // longer than everyone else's 5.
    expect(seated.has(p1.id)).toBe(true);
  } finally {
    await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
    await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
    await prisma.session.deleteMany({ where: { code: sessionCode } });
    await prisma.player.deleteMany({ where: { groupId: groupCode } });
    await prisma.group.deleteMany({ where: { code: groupCode } });
  }
});

it("gives a custom session's level court a carry game and its variety court games-then-wait", async () => {
  const groupCode = randomUUID();
  const sessionCode = randomUUID();
  await prisma.group.create({ data: { code: groupCode, name: 'G' } });
  // Creation order matters: BG must be strictly longest-waiting, and
  // OPP1/OPP2 must precede V1-V4 so a wait-tie's stable sort favours them
  // as the carry court's opponents (see the walkthrough in this task's
  // implementation notes).
  const players = await Promise.all(
    ['BG', 'PRO', 'OPP1', 'OPP2', 'V1', 'V2', 'V3', 'V4'].map((name) =>
      prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
    )
  );
  const [bg, pro, opp1, opp2, v1, v2, v3, v4] = players;
  const now = Date.now();
  await prisma.session.create({
    data: {
      code: sessionCode,
      groupId: groupCode,
      courtCount: 2,
      rawImportText: '',
      mode: 'custom',
      courtModes: JSON.stringify(['level', 'variety']),
      createdAt: new Date(now - 30 * 60_000),
    },
  });
  for (const p of players) {
    await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
  }
  // Everyone except bg joined a couple of minutes "late" so bg is
  // unambiguously the longest-waiting player in the whole active roster —
  // the pool a per-court propose draws from is the whole roster, not just
  // the players intended for that court.
  for (const p of [pro, opp1, opp2, v1, v2, v3, v4]) {
    await prisma.sessionRoster.update({
      where: { sessionId_playerId: { sessionId: sessionCode, playerId: p.id } },
      data: { activatedAt: new Date(now - 2 * 60_000) },
    });
  }
  await prisma.player.update({
    where: { id: bg.id },
    data: { level: 'BG', levelSetAt: new Date(now - 40 * 60_000) },
  });
  await prisma.player.update({ where: { id: pro.id }, data: { level: 'P+' } });
  await prisma.player.update({ where: { id: opp1.id }, data: { level: 'P' } });
  await prisma.player.update({ where: { id: opp2.id }, data: { level: 'P' } });

  try {
    const court1 = await request(server).post(`/sessions/${sessionCode}/courts/1/propose`).expect(201);
    expect(court1.body.ok).toBe(true);
    const teamWithBg =
      court1.body.pairing.teamA.includes(bg.id) ? court1.body.pairing.teamA : court1.body.pairing.teamB;
    const otherTeam =
      teamWithBg === court1.body.pairing.teamA ? court1.body.pairing.teamB : court1.body.pairing.teamA;
    expect(new Set(teamWithBg)).toEqual(new Set([bg.id, pro.id]));
    expect(new Set(otherTeam)).toEqual(new Set([opp1.id, opp2.id]));

    // Court 2 (variety) draws from whoever is left (v1-v4) and is
    // unaffected by level's rules.
    const court2 = await request(server).post(`/sessions/${sessionCode}/courts/2/propose`).expect(201);
    expect(court2.body.ok).toBe(true);
    const seatedOnCourt2 = new Set([...court2.body.pairing.teamA, ...court2.body.pairing.teamB]);
    expect(seatedOnCourt2).toEqual(new Set([v1.id, v2.id, v3.id, v4.id]));
  } finally {
    await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
    await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
    await prisma.session.deleteMany({ where: { code: sessionCode } });
    await prisma.player.deleteMany({ where: { groupId: groupCode } });
    await prisma.group.deleteMany({ where: { code: groupCode } });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/sessions/sessions.controller.spec.ts -t "queued by wait"`
Run: `cd server && npx vitest run src/sessions/sessions.controller.spec.ts -t "carry game and its variety"`
Expected: FAIL — today's `proposeExclusively` ignores wait-first ordering and per-court mode entirely.

- [ ] **Step 3: Implement**

In `server/src/sessions/sessions.service.ts`, add a private helper near `loadHistory` (after it, before `assertCourtNumber`):

```ts
/**
 * Carry-game inputs for a level-mode propose/fill — only ever needed when
 * at least one court being planned is effectively `level`. Cheap enough
 * (three small queries) to call unconditionally from those two call sites.
 */
private async loadCarryEligibility(
  session: { groupId: string; code: string }
): Promise<{ carryEligible: Set<string>; carriedTonight: Set<string> }> {
  const [roster, levels, levelSetAt, confirmed] = await Promise.all([
    this.prisma.sessionRoster.findMany({
      where: { sessionId: session.code, active: true },
      select: { playerId: true },
    }),
    loadPlayerLevels(this.prisma, session.groupId),
    loadLevelSetAt(this.prisma, session.groupId),
    this.prisma.pairing.findMany({
      where: { sessionId: session.code, confirmedAt: { not: null } },
      select: { teamA: true, teamB: true, confirmedAt: true },
    }),
  ]);

  return computeCarryEligibility({
    activeRosterIds: roster.map((r) => r.playerId),
    levels,
    levelSetAt,
    confirmedPairingsTonight: confirmed.map((p) => ({
      playerIds: this.playersOf(p),
      confirmedAt: p.confirmedAt!.getTime(),
    })),
  });
}
```

Add the imports at the top of `sessions.service.ts`:

```ts
import { loadLevelSetAt } from '../player-levels.js';
import { computeCarryEligibility } from './carry-eligibility.js';
import { effectiveCourtMode } from './session-mode.js';
```

Now replace the non-custom branch of `proposeExclusively` (everything from `const history = await this.loadHistory(...)` at `:658` through the end of the function, roughly `:658-736`) with:

```ts
    const requestedMode = effectiveCourtMode(session, courtNumber);
    const history = await this.loadHistory(session.groupId, sessionCode);

    const avoidSplit =
      existingPending && emptySeatCount(existingPending) === 0
        ? this.teamsOf(existingPending)
        : undefined;

    const ratings = requestedMode === 'balanced' ? await this.loadRatings(session.groupId) : undefined;
    const levels = await loadPlayerLevels(this.prisma, session.groupId);
    const queueBy: 'games' | 'wait' = requestedMode === 'level' ? 'wait' : 'games';
    const carry =
      requestedMode === 'level' ? await this.loadCarryEligibility(session) : undefined;

    // Co-plan only across idle courts sharing this court's effective mode —
    // a session-wide mode makes every court share it already (no behaviour
    // change there); a custom session's other-mode courts must not leak
    // into this mode's search.
    const idleCourtNumbers = Array.from({ length: session.courtCount ?? 1 }, (_, i) => i + 1).filter(
      (n) =>
        (n === courtNumber || !nonEnded.some((p) => p.courtNumber === n)) &&
        effectiveCourtMode(session, n) === requestedMode
    );
    const orderedCourtNumbers = [
      courtNumber,
      ...idleCourtNumbers.filter((n) => n !== courtNumber),
    ];
    const sizes: CourtSize[] = orderedCourtNumbers.map((n) =>
      courtSizeFor(formatAt(session.courtFormats, n))
    );

    const result = this.runGenerateRound(
      available,
      sizes,
      history,
      undefined,
      avoidSplit,
      ratings,
      levels,
      requestedMode === 'level',
      queueBy,
      carry?.carryEligible,
      carry?.carriedTonight
    );
    if (result.courts.length === 0) {
      return {
        ok: false as const,
        reason: 'not-enough-players' as const,
        available: available.length,
        format: formatAt(session.courtFormats, courtNumber),
      };
    }
    const [proposed] = result.courts;
    const teamA = JSON.stringify(proposed.teamA);
    const teamB = JSON.stringify(proposed.teamB);

    const pairing = await this.upsertPendingPairing(sessionCode, courtNumber, existingPending, teamA, teamB);

    return {
      ok: true as const,
      pairing: {
        id: pairing.id,
        courtNumber: pairing.courtNumber,
        matchNumber: pairing.matchNumber,
```

(The final `return` block's remaining lines — `revision`, `teamA`, `teamB` — are unchanged; only the code above the final `return` inside this branch changes. `this.loadRatings` is whatever the existing `ratingsForMode` private method calls internally for balanced mode — check `ratingsForMode`'s body at `:1507-1509` and reuse the same call it makes (`this.loadRatings(session.groupId)` per that method's existing implementation) rather than calling `ratingsForMode(session)` itself, since that method reads `session.mode` directly and this call site now needs the *court's* effective mode instead.)

In `getSession` (`:396-500`), thread `mode` per court and a top-level `queueBy`:

```ts
    const courtModes = parseCourtModes(session.courtModes);
    const courts = Array.from({ length: courtCount }, (_, i) => {
      const courtNumber = i + 1;
      const format = courtFormats[courtNumber - 1] ?? 'doubles';
      const mode = effectiveCourtMode(session, courtNumber);
      const current = session.pairings
        .filter((p) => p.courtNumber === courtNumber && p.endedAt === null)
        .sort((a, b) => b.matchNumber - a.matchNumber)[0];

      if (!current) return { courtNumber, status: 'idle' as const, format, mode };

      const { teamA, teamB } = this.seatsOf(current);
      return current.confirmedAt
        ? {
            courtNumber,
            status: 'active' as const,
            pairingId: current.id,
            revision: current.revision,
            format,
            mode,
            teamA,
            teamB,
            startedAt: current.confirmedAt.toISOString(),
          }
        : {
            courtNumber,
            status: 'pending' as const,
            pairingId: current.id,
            revision: current.revision,
            format,
            mode,
            teamA,
            teamB,
            autoStartAt: this.autoStartAtFor(current, session.roster),
          };
    });
```

Add `parseCourtModes` to the existing `court-formats.js`-adjacent import block (already importing `parseCourtFormats` — add `parseCourtModes` from `./court-modes.js` next to it), and add `queueBy` to the returned object next to `mode` (around `:454`):

```ts
      mode: session.mode,
      queueBy: isLevelMode(session.mode) ? ('wait' as const) : ('games' as const),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/sessions/sessions.controller.spec.ts`
Expected: PASS — the two new tests from Step 1, plus every pre-existing propose/format/level test unaffected (variety and balanced sessions compute `requestedMode` equal to `session.mode` for every court, so `idleCourtNumbers`'s new filter is a no-op for them).

- [ ] **Step 5: Run the full server suite**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/sessions/sessions.service.ts server/src/sessions/sessions.controller.spec.ts
git commit -m "feat(server): wire per-court mode and carry eligibility into propose + getSession"
```

---

### Task 11: Wire per-court mode into `fillIdleCourts`

**Files:**
- Modify: `server/src/sessions/sessions.service.ts` — `fillIdleCourts`'s custom-session path (`:1792-1883`)
- Test: `server/src/sessions/sessions.controller.spec.ts`

**Interfaces:**
- Consumes: same as Task 10 (`effectiveCourtMode`, `loadCarryEligibility`, `queueBy`).

- [ ] **Step 1: Write the failing test**

Add to `server/src/sessions/sessions.controller.spec.ts`, near the existing `courts/fill` custom-mode tests:

```ts
it("fills a custom session's idle courts grouped by each court's own mode", async () => {
  const groupCode = randomUUID();
  const sessionCode = randomUUID();
  await prisma.group.create({ data: { code: groupCode, name: 'G' } });
  const players = await Promise.all(
    ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((name) =>
      prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
    )
  );
  await prisma.session.create({
    data: {
      code: sessionCode,
      groupId: groupCode,
      courtCount: 2,
      rawImportText: '',
      mode: 'custom',
      courtModes: JSON.stringify(['level', 'custom']),
    },
  });
  for (const p of players) {
    await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
  }

  try {
    const res = await request(server).post(`/sessions/${sessionCode}/courts/fill`).expect(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.filled.sort()).toEqual([1, 2]);

    const rows = await prisma.pairing.findMany({ where: { sessionId: sessionCode } });
    const court1 = rows.find((r) => r.courtNumber === 1)!;
    const court2 = rows.find((r) => r.courtNumber === 2)!;
    // Court 1 (level): a real engine-picked pairing, no empty seats.
    expect(JSON.parse(court1.teamA)).not.toContain(null);
    expect(JSON.parse(court1.teamB)).not.toContain(null);
    const seatedOnCourt1 = new Set([...JSON.parse(court1.teamA), ...JSON.parse(court1.teamB)]);
    expect(seatedOnCourt1.size).toBe(4);
    // Court 2 (custom): still an empty draft.
    expect(JSON.parse(court2.teamA)).toEqual([null, null]);
    expect(JSON.parse(court2.teamB)).toEqual([null, null]);
  } finally {
    await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
    await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
    await prisma.session.deleteMany({ where: { code: sessionCode } });
    await prisma.player.deleteMany({ where: { groupId: groupCode } });
    await prisma.group.deleteMany({ where: { code: groupCode } });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/sessions/sessions.controller.spec.ts -t "grouped by each court"`
Expected: FAIL — today every idle court in a custom session gets an empty draft, full stop.

- [ ] **Step 3: Implement**

Replace the custom-session branch of `fillIdleCourts` (`:1792-1820`) with:

```ts
    if (isCustomMode(session.mode)) {
      if (idleCourts.length === 0) {
        return { ok: false as const, reason: 'not-enough-players' as const, filled: [] as number[] };
      }

      const customCourts = idleCourts.filter((n) => effectiveCourtMode(session, n) === 'custom');
      const engineCourts = idleCourts.filter((n) => effectiveCourtMode(session, n) !== 'custom');
      // Group the non-custom idle courts by their own mode, processed in
      // order of each group's lowest court number, so filling is
      // deterministic and every court still only ever runs its own mode's
      // objective in one generateRound call.
      const modeGroups = new Map<SessionMode, number[]>();
      for (const n of engineCourts) {
        const mode = effectiveCourtMode(session, n);
        const group = modeGroups.get(mode) ?? [];
        group.push(n);
        modeGroups.set(mode, group);
      }
      const orderedGroups = [...modeGroups.entries()].sort(
        (a, b) => Math.min(...a[1]) - Math.min(...b[1])
      );

      const filled: number[] = [];
      let reservedForCustom = new Set<string>(reserved);

      await this.prisma.$transaction(async (tx) => {
        for (const courtNumber of customCourts) {
          const size = courtSizeFor(formatAt(session.courtFormats, courtNumber));
          const emptyTeam = JSON.stringify(Array(size / 2).fill(null));
          const matchNumber =
            (await tx.pairing.count({
              where: { sessionId: sessionCode, courtNumber, confirmedAt: { not: null } },
            })) + 1;
          await tx.pairing.create({
            data: {
              sessionId: sessionCode,
              courtNumber,
              matchNumber,
              teamA: emptyTeam,
              teamB: emptyTeam,
              pendingSince: new Date(),
            },
          });
          filled.push(courtNumber);
        }
      });

      let remainingRoster = roster.map((r) => r.playerId).filter((id) => !reservedForCustom.has(id));

      for (const [mode, courtsInGroup] of orderedGroups) {
        const sizes = courtsInGroup.map((n) => courtSizeFor(formatAt(session.courtFormats, n)));
        const history = await this.loadHistory(session.groupId, sessionCode);
        const ratings = mode === 'balanced' ? await this.loadRatings(session.groupId) : undefined;
        const levels = await loadPlayerLevels(this.prisma, session.groupId);
        const queueBy: 'games' | 'wait' = mode === 'level' ? 'wait' : 'games';
        const carry = mode === 'level' ? await this.loadCarryEligibility(session) : undefined;

        const result = this.runGenerateRound(
          remainingRoster,
          sizes,
          history,
          undefined,
          undefined,
          ratings,
          levels,
          mode === 'level',
          queueBy,
          carry?.carryEligible,
          carry?.carriedTonight
        );

        await this.prisma.$transaction(async (tx) => {
          for (const assignment of result.courts) {
            const courtNumber = courtsInGroup[assignment.court - 1];
            const matchNumber =
              (await tx.pairing.count({
                where: { sessionId: sessionCode, courtNumber, confirmedAt: { not: null } },
              })) + 1;
            await tx.pairing.create({
              data: {
                sessionId: sessionCode,
                courtNumber,
                matchNumber,
                teamA: JSON.stringify(assignment.teamA),
                teamB: JSON.stringify(assignment.teamB),
                pendingSince: new Date(),
              },
            });
            filled.push(courtNumber);
          }
        });

        const justSeated = new Set(result.courts.flatMap((c) => [...c.teamA, ...c.teamB]));
        remainingRoster = remainingRoster.filter((id) => !justSeated.has(id));
      }

      return { ok: true as const, filled };
    }
```

(`SessionMode` needs importing from `./session-mode.js` if not already imported in this file's top-level import block.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/sessions/sessions.controller.spec.ts -t "grouped by each court"`
Expected: PASS.

- [ ] **Step 5: Run the full server suite**

Run: `cd server && npm test`
Expected: PASS — every pre-existing custom-mode fill test still gets all-empty drafts (every court defaults to `'custom'` with no `courtModes` set), so `customCourts` equals the full idle set and `engineCourts` is empty, reproducing today's behaviour exactly.

- [ ] **Step 6: Commit**

```bash
git add server/src/sessions/sessions.service.ts server/src/sessions/sessions.controller.spec.ts
git commit -m "feat(server): wire per-court mode into fillIdleCourts"
```

---

### Task 12: Wire per-court mode into tap-swap (`swapPlayerExclusively`)

**Files:**
- Modify: `server/src/sessions/sessions.service.ts` (`:1083-1122`, inside `swapPlayerExclusively`)
- Test: `server/src/sessions/sessions.controller.spec.ts`

**Interfaces:**
- Consumes: `effectiveCourtMode(session, pairing.courtNumber)`.

- [ ] **Step 1: Write the failing test**

Add to `server/src/sessions/sessions.controller.spec.ts`, near the existing swap/substitute tests:

```ts
it('auto-picks a substitute by wait alone on a level-mode court', async () => {
  const groupCode = randomUUID();
  const sessionCode = randomUUID();
  await prisma.group.create({ data: { code: groupCode, name: 'G' } });
  const players = await Promise.all(
    ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((name) =>
      prisma.player.create({ data: { groupId: groupCode, name, aliases: '[]' } })
    )
  );
  const [a, b, c, d, e, f, g, h] = players;
  const now = Date.now();
  await prisma.session.create({
    data: {
      code: sessionCode,
      groupId: groupCode,
      courtCount: 2,
      rawImportText: '',
      mode: 'level',
      createdAt: new Date(now - 60 * 60_000),
    },
  });
  for (const p of [a, b, c, d, e, f]) {
    await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
  }
  // f was rested and just brought back: short wait, 0 games.
  await prisma.sessionRoster.update({
    where: { sessionId_playerId: { sessionId: sessionCode, playerId: f.id } },
    data: { activatedAt: new Date(now - 60_000) },
  });
  // e already played one game on court 2, finished long ago: 1 game, but a
  // far longer wait than f.
  await prisma.pairing.create({
    data: {
      sessionId: sessionCode,
      courtNumber: 2,
      matchNumber: 1,
      teamA: JSON.stringify([e.id, g.id]),
      teamB: JSON.stringify([h.id, b.id]),
      confirmedAt: new Date(now - 55 * 60_000),
      endedAt: new Date(now - 50 * 60_000),
    },
  });
  const pairing = await prisma.pairing.create({
    data: {
      sessionId: sessionCode,
      courtNumber: 1,
      matchNumber: 1,
      teamA: JSON.stringify([a.id, c.id]),
      teamB: JSON.stringify([d.id, b.id]),
    },
  });

  try {
    const res = await request(server)
      .post(`/sessions/${sessionCode}/pairings/${pairing.id}/swap`)
      .send({ playerId: a.id })
      .expect(201);
    expect(res.body.ok).toBe(true);
    // Games-first ordering would pick f (0 games). Wait-only ordering
    // (level mode) picks e instead: ~50 minutes beats f's ~1 minute.
    expect(res.body.pairing.teamA).toEqual([e.id, c.id]);
  } finally {
    await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
    await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
    await prisma.session.deleteMany({ where: { code: sessionCode } });
    await prisma.player.deleteMany({ where: { groupId: groupCode } });
    await prisma.group.deleteMany({ where: { code: groupCode } });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/sessions/sessions.controller.spec.ts -t "auto-picks a substitute by wait"`
Expected: FAIL — today's sort is always games-then-wait.

- [ ] **Step 3: Implement**

In `swapPlayerExclusively`, replace the `ratings`/`levels` loading and the sort's first two comparators:

```ts
    const session = await this.prisma.session.findUniqueOrThrow({
      where: { code: pairing.sessionId },
    });
    if (session.endedAt !== null) throw this.conflict('SESSION_ENDED');
    const courtMode = effectiveCourtMode(session, pairing.courtNumber);
    const history = await this.loadHistory(session.groupId, pairing.sessionId);
    const ratings = courtMode === 'balanced' ? await this.loadRatings(session.groupId) : undefined;
    const levels = await loadPlayerLevels(this.prisma, session.groupId);
```

And the sort (originally `:1112-1122`):

```ts
      .sort(
        (one, other) =>
          (courtMode === 'level'
            ? (one.waitingSince ?? 0) - (other.waitingSince ?? 0)
            : one.games - other.games || one.waitingSince - other.waitingSince) ||
          compareArrangements(
            [one.assignment],
            [other.assignment],
            history.partnerCounts,
            history.opponentCounts,
            ratings,
            { partner: 0, opponent: 0 },
            history.recentGroupKeys ?? null,
            courtMode === 'level' ? levels : undefined
          )
      );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/sessions/sessions.controller.spec.ts -t "auto-picks a substitute by wait"`
Expected: PASS.

- [ ] **Step 5: Run the full server suite**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/sessions/sessions.service.ts server/src/sessions/sessions.controller.spec.ts
git commit -m "feat(server): auto-pick substitute by court's own effective mode"
```

---

### Task 13: Web data model + service (`live-session.model.ts`, `session.model.ts`, `live-session.service.ts`)

**Files:**
- Modify: `web/src/app/core/live-session.model.ts`, `web/src/app/core/session.model.ts`, `web/src/app/core/live-session.service.ts`
- Test: none new (pure type/plumbing change; covered indirectly by Task 14/15's specs)

**Interfaces:**
- Produces: `CourtState` gains `mode: SessionMode` on every variant; `Session` gains `queueBy: 'games' | 'wait'`; `LiveSessionService.setCourtMode(courtNumber, mode): Promise<ActionResult>`.

- [ ] **Step 1: Update `CourtState`**

In `web/src/app/core/live-session.model.ts`, add a `SessionMode` type (or import it if a shared one already exists — check `session.model.ts`'s `mode` field type first and reuse that literal union rather than redeclaring it) and thread `mode` through every variant:

```ts
export type CourtFormat = 'doubles' | 'singles';
export type CourtMode = 'variety' | 'balanced' | 'level' | 'custom';

export type Seat = string | null;

export type CourtState =
  | { status: 'idle'; format: CourtFormat; mode: CourtMode }
  | {
      status: 'pending';
      pairingId: string;
      format: CourtFormat;
      mode: CourtMode;
      teamA: Seat[];
      teamB: Seat[];
      autoStartAt: string | null;
    }
  | {
      status: 'active';
      pairingId: string;
      format: CourtFormat;
      mode: CourtMode;
      teamA: string[];
      teamB: string[];
      startedAt: string;
    };
```

- [ ] **Step 2: Update `Session`**

In `web/src/app/core/session.model.ts`, add next to `mode`:

```ts
  /** 'wait' in a level session, 'games' otherwise — how the waiting list
   *  should be ordered to match what the engine actually does. */
  queueBy: 'games' | 'wait';
```

- [ ] **Step 3: Add `setCourtMode` to `LiveSessionService`**

In `web/src/app/core/live-session.service.ts`, add next to `setCourtFormat`:

```ts
  /** Allowed in any court state — a court's mode only ever changes what the
   *  next propose/reshuffle does. */
  setCourtMode(courtNumber: number, mode: CourtMode): Promise<ActionResult> {
    return this.post(
      `courts/${courtNumber}/mode`,
      { mode },
      $localize`:@@err.courtMode:เปลี่ยนโหมดคอร์ทไม่สำเร็จ`
    );
  }
```

Import `CourtMode` next to the existing `CourtFormat`/`CourtState` import at the top of the file.

- [ ] **Step 4: Verify the web build type-checks**

Run: `cd web && npx tsc --noEmit -p tsconfig.app.json`
Expected: PASS with no new type errors (every existing `CourtState` consumer either ignores the new `mode` field or needs the Task 15 update — check for compile errors and fix any that surface before moving on, since a strict template binding to a specific `CourtState` variant may need `mode` added at the literal construction sites this task touches, e.g. the fallback default in `court-panel.ts:99`: `{ status: 'idle', format: 'doubles' }` needs `, mode: 'custom'` appended).

- [ ] **Step 5: Commit**

```bash
git add web/src/app/core/live-session.model.ts web/src/app/core/session.model.ts web/src/app/core/live-session.service.ts web/src/app/pages/session-dashboard/court-panel/court-panel.ts
git commit -m "feat(web): add per-court mode to the live session model"
```

---

### Task 14: Waiting list `queueBy` (`waiting-time.ts`, `session-dashboard.ts`)

**Files:**
- Modify: `web/src/app/core/waiting-time.ts`
- Modify: `web/src/app/pages/session-dashboard/session-dashboard.ts` (`waiting` computed, `:255-267`)
- Test: `web/src/app/core/waiting-time.spec.ts` (create if it does not exist — check first)

**Interfaces:**
- Produces: `buildWaitingList(playerIds, names, lastPlayedAt, sessionCreatedAt, now?, activatedAt?, queueGames?, queueBy?: 'games' | 'wait')`.

- [ ] **Step 1: Write the failing test**

Check whether `web/src/app/core/waiting-time.spec.ts` already exists (`ls web/src/app/core/waiting-time.spec.ts`). If it does, add to it; otherwise create it:

```ts
import { describe, expect, it } from 'vitest';
import { buildWaitingList } from './waiting-time';

describe('buildWaitingList with queueBy "wait"', () => {
  it('ignores queueGames entirely, ordering by wait alone', () => {
    const now = 100_000;
    const sessionCreatedAt = new Date(0).toISOString();
    const lastPlayedAt = {};
    const result = buildWaitingList(
      ['a', 'b'],
      ['A', 'B'],
      lastPlayedAt,
      sessionCreatedAt,
      now,
      {},
      { a: 5, b: 0 }, // 'a' has far more games...
      'wait'
    );
    // ...but both started waiting at session start (tie), so with games
    // ignored the order falls back to array order, not games order.
    expect(result.map((r) => r.id)).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/app/core/waiting-time.spec.ts`
Expected: FAIL — `buildWaitingList` has no 8th parameter today, so passing `'wait'` is a no-op and the existing games-first sort would put `'a'` last if it changed anything observable; more concretely, expect a TypeScript error until the signature is extended.

- [ ] **Step 3: Implement**

In `web/src/app/core/waiting-time.ts`, change `buildWaitingList`'s signature and sort:

```ts
export function buildWaitingList(
  playerIds: string[],
  names: string[],
  lastPlayedAt: Record<string, string>,
  sessionCreatedAt: string,
  now: number = Date.now(),
  activatedAt: Record<string, string> = {},
  queueGames: Record<string, number> = {},
  /** 'wait' (level sessions) ignores queueGames entirely; 'games' (default)
   *  keeps the existing games-then-wait order. */
  queueBy: 'games' | 'wait' = 'games'
): WaitingEntry[] {
  return playerIds
    .map((id, i) => ({
      id,
      name: names[i],
      minutes: minutesWaiting(id, lastPlayedAt, sessionCreatedAt, now, activatedAt),
    }))
    .sort((a, b) => {
      if (queueBy === 'games') {
        const byGames = (queueGames[a.id] ?? 0) - (queueGames[b.id] ?? 0);
        if (byGames !== 0) return byGames;
      }
      return b.minutes - a.minutes;
    });
}
```

In `web/src/app/pages/session-dashboard/session-dashboard.ts`, update the `waiting` computed (`:255-267`) to pass the session's `queueBy`:

```ts
  readonly waiting = computed(() => {
    const session = this.session();
    if (!session) return [];
    const ids = this.liveSession.waitingPlayerIds();
    return buildWaitingList(
      ids,
      resolvePlayerNames(ids, this.players()),
      session.lastPlayedAt,
      session.createdAt,
      session.endedAt ? new Date(session.endedAt).getTime() : this.now(),
      session.activatedAt,
      session.queueGames,
      session.queueBy
    );
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/app/core/waiting-time.spec.ts`
Expected: PASS.

- [ ] **Step 5: Run the full web test suite**

Run: `cd web && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/app/core/waiting-time.ts web/src/app/core/waiting-time.spec.ts web/src/app/pages/session-dashboard/session-dashboard.ts
git commit -m "feat(web): order the waiting list by wait alone in level sessions"
```

---

### Task 15: Per-court mode toggle UI (`court-panel`)

**Files:**
- Modify: `web/src/app/pages/session-dashboard/court-panel/court-panel.ts`
- Modify: `web/src/app/pages/session-dashboard/court-panel/court-panel.html`
- Test: `web/src/app/pages/session-dashboard/court-panel/court-panel.spec.ts`

**Interfaces:**
- Consumes: `LiveSessionService.setCourtMode` (Task 13), `this.isCustom` (already exists at `:102`).

- [ ] **Step 1: Write the failing test**

Add to `court-panel.spec.ts`, following that file's existing pattern for the format toggle (search it for `formatToggleDisabled`/`setFormat` tests and mirror the setup):

```ts
it('shows the per-court mode toggle only in a custom session', () => {
  // Render with liveSession.mode() === 'custom': the toggle (สลับคู่/สูสี/ระดับ/เลือกเอง)
  // is present. Render with liveSession.mode() === 'level': the toggle is absent.
});

it('calls setCourtMode when a mode segment is tapped', () => {
  // Tap 'ระดับ' on an idle court in a custom session; assert
  // liveSession.setCourtMode was called with (courtNumber(), 'level').
});
```

Write these using whatever test-harness pattern (`TestBed`, a fake `LiveSessionService`, etc.) the file's existing format-toggle tests already use — copy that setup exactly.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/app/pages/session-dashboard/court-panel/court-panel.spec.ts -t "per-court mode"`
Expected: FAIL — no such toggle exists yet.

- [ ] **Step 3: Implement**

In `court-panel.ts`, add next to `formatToggleDisabled`/`setFormat`:

```ts
  /** The 4-segment mode toggle only ever shows in a custom session — see
   *  effectiveCourtMode server-side. Unlike the format toggle, settable in
   *  any court state. */
  protected readonly modeGroupLabel = $localize`:@@court.modeLabel:โหมดคอร์ทนี้`;

  protected readonly courtModes: readonly CourtMode[] = ['variety', 'balanced', 'level', 'custom'];

  protected async setCourtMode(mode: CourtMode): Promise<void> {
    if (this.busy() || this.ended() || this.court().mode === mode) return;
    this.busy.set(true);
    this.actionError.set(null);
    try {
      const result = await this.liveSession.setCourtMode(this.courtNumber(), mode);
      this.actionError.set(result.error ?? null);
    } finally {
      this.busy.set(false);
    }
  }
```

Add `CourtMode` to the existing `live-session.model` import.

In `court-panel.html`, add below the existing format toggle block (after its closing `</div>` around line 23):

```html
    @if (isCustom()) {
      <div class="scope-toggle court-mode-toggle" role="group" [attr.aria-label]="modeGroupLabel">
        @for (m of courtModes; track m) {
          <button
            type="button"
            [class.active]="c.mode === m"
            [disabled]="busy() || ended()"
            [attr.aria-pressed]="c.mode === m"
            (click)="setCourtMode(m)"
          >{{
            m === 'variety' ? modeLabelVariety
              : m === 'balanced' ? modeLabelBalanced
              : m === 'level' ? modeLabelLevel
              : modeLabelCustom
          }}</button>
        }
      </div>
    }
```

Add the four label constants next to `modeGroupLabel` in `court-panel.ts` (reusing the same Thai text the session-level toggle already uses, per `session-dashboard.html:161-186`):

```ts
  protected readonly modeLabelVariety = $localize`:@@court.modeVariety:สลับคู่`;
  protected readonly modeLabelBalanced = $localize`:@@court.modeBalanced:สูสี`;
  protected readonly modeLabelLevel = $localize`:@@court.modeLevel:ระดับ`;
  protected readonly modeLabelCustom = $localize`:@@court.modeCustom:เลือกเอง`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/app/pages/session-dashboard/court-panel/court-panel.spec.ts`
Expected: PASS.

- [ ] **Step 5: Run the full web test suite**

Run: `cd web && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/app/pages/session-dashboard/court-panel/court-panel.ts web/src/app/pages/session-dashboard/court-panel/court-panel.html web/src/app/pages/session-dashboard/court-panel/court-panel.spec.ts
git commit -m "feat(web): add per-court mode toggle, custom sessions only"
```

---

### Task 16: Level-mode hint (carry) + custom-mode ระดับ hint

**Files:**
- Modify: `web/src/app/pages/session-dashboard/session-dashboard.html` (`:188-199` level-mode hint block; waiting-list section)
- Modify: `web/src/app/pages/session-dashboard/session-dashboard.ts` (a computed for "any court is ระดับ")
- Test: `web/src/app/pages/session-dashboard/session-dashboard.spec.ts`

**Interfaces:**
- Consumes: `this.liveSession.courts()` (already exists).

- [ ] **Step 1: Write the failing test**

Add to `session-dashboard.spec.ts`, mirroring its existing level-mode-hint test (search for `modeLevelHint` to find it):

```ts
it('shows a hint under the waiting list when any court is set to ระดับ in a custom session', () => {
  // Session mode 'custom', one court's effective mode 'level'. Assert the
  // hint text is present. With no court set to 'level', assert it is absent.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/app/pages/session-dashboard/session-dashboard.spec.ts -t "any court is set to"`
Expected: FAIL — no such hint exists.

- [ ] **Step 3: Implement**

In `session-dashboard.ts`, add a computed near `mode`:

```ts
  /** Custom session only: true when at least one court is set to ระดับ, so
   *  the shared waiting list (which stays games-then-wait in a custom
   *  session — see waiting-time.ts) can warn that a level court may pick
   *  out of that order. */
  readonly anyCourtIsLevel = computed(() =>
    this.liveSession.courts().some((c) => c.mode === 'level')
  );
```

In `session-dashboard.html`, near the waiting list (find the section rendering `waiting()`), add:

```html
@if (mode() === 'custom' && anyCourtIsLevel()) {
  <p class="mode-hint" i18n="@@dashboard.customLevelCourtHint">
    คอร์ทที่ตั้งเป็นตามระดับอาจเรียกคิวข้ามลำดับที่เห็นด้านบน
  </p>
}
```

And in the existing level-mode hint block (`:194-198`), append the carry-game line:

```html
            @case ('level') {
              <p class="mode-hint" i18n="@@dashboard.modeLevelHint">
                จัดคนระดับใกล้กัน (±1) ลงคอร์ทเดียวกัน คิวอาจข้ามเพื่อให้จัดได้
              </p>
              <p class="mode-hint" i18n="@@dashboard.modeLevelCarryHint">
                มือใหม่ที่ระดับห่างจากกลุ่ม จะได้เล่นคู่กับมือโปร 1 เกมก่อน
              </p>
            }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/app/pages/session-dashboard/session-dashboard.spec.ts -t "any court is set to"`
Expected: PASS.

- [ ] **Step 5: Run the full web test suite**

Run: `cd web && npm test`
Expected: PASS.

- [ ] **Step 6: Regenerate and translate i18n**

Run: `cd web && npx ng extract-i18n --output-path src/locale`

This updates `src/locale/messages.xlf` (the Thai source) with the new `@@court.modeLabel`, `@@court.modeVariety`, `@@court.modeBalanced`, `@@court.modeLevel`, `@@court.modeCustom`, `@@err.courtMode`, `@@dashboard.customLevelCourtHint`, and `@@dashboard.modeLevelCarryHint` trans-units (and updates every changed `linenumber` context for entries this plan's earlier tasks touched).

Then hand-add an English `<target>` for each of those new ids in `web/src/locale/messages.en.xlf`, following the file's existing `<source>...</source><target>...</target>` pattern (see `dashboard.modeVariety` → "Variety" as the model to match register and brevity):

- `court.modeLabel` → "Court mode"
- `court.modeVariety` → "Variety"
- `court.modeBalanced` → "Balanced"
- `court.modeLevel` → "Level"
- `court.modeCustom` → "Manual"
- `err.courtMode` → "Couldn't change the court's mode"
- `dashboard.customLevelCourtHint` → "A court set to level may call out of the order shown above"
- `dashboard.modeLevelCarryHint` → "A newcomer far below the group plays their first game with a strong partner first"

- [ ] **Step 7: Verify the web build still succeeds with the updated translations**

Run: `cd web && npm run build`
Expected: PASS, no missing-translation errors.

- [ ] **Step 8: Commit**

```bash
git add web/src/app/pages/session-dashboard/session-dashboard.ts web/src/app/pages/session-dashboard/session-dashboard.html web/src/app/pages/session-dashboard/session-dashboard.spec.ts web/src/locale/messages.xlf web/src/locale/messages.en.xlf
git commit -m "feat(web): carry-game hint and custom-mode ระดับ queue hint"
```

---

### Task 17: Docs

**Files:**
- Modify: `docs/overview.md`
- Modify: `CLAUDE.md`
- Modify: `docs/2026-09-21-feature-review-and-roadmap.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Update `docs/overview.md`**

In the "Pairing" section (`:276-289`, the "Three pairing modes" paragraph), append after the existing level-mode sentence:

```markdown
**Level mode queues by wait time, not games played** (2026-09-27 real-host
feedback) — real hosts run this mode exclusively and only care who has
waited longest, not how many games anyone has had. A far-below player (no
other active tagged player within ±1, and fewer than 4 active players share
their band) gets one **carry game** the first time their turn comes after
being tagged: forced to partner the highest-level player still waiting
(who may jump the queue for it) against the two longest-waiting players
within ±1 of that partner's level. The pairing is locked before the normal
search runs, so it can never be split apart by a swap; everyone else is
seated by the unmodified search. Reshuffling a pending carry court keeps the
same newcomer and partner and tries new opponents first, a new partner only
if no other opponents exist. See `engines/pairing.ts`'s `buildCarryCourt`
and `docs/archive/specs/2026-09-27-level-rework-design.md`.
```

In the custom-mode paragraph (`:280-289`), append:

```markdown
**In a custom session, each court has its own sticky mode** (สลับคู่ / สูสี /
ระดับ / เลือกเอง), not just one session-wide choice — `Session.courtModes`,
read via `effectiveCourtMode`. A court left เลือกเอง behaves exactly as
before. A court set to a non-custom mode is planned and filled using that
mode's own queue rule and objective, co-planned only with other idle courts
sharing the same effective mode. The shared waiting list stays games-then-
wait in a custom session regardless, with a hint shown when any court is set
to ระดับ, since that court alone may call out of the order shown.
```

- [ ] **Step 2: Update `CLAUDE.md`**

In the "Engines: rules that aren't obvious from the code" bullet list, add:

```markdown
- **Games-played rotation applies to สลับคู่/สูสี only.** ระดับ (level) courts
  — including a per-court ระดับ inside a เลือกเอง session — queue by wait time
  alone; games played is ignored. See `docs/overview.md`'s Pairing section.
```

- [ ] **Step 3: Update the roadmap doc**

In `docs/2026-09-21-feature-review-and-roadmap.md`, add a new dated entry (following the doc's existing checklist convention — copy the format of a recent `- [ ]`/`- [x]` entry) recording:

```markdown
#### - [x] B. Level-mode rework: wait-only queue + carry game (2026-09-27 real-host feedback)

Real host feedback, 2026-09-27: groups running level mode only care who has
waited longest, and want a newcomer far below the group's level to get one
"carry" game with a strong partner before playing normal level-clustered
games. Design: `docs/archive/specs/2026-09-27-level-rework-design.md`.
Done: `feat/level-rework`.

#### - [ ] A. Court labels — rename court numbers to match the physical hall

2026-09-27 real-host feedback. Not yet designed.

#### - [ ] C. Pair rules — couple/partner, never-teammates, never-same-court

2026-09-27 real-host feedback. Revives the deferred C5 (fixed pairs). Depends
on B (this plan). Not yet designed.

#### - [ ] D. Shuttlecock tracking per court per game

2026-09-27 real-host feedback. Depends on A. Not yet designed.

#### - [ ] E. Mid-session checkout for an early leaver (per-shuttle billing)

2026-09-27 real-host feedback. Depends on D. Not yet designed.
```

- [ ] **Step 4: Commit**

```bash
git add docs/overview.md CLAUDE.md docs/2026-09-21-feature-review-and-roadmap.md
git commit -m "docs: record level-mode rework + log A/C/D/E from 2026-09-27 real-host feedback"
```

---

## Final Verification

- [ ] `npm run test:engines` — PASS (Tasks 1-3)
- [ ] `cd server && npm test` — PASS (Tasks 4-12)
- [ ] `cd web && npm test` — PASS (Tasks 13-16)
- [ ] `cd web && npm run build` — PASS, no i18n errors (Task 16)
- [ ] Manual smoke test (`server: npm run start:dev`, `web: npm start`):
  1. Create a level-mode session with a P-heavy roster plus one untagged newcomer. Confirm a normal-band round proposes fine.
  2. Tag the newcomer BG mid-session. Propose their next court: confirm they're forced to partner the highest-tagged player, against two players near that partner's level.
  3. Reshuffle that pending court: confirm the newcomer and their partner stay, opponents change (or, if no alternate exists, the partner changes).
  4. Confirm the carry game. Propose the newcomer's next court: confirm it's a normal (possibly harder) level-clustered game, not another carry.
  5. Switch a session to เลือกเอง. Set court 1 to ระดับ, court 2 to เลือกเอง, court 3 to สลับคู่ (courtCount permitting). Propose each; confirm court 1 uses wait-first level pairing, court 3 uses games-first variety pairing, court 2 proposes empty seats.
  6. Fill-all on that same custom session; confirm court 1 and 3 get engine-picked pairings and court 2 gets an empty draft.
  7. Confirm the waiting list sorts by wait alone in a pure level session, and shows the new hint under a custom session with a ระดับ court.
