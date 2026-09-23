# C3 Per-Person Bill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Host opens "คิดเงิน" from the session summary, picks one of three charging models, and copies a per-person bill (with walk-in surcharge redistributed to the group) as Thai text for LINE.

**Architecture:** All money math is a pure engine (`engines/bill.ts`, integer satang, fails loudly on bad input). The server stores only *inputs* (`Session.billConfig` JSON, `SessionRoster.walkIn`), recomputes the bill on every read, and prefills config from the group's previous session. The web page is a thin editor: every committed change POSTs the full config and renders the recomputed bill the server sends back.

**Tech Stack:** TypeScript engines (node:test), NestJS + Prisma + SQLite (vitest + supertest), Angular standalone + signals (vitest/jsdom, HttpTestingController), `$localize` XLIFF i18n.

**Spec:** `docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md` §C3 (incl. D7 walk-in amendment). Read `docs/overview.md` before touching engines.

## Context

C3 is the next P0 roadmap item (`docs/2026-09-21-feature-review-and-roadmap.md`). Every host splits court + shuttle cost after every session by hand; the session already stores shuttle count/price. Owner added D7 on 2026-09-24: walk-ins pay a flat surcharge (default 20฿) that is handed back as an equal discount to every billed player, so the total is unchanged. LINE copy text is **always Thai** (owner, 2026-09-24).

## Deliberate deviations from the spec (update the spec in Task 9)

- Mutations are `POST` (`/bill-config`, `/roster/:playerId/walk-in`), not PUT/PATCH — every sessions route mutates via POST (`sessions.controller.ts`, e.g. `:code/roster/:playerId/active`).
- `computeBill` takes one `BillInput` object instead of six positional args.
- `overrides` is `{ playerId, amountSatang }[]`, not a record — class-validator can validate an array of DTOs, not record values.
- Dashboard walk-in badge is **cut**: `GET /sessions/:code` is `@Public` and feeds the venue display; walk-in status is billing data and stays on the host-only bill page.
- Prefill from the previous session's `billConfig` (the C3 slice of C10) ships here; C10 itself (venue/courts/price prefill at session creation) stays open.

## Global Constraints

- Money is integer satang everywhere (1 THB = 100 satang). No floats in math. Max value `2147483647` (same as `SetShuttleDetailsDto`).
- Engines: no framework, no npm deps, imports end in `.ts`; server imports engines as `'../../../engines/bill.ts'` (from `src/sessions/`) or `'../../../../engines/bill.ts'` (from `src/sessions/dto/`).
- Engines throw on bad input (negative/fractional money, duplicate ids, unknown model) — never cope silently.
- Bill routes are owner-only (default global `AuthGuard` + `OwnershipGuard`; **no** `@Public()`). Non-owner gets 404, not 403. `auth.boundary.spec.ts` auto-walks new routes — do not add them to `PUBLIC_ROUTES`.
- Bill config and walk-in mark are editable **after** the session ends (billing happens then), unlike every other mutation except shuttle details.
- LINE copy text is Thai only — plain strings, not `$localize`. All on-screen UI strings are `$localize`/`i18n` with Thai source + English target in `web/src/locale/messages.en.xlf`.
- Tap targets ≥ 44px (dashboard used one-handed courtside).
- Server tests keep `fileParallelism: false`. Never re-enable.
- Work on branch `feat/c3-bill`; `main` runs live weekly sessions.

## Review Focus

1. **Undone / unfinished matches** — a pending, active, or undone match must not count as a game. Pinned in Task 5 (only `confirmedAt` + `endedAt` non-null pairings are billed).
2. **Stale config ids** — a saved `addedIds`/`removedIds`/`overrides` entry for a player no longer on the roster must not crash GET bill. Pinned in Task 4 (`sanitizeForRoster`) + Task 5.
3. **Nobody played yet** (bill opened mid-session, zero finished matches) — must return an empty bill, not throw or divide by zero. Pinned in Task 1 (`empty session` test).
4. **Everyone removed / only-walk-ins billed** — discount must still distribute without leaving satang unassigned. Pinned in Task 2 (`floor at 0` + `all walk-ins` tests).
5. **Singles matches** — split among 2 players, rate identical to doubles (D3). Pinned in Task 1 (`singles` test).

---

## File Structure

| File | Responsibility |
|---|---|
| `engines/bill.ts` (create) | Types, defaults, split helpers, `computeBill`. Pure. |
| `engines/bill.test.ts` (create) | Engine tests. |
| `server/prisma/schema.prisma` (modify) | `Session.billConfig String?`, `SessionRoster.walkIn Boolean @default(false)`. |
| `server/prisma/migrations/20260924120000_add_bill_config_and_walk_in/migration.sql` (create) | Two `ALTER TABLE`s. |
| `server/src/sessions/bill-config.ts` (create) | Only place `billConfig` JSON is parsed/written; tolerant parse, per-person strip, roster sanitize. |
| `server/src/sessions/bill-config.spec.ts` (create) | Unit tests, no DB. |
| `server/src/sessions/dto/set-roster-walk-in.dto.ts` (create) | `{ walkIn: boolean }`. |
| `server/src/sessions/dto/set-bill-config.dto.ts` (create) | Full-replace config DTO. |
| `server/src/sessions/sessions.service.ts` (modify) | `addWalkInExclusively` sets `walkIn: true`; new `setRosterWalkIn`. |
| `server/src/sessions/sessions.controller.ts` (modify) | `POST :code/roster/:playerId/walk-in`. |
| `server/src/sessions/bill.service.ts` (create) | `getBill`, `setBillConfig`. |
| `server/src/sessions/bill.controller.ts` (create) | `GET :code/bill`, `POST :code/bill-config`. |
| `server/src/sessions/sessions.module.ts` (modify) | Register `BillController`, `BillService`. |
| `server/src/sessions/bill.controller.spec.ts` (create) | API tests for bill + walk-in routes. |
| `web/src/app/core/bill.model.ts` (create) | Response/config TS types (duplicated from engine — web has no engine imports). |
| `web/src/app/core/bill-text.ts` (+ `.spec.ts`) (create) | Pure Thai LINE-text builder + `formatBaht`. |
| `web/src/app/pages/session-bill/session-bill.{ts,html,css,spec.ts}` (create) | Bill editor page. |
| `web/src/app/app.routes.ts` (+ `.spec.ts`) (modify) | `s/:sessionCode/bill`, `adminGuard`. |
| `web/src/app/pages/session-summary/session-summary.html` (modify) | Host-only "คิดเงิน" link. |
| `web/src/locale/messages.xlf`, `messages.en.xlf` (modify) | New UI strings. |
| docs (modify) | Roadmap C3 `[x]`, spec deviations, `overview.md`. |

---

### Task 1: Bill engine — models, splits, add/remove/override, rounding, margin

**Files:**
- Create: `engines/bill.ts`
- Test: `engines/bill.test.ts`
- Setup (fold in): `git checkout -b feat/c3-bill`; copy this plan to `docs/superpowers/plans/2026-09-24-c3-per-person-bill.md` and commit it first.

**Interfaces:**
- Produces (used by Tasks 2, 4, 5, 6):
  - `BILL_MODELS`, `BillModel = 'fair' | 'perGame' | 'buffet'`; `SPLIT_MODES`, `SplitMode = 'equal' | 'byGames'`; `ROUNDING_STEPS`, `RoundingStep = 1 | 5 | 10`
  - `interface BillOverride { playerId: string; amountSatang: number }`
  - `interface BillConfig { model; courtFeeSatang: number | null; courtSplit; shuttleSplit; perGameRateSatang; entryFeeSatang; capSatang: number | null; buffetPriceSatang; buffetShuttlesIncluded: boolean; hostFeeSatang; walkInFeeSatang; roundingBaht; addedIds: string[]; removedIds: string[]; overrides: BillOverride[] }`
  - `DEFAULT_BILL_CONFIG: BillConfig`
  - `interface BillMatch { players: string[] }`
  - `interface BillInput { config; matches: BillMatch[]; walkInIds: string[]; shuttleCount: number | null; shuttlePriceSatang: number | null }`
  - `type BillWarning = 'MISSING_COURT_FEE' | 'MISSING_SHUTTLE_COUNT' | 'MISSING_SHUTTLE_PRICE'`
  - `interface BillRow { playerId; games; status: 'billed' | 'removed'; added: boolean; walkIn: boolean; courtSatang; shuttleSatang; baseSatang; hostFeeSatang; walkInFeeSatang; walkInDiscountSatang; overridden: boolean; amountSatang }`
  - `interface BillResult { rows: BillRow[]; totals: { collectedSatang; costSatang: number | null; marginSatang: number | null; billedCount; walkInCount }; warnings: BillWarning[] }`
  - `splitEqual(total, n): number[]`, `splitByWeight(total, weights): number[]`, `computeBill(input: BillInput): BillResult`

Rules implemented here (from spec): games = confirmed+finished matches (caller filters). Participants = anyone with ≥1 game ∪ `addedIds`, sorted by id. Billed = participants − `removedIds`. **Cost parts** (fair court, fair shuttles, buffet ลูกแยก shuttles) are split over participants and a removed person's cost share is redistributed equally over billed people (cost stays covered). **Price parts** (per-game, entry, buffet price) are not redistributed (host absorbs). byGames court = weighted by games; byGames shuttle = each match gets `total ÷ matches`, split among that match's players (so singles players carry half a match each — same rate as doubles per D3). byGames with zero games/matches falls back to equal. Per-game cap applies to the per-game share only. Rounding = ceil to the step, applied to the final amount; overrides are final and not rounded. Cost = court fee + shuttles when all three inputs are non-null, else null (margin hidden). In this task walk-in fields are always 0/false; Task 2 adds them.

- [ ] **Step 1: Write the failing tests**

```ts
// engines/bill.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBill,
  splitEqual,
  splitByWeight,
  DEFAULT_BILL_CONFIG,
  type BillConfig,
  type BillInput,
  type BillMatch,
} from './bill.ts';

const m = (...players: string[]): BillMatch => ({ players });
// a3 b3 c2 d2 e2
const FIVE: BillMatch[] = [m('a', 'b', 'c', 'd'), m('a', 'b', 'c', 'e'), m('a', 'b', 'd', 'e')];

function input(config: Partial<BillConfig>, extra: Partial<BillInput> = {}): BillInput {
  return {
    config: { ...DEFAULT_BILL_CONFIG, walkInFeeSatang: 0, ...config },
    matches: FIVE,
    walkInIds: [],
    // Money fields default to "not recorded"; each test that checks amounts sets
    // them explicitly. Every final amount is ceiled to at least 1 baht, so
    // fixtures are chosen to land on whole baht unless rounding is the subject.
    shuttleCount: null,
    shuttlePriceSatang: null,
    ...extra,
  };
}
const amounts = (r: ReturnType<typeof computeBill>) =>
  Object.fromEntries(r.rows.filter((x) => x.status === 'billed').map((x) => [x.playerId, x.amountSatang]));

test('splitEqual gives the remainder to the first entries', () => {
  assert.deepEqual(splitEqual(10, 3), [4, 3, 3]);
  assert.deepEqual(splitEqual(0, 2), [0, 0]);
  assert.deepEqual(splitEqual(5, 0), []);
});

test('splitByWeight is exact, largest remainder, ties by position', () => {
  assert.deepEqual(splitByWeight(100000, [3, 3, 2, 2, 2]), [25000, 25000, 16667, 16667, 16666]);
  assert.deepEqual(splitByWeight(10, [0, 0]), [5, 5]);
});

test('fair: court and shuttles split equally over participants', () => {
  const r = computeBill(
    input(
      { model: 'fair', courtFeeSatang: 100000, courtSplit: 'equal', shuttleSplit: 'equal' },
      { shuttleCount: 3, shuttlePriceSatang: 4000 }
    )
  );
  // court 100000/5 = 20000; shuttles 12000/5 = 2400
  assert.deepEqual(amounts(r), { a: 22400, b: 22400, c: 22400, d: 22400, e: 22400 });
  assert.equal(r.totals.collectedSatang, 112000);
  assert.equal(r.totals.costSatang, 112000);
  assert.equal(r.totals.marginSatang, 0);
  assert.deepEqual(r.warnings, []);
});

test('fair: court by games', () => {
  const r = computeBill(input({ model: 'fair', courtFeeSatang: 100000, courtSplit: 'byGames', shuttleSplit: 'equal' }));
  const court = Object.fromEntries(r.rows.map((x) => [x.playerId, x.courtSatang]));
  assert.deepEqual(court, { a: 25000, b: 25000, c: 16667, d: 16667, e: 16666 });
});

test('fair: shuttles by games give each match an equal share, split among its players (raw share)', () => {
  const r = computeBill(
    input(
      { model: 'fair', courtFeeSatang: 0, courtSplit: 'equal', shuttleSplit: 'byGames' },
      { shuttleCount: 3, shuttlePriceSatang: 4000 }
    )
  );
  // 12000 / 3 matches = 4000 per match / 4 players = 1000 per appearance
  const shuttle = Object.fromEntries(r.rows.map((x) => [x.playerId, x.shuttleSatang]));
  assert.deepEqual(shuttle, { a: 3000, b: 3000, c: 2000, d: 2000, e: 2000 });
});

test('fair: removed person\'s cost share is spread equally over the billed', () => {
  const r = computeBill(
    input(
      { model: 'fair', courtFeeSatang: 100000, courtSplit: 'equal', shuttleSplit: 'equal', removedIds: ['e'] },
      { shuttleCount: 3, shuttlePriceSatang: 4000 }
    )
  );
  // court 20000 + e's 20000/4 = 25000; shuttles 2400 + e's 2400/4 = 3000
  assert.deepEqual(amounts(r), { a: 28000, b: 28000, c: 28000, d: 28000 });
  assert.equal(r.totals.collectedSatang, 112000);
  const e = r.rows.find((x) => x.playerId === 'e')!;
  assert.equal(e.status, 'removed');
  assert.equal(e.amountSatang, 0);
});

test('fair: missing shuttle count warns and bills shuttles as 0; margin hidden', () => {
  const r = computeBill(
    input({ model: 'fair', courtFeeSatang: 100000, courtSplit: 'equal' }, { shuttleCount: null, shuttlePriceSatang: 4000 })
  );
  assert.deepEqual(r.warnings, ['MISSING_SHUTTLE_COUNT']);
  assert.equal(r.totals.collectedSatang, 100000);
  assert.equal(r.totals.costSatang, null);
  assert.equal(r.totals.marginSatang, null);
});

test('fair: missing shuttle price warns', () => {
  const r = computeBill(
    input({ model: 'fair', courtFeeSatang: 100000, courtSplit: 'equal' }, { shuttleCount: 3, shuttlePriceSatang: null })
  );
  assert.deepEqual(r.warnings, ['MISSING_SHUTTLE_PRICE']);
});

test('fair: missing court fee warns', () => {
  const r = computeBill(
    input({ model: 'fair', courtFeeSatang: null, courtSplit: 'equal' }, { shuttleCount: 3, shuttlePriceSatang: 4000 })
  );
  assert.deepEqual(r.warnings, ['MISSING_COURT_FEE']);
});

test('perGame: entry + games × rate, capped; no shuttle warning', () => {
  const r = computeBill(
    input(
      { model: 'perGame', perGameRateSatang: 5000, entryFeeSatang: 3000, capSatang: 17000 },
      { shuttleCount: null, shuttlePriceSatang: null }
    )
  );
  assert.deepEqual(amounts(r), { a: 17000, b: 17000, c: 13000, d: 13000, e: 13000 });
  assert.deepEqual(r.warnings, []);
});

test('buffet: shuttles included is flat per person', () => {
  const r = computeBill(
    input({ model: 'buffet', buffetPriceSatang: 18000, buffetShuttlesIncluded: true }, { shuttleCount: null, shuttlePriceSatang: null })
  );
  assert.deepEqual(amounts(r), { a: 18000, b: 18000, c: 18000, d: 18000, e: 18000 });
  assert.deepEqual(r.warnings, []);
});

test('buffet: shuttles separate adds each person\'s fair share', () => {
  const r = computeBill(
    input(
      { model: 'buffet', buffetPriceSatang: 18000, buffetShuttlesIncluded: false, shuttleSplit: 'equal' },
      { shuttleCount: 3, shuttlePriceSatang: 4000 }
    )
  );
  // shuttle equal: 12000 / 5 = 2400 each
  assert.deepEqual(amounts(r), { a: 20400, b: 20400, c: 20400, d: 20400, e: 20400 });
});

test('added no-show pays only the equal/entry/buffet part, not court/shuttle by games', () => {
  const fair = computeBill(
    input({ model: 'fair', courtFeeSatang: 120000, courtSplit: 'equal', addedIds: ['f'] }, { shuttleCount: 3, shuttlePriceSatang: 4000 })
  );
  const f = fair.rows.find((x) => x.playerId === 'f')!;
  assert.equal(f.added, true);
  assert.equal(f.games, 0);
  assert.equal(f.courtSatang, 20000); // 120000 / 6 participants
  assert.equal(f.shuttleSatang, 0); // byGames default: f played no matches
  const perGame = computeBill(
    input({ model: 'perGame', perGameRateSatang: 5000, entryFeeSatang: 3000, addedIds: ['f'] }, { shuttleCount: null, shuttlePriceSatang: null })
  );
  assert.equal(amounts(perGame).f, 3000);
});

test('host fee is added per person; the final amount is ceiled to the rounding step; an override bypasses both', () => {
  const r = computeBill(
    input(
      {
        model: 'fair',
        courtFeeSatang: 100000,
        courtSplit: 'equal',
        hostFeeSatang: 900,
        roundingBaht: 5,
        overrides: [{ playerId: 'e', amountSatang: 0 }],
      },
      { shuttleCount: 0, shuttlePriceSatang: 0 }
    )
  );
  // 100000/5 = 20000 + 900 host fee = 20900 -> ceil to nearest 500 -> 21000
  assert.deepEqual(amounts(r), { a: 21000, b: 21000, c: 21000, d: 21000, e: 0 });
  assert.equal(r.rows.find((x) => x.playerId === 'e')!.overridden, true);
});

test('singles: a match is split between its two players, same rate as doubles', () => {
  const r = computeBill(
    input(
      { model: 'fair', courtFeeSatang: 0, courtSplit: 'equal', shuttleSplit: 'byGames' },
      { matches: [m('a', 'b'), m('a', 'b', 'c', 'd')], shuttleCount: 2, shuttlePriceSatang: 4000 }
    )
  );
  // 8000 / 2 matches = 4000/match; singles splits 2 ways (2000 each),
  // doubles splits 4 ways (1000 each) -- the same per-match rate either way
  assert.deepEqual(amounts(r), { a: 3000, b: 3000, c: 1000, d: 1000 });
});

test('empty session: no finished matches and nobody added -> empty bill', () => {
  const r = computeBill(
    input({ model: 'fair', courtFeeSatang: 100000, courtSplit: 'equal' }, { matches: [], shuttleCount: null, shuttlePriceSatang: null })
  );
  assert.deepEqual(r.rows, []);
  assert.equal(r.totals.collectedSatang, 0);
  assert.equal(r.totals.billedCount, 0);
});

test('bad input throws', () => {
  assert.throws(() => computeBill(input({ hostFeeSatang: -1 })));
  assert.throws(() => computeBill(input({ perGameRateSatang: 1.5 })));
  assert.throws(() => computeBill(input({ model: 'nope' as never })));
  assert.throws(() => computeBill(input({ roundingBaht: 3 as never })));
  assert.throws(() => computeBill(input({ addedIds: ['f', 'f'] })));
  assert.throws(() =>
    computeBill(input({ overrides: [{ playerId: 'a', amountSatang: 1 }, { playerId: 'a', amountSatang: 2 }] }))
  );
  assert.throws(() => computeBill(input({}, { matches: [m('a', 'a', 'b', 'c')] })));
  assert.throws(() => computeBill(input({}, { shuttleCount: -1 })));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --experimental-strip-types --test engines/bill.test.ts`
Expected: FAIL — `Cannot find module ... engines/bill.ts`.

- [ ] **Step 3: Implement `engines/bill.ts`**

```ts
/**
 * Per-person bill for one session (roadmap C3). Pure: the server stores only
 * the inputs and recomputes on every read, the same rule as ratings.
 * Integer satang throughout. See the C3 section of
 * docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md.
 */

export const BILL_MODELS = ['fair', 'perGame', 'buffet'] as const;
export type BillModel = (typeof BILL_MODELS)[number];
export const SPLIT_MODES = ['equal', 'byGames'] as const;
export type SplitMode = (typeof SPLIT_MODES)[number];
export const ROUNDING_STEPS = [1, 5, 10] as const;
export type RoundingStep = (typeof ROUNDING_STEPS)[number];

export interface BillOverride {
  playerId: string;
  amountSatang: number;
}

export interface BillConfig {
  model: BillModel;
  /** Actual court cost. Split in `fair`; used for the margin in every model. */
  courtFeeSatang: number | null;
  courtSplit: SplitMode;
  shuttleSplit: SplitMode;
  perGameRateSatang: number;
  entryFeeSatang: number;
  capSatang: number | null;
  buffetPriceSatang: number;
  buffetShuttlesIncluded: boolean;
  hostFeeSatang: number;
  walkInFeeSatang: number;
  roundingBaht: RoundingStep;
  addedIds: string[];
  removedIds: string[];
  overrides: BillOverride[];
}

export const DEFAULT_BILL_CONFIG: BillConfig = {
  model: 'fair',
  courtFeeSatang: null,
  courtSplit: 'equal',
  shuttleSplit: 'byGames',
  perGameRateSatang: 0,
  entryFeeSatang: 0,
  capSatang: null,
  buffetPriceSatang: 0,
  buffetShuttlesIncluded: true,
  hostFeeSatang: 0,
  walkInFeeSatang: 2000,
  roundingBaht: 1,
  addedIds: [],
  removedIds: [],
  overrides: [],
};

/** Every player id on court in one confirmed, finished match. */
export interface BillMatch {
  players: string[];
}

export interface BillInput {
  config: BillConfig;
  matches: BillMatch[];
  walkInIds: string[];
  shuttleCount: number | null;
  shuttlePriceSatang: number | null;
}

export type BillWarning = 'MISSING_COURT_FEE' | 'MISSING_SHUTTLE_COUNT' | 'MISSING_SHUTTLE_PRICE';

export interface BillRow {
  playerId: string;
  games: number;
  status: 'billed' | 'removed';
  added: boolean;
  walkIn: boolean;
  courtSatang: number;
  shuttleSatang: number;
  /** Model share: court + shuttles (fair), entry + per-game capped (perGame), price (+ shuttles) (buffet). */
  baseSatang: number;
  hostFeeSatang: number;
  walkInFeeSatang: number;
  walkInDiscountSatang: number;
  overridden: boolean;
  /** Final amount to pay: rounded, or the override. 0 when removed. */
  amountSatang: number;
}

export interface BillResult {
  rows: BillRow[];
  totals: {
    collectedSatang: number;
    costSatang: number | null;
    marginSatang: number | null;
    billedCount: number;
    walkInCount: number;
  };
  warnings: BillWarning[];
}

/** Largest-remainder equal split: sums to `total` exactly; extra satang go to the first entries. */
export function splitEqual(total: number, n: number): number[] {
  if (n === 0) return [];
  const q = Math.floor(total / n);
  const r = total - q * n;
  return Array.from({ length: n }, (_, i) => q + (i < r ? 1 : 0));
}

/** Largest-remainder weighted split, integer-exact. All-zero weights fall back to equal. */
export function splitByWeight(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return splitEqual(total, weights.length);
  const out = weights.map((w) => Math.floor((total * w) / sum));
  let rest = total - out.reduce((a, b) => a + b, 0);
  const order = weights
    .map((w, i) => ({ i, rem: (total * w) % sum }))
    .sort((x, y) => y.rem - x.rem || x.i - y.i);
  for (const { i } of order) {
    if (rest === 0) break;
    out[i]++;
    rest--;
  }
  return out;
}

function assertMoney(label: string, v: number | null): void {
  if (v === null) return;
  if (!Number.isInteger(v) || v < 0) throw new Error(`bill: ${label} must be a non-negative integer, got ${v}`);
}

function assertUnique(label: string, ids: string[]): void {
  if (new Set(ids).size !== ids.length) throw new Error(`bill: duplicate id in ${label}`);
  if (ids.some((id) => id === '')) throw new Error(`bill: empty id in ${label}`);
}

function validate(input: BillInput): void {
  const c = input.config;
  if (!BILL_MODELS.includes(c.model)) throw new Error(`bill: unknown model ${c.model}`);
  if (!SPLIT_MODES.includes(c.courtSplit) || !SPLIT_MODES.includes(c.shuttleSplit)) {
    throw new Error('bill: unknown split mode');
  }
  if (!ROUNDING_STEPS.includes(c.roundingBaht)) throw new Error(`bill: unknown rounding ${c.roundingBaht}`);
  assertMoney('courtFeeSatang', c.courtFeeSatang);
  assertMoney('perGameRateSatang', c.perGameRateSatang);
  assertMoney('entryFeeSatang', c.entryFeeSatang);
  assertMoney('capSatang', c.capSatang);
  assertMoney('buffetPriceSatang', c.buffetPriceSatang);
  assertMoney('hostFeeSatang', c.hostFeeSatang);
  assertMoney('walkInFeeSatang', c.walkInFeeSatang);
  assertMoney('shuttleCount', input.shuttleCount);
  assertMoney('shuttlePriceSatang', input.shuttlePriceSatang);
  for (const o of c.overrides) assertMoney(`override ${o.playerId}`, o.amountSatang);
  assertUnique('addedIds', c.addedIds);
  assertUnique('removedIds', c.removedIds);
  assertUnique('overrides', c.overrides.map((o) => o.playerId));
  for (const match of input.matches) {
    if (match.players.length === 0) throw new Error('bill: match with no players');
    assertUnique('match players', match.players);
  }
}

/**
 * A cost (court or shuttles) split over participants, with any removed
 * person's share spread equally over the billed so the cost stays covered.
 */
function costShares(
  total: number,
  split: SplitMode,
  kind: 'court' | 'shuttle',
  participants: string[],
  billed: string[],
  games: Map<string, number>,
  matches: BillMatch[]
): Map<string, number> {
  const raw = new Map(participants.map((id) => [id, 0]));
  if (participants.length === 0) return raw;
  const totalGames = participants.reduce((s, id) => s + (games.get(id) ?? 0), 0);
  if (split === 'equal' || totalGames === 0) {
    splitEqual(total, participants.length).forEach((v, i) => raw.set(participants[i], v));
  } else if (kind === 'court') {
    splitByWeight(total, participants.map((id) => games.get(id) ?? 0)).forEach((v, i) =>
      raw.set(participants[i], v)
    );
  } else {
    const perMatch = splitEqual(total, matches.length);
    matches.forEach((match, k) => {
      splitEqual(perMatch[k], match.players.length).forEach((v, j) => {
        const id = match.players[j];
        raw.set(id, (raw.get(id) ?? 0) + v);
      });
    });
  }
  const billedSet = new Set(billed);
  const removedTotal = participants.filter((id) => !billedSet.has(id)).reduce((s, id) => s + raw.get(id)!, 0);
  const extra = splitEqual(removedTotal, billed.length);
  const out = new Map<string, number>();
  for (const id of participants) out.set(id, billedSet.has(id) ? raw.get(id)! : 0);
  billed.forEach((id, i) => out.set(id, out.get(id)! + extra[i]));
  return out;
}

function ceilTo(amount: number, step: number): number {
  return Math.ceil(amount / step) * step;
}

export function computeBill(input: BillInput): BillResult {
  validate(input);
  const { config, matches, shuttleCount, shuttlePriceSatang } = input;

  const games = new Map<string, number>();
  for (const match of matches) for (const id of match.players) games.set(id, (games.get(id) ?? 0) + 1);
  const added = new Set(config.addedIds);
  const participants = [...new Set([...games.keys(), ...config.addedIds])].sort();
  const removed = new Set(config.removedIds);
  const billed = participants.filter((id) => !removed.has(id));

  const warnings: BillWarning[] = [];
  const shuttlesBilled = config.model === 'fair' || (config.model === 'buffet' && !config.buffetShuttlesIncluded);
  if (config.model === 'fair' && config.courtFeeSatang === null) warnings.push('MISSING_COURT_FEE');
  if (shuttlesBilled && shuttleCount === null) warnings.push('MISSING_SHUTTLE_COUNT');
  if (shuttlesBilled && shuttlePriceSatang === null) warnings.push('MISSING_SHUTTLE_PRICE');

  const shuttleTotal = (shuttleCount ?? 0) * (shuttlePriceSatang ?? 0);
  const court =
    config.model === 'fair'
      ? costShares(config.courtFeeSatang ?? 0, config.courtSplit, 'court', participants, billed, games, matches)
      : new Map<string, number>();
  const shuttle = shuttlesBilled
    ? costShares(shuttleTotal, config.shuttleSplit, 'shuttle', participants, billed, games, matches)
    : new Map<string, number>();

  const overrides = new Map(config.overrides.map((o) => [o.playerId, o.amountSatang]));
  const step = config.roundingBaht * 100;

  const rows: BillRow[] = participants.map((id) => {
    const g = games.get(id) ?? 0;
    const isBilled = !removed.has(id);
    const courtSatang = court.get(id) ?? 0;
    const shuttleSatang = shuttle.get(id) ?? 0;
    let baseSatang = 0;
    if (config.model === 'fair') baseSatang = courtSatang + shuttleSatang;
    else if (config.model === 'perGame') {
      const raw = config.entryFeeSatang + g * config.perGameRateSatang;
      baseSatang = config.capSatang === null ? raw : Math.min(raw, config.capSatang);
    } else baseSatang = config.buffetPriceSatang + shuttleSatang;
    const overridden = isBilled && overrides.has(id);
    const hostFeeSatang = isBilled ? config.hostFeeSatang : 0;
    const amountSatang = !isBilled
      ? 0
      : overridden
        ? overrides.get(id)!
        : ceilTo(baseSatang + hostFeeSatang, step);
    return {
      playerId: id,
      games: g,
      status: isBilled ? 'billed' : 'removed',
      added: added.has(id) && g === 0,
      walkIn: false,
      courtSatang,
      shuttleSatang,
      baseSatang: isBilled ? baseSatang : 0,
      hostFeeSatang,
      walkInFeeSatang: 0,
      walkInDiscountSatang: 0,
      overridden,
      amountSatang,
    };
  });

  const collectedSatang = rows.reduce((s, r) => s + r.amountSatang, 0);
  const costSatang =
    config.courtFeeSatang === null || shuttleCount === null || shuttlePriceSatang === null
      ? null
      : config.courtFeeSatang + shuttleTotal;
  return {
    rows,
    totals: {
      collectedSatang,
      costSatang,
      marginSatang: costSatang === null ? null : collectedSatang - costSatang,
      billedCount: billed.length,
      walkInCount: 0,
    },
    warnings,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --experimental-strip-types --test engines/bill.test.ts`
Expected: all PASS. Then `npm run test:engines` (root) — all engine suites PASS.

- [ ] **Step 5: Commit**

```bash
git add engines/bill.ts engines/bill.test.ts docs/superpowers/plans/2026-09-24-c3-per-person-bill.md
git commit -m "feat(engines): per-person bill for three charging models (C3)"
```

---

### Task 2: Bill engine — walk-in surcharge redistributed (D7)

**Files:**
- Modify: `engines/bill.ts` (row building + totals in `computeBill`; new `distributeCapped`)
- Test: `engines/bill.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's `computeBill`, `splitEqual`, `BillInput.walkInIds`, `BillConfig.walkInFeeSatang`.
- Produces: rows now carry real `walkIn`, `walkInFeeSatang`, `walkInDiscountSatang`; `totals.walkInCount`. Exported `distributeCapped(pool: number, caps: number[]): number[]`.

Rule: `eligible` = billed ∧ not overridden. `pool = fee × |eligible ∩ walkIns|`. Discount = pool split equally over eligible (largest remainder, id order), capped per person at `base + hostFee (+ fee if walk-in)` so nobody goes negative; capped surplus re-splits over the rest (water-fill). `amount = ceil(base + hostFee − discount + fee_if_walkIn)`. Walk-in ids not billed are ignored.

- [ ] **Step 1: Append failing tests**

```ts
// engines/bill.test.ts (append)
import { distributeCapped } from './bill.ts';

const FOUR = [m('a', 'b', 'c', 'd')];
function walkIn(config: Partial<BillConfig>, walkInIds: string[], extra: Partial<BillInput> = {}): BillInput {
  return input({ walkInFeeSatang: 2000, ...config }, { matches: FOUR, shuttleCount: 0, shuttlePriceSatang: 0, walkInIds, ...extra });
}

test('walk-in: owner example 200฿ / 4 players / 1 walk-in / 20฿ -> 45,45,45,65', () => {
  const r = computeBill(walkIn({ model: 'fair', courtFeeSatang: 20000 }, ['d']));
  assert.deepEqual(amounts(r), { a: 4500, b: 4500, c: 4500, d: 6500 });
  const d = r.rows.find((x) => x.playerId === 'd')!;
  assert.equal(d.walkIn, true);
  assert.equal(d.walkInFeeSatang, 2000);
  assert.equal(d.walkInDiscountSatang, 500);
  assert.equal(r.totals.walkInCount, 1);
  assert.equal(r.totals.collectedSatang, 20000);
});

test('walk-in: total collected is unchanged with vs without any walk-ins marked, in every model', () => {
  // FOUR is a single match, so every player has 1 game -- byGames and equal
  // splits coincide, keeping every intermediate share whole-baht so
  // per-person rounding can't shift the total either way.
  const configs: Partial<BillConfig>[] = [
    { model: 'fair', courtFeeSatang: 100000, courtSplit: 'byGames', shuttleSplit: 'byGames' },
    { model: 'perGame', perGameRateSatang: 5000, entryFeeSatang: 3000, capSatang: 17000 },
    { model: 'buffet', buffetPriceSatang: 18000, buffetShuttlesIncluded: false, shuttleSplit: 'byGames' },
  ];
  for (const c of configs) {
    const extra = { matches: FOUR, shuttleCount: 3, shuttlePriceSatang: 4000, walkInIds: [] as string[] };
    const without = computeBill(input({ ...c, walkInFeeSatang: 2000 }, extra));
    const withW = computeBill(input({ ...c, walkInFeeSatang: 2000 }, { ...extra, walkInIds: ['c'] }));
    assert.equal(withW.totals.collectedSatang, without.totals.collectedSatang, c.model);
  }
});

test('walk-in: the discount splits by largest remainder when it does not divide evenly', () => {
  const r = computeBill(
    walkIn({ model: 'buffet', buffetPriceSatang: 10000 }, ['c'], { matches: [m('a', 'b'), m('c', 'a')] })
  );
  // pool 2000 over 3 billed players -> 667, 667, 666 (remainder to the first ids).
  // This is the raw, unrounded discount field -- amountSatang still ceils to
  // whole baht on top of it, so it is not asserted here.
  const discount = Object.fromEntries(r.rows.map((x) => [x.playerId, x.walkInDiscountSatang]));
  assert.deepEqual(discount, { a: 667, b: 667, c: 666 });
});

test('walk-in: an overridden or removed player is outside the pool and the discount', () => {
  const r = computeBill(
    walkIn(
      { model: 'fair', courtFeeSatang: 20000, overrides: [{ playerId: 'a', amountSatang: 0 }], removedIds: ['b'] },
      ['a', 'b', 'd']
    )
  );
  const rows = Object.fromEntries(r.rows.map((x) => [x.playerId, x]));
  assert.equal(rows['a'].amountSatang, 0);
  assert.equal(rows['a'].walkInFeeSatang, 0);
  assert.equal(rows['a'].walkInDiscountSatang, 0);
  assert.equal(rows['b'].status, 'removed');
  assert.equal(rows['b'].walkInFeeSatang, 0);
  // pool = 2000 (only d pays the fee; a is overridden, b is removed) over the
  // 2 eligible billed players (c, d)
  assert.equal(rows['c'].walkInDiscountSatang, 1000);
  assert.equal(rows['d'].walkInDiscountSatang, 1000);
  assert.equal(rows['d'].walkInFeeSatang, 2000);
  // d's raw share (court 6666 - discount 1000 + fee 2000 = 7666) ceils to the nearest baht
  assert.equal(rows['d'].amountSatang, 7700);
});

test('walk-in: a player with no base owes nothing and receives no discount', () => {
  const r = computeBill(
    walkIn({ model: 'fair', courtFeeSatang: 12000, courtSplit: 'byGames', addedIds: ['f'] }, ['d'])
  );
  // a,b,c,d each played, f was added with no games so its court weight is 0
  assert.deepEqual(amounts(r), { a: 2500, b: 2500, c: 2500, d: 4500, f: 0 });
});

test('walk-in: when every billed player is a walk-in, each pays only their own plain share', () => {
  const r = computeBill(walkIn({ model: 'fair', courtFeeSatang: 20000 }, ['a', 'b', 'c', 'd']));
  assert.deepEqual(amounts(r), { a: 5000, b: 5000, c: 5000, d: 5000 });
});

test('walk-in: fee 0 is a no-op', () => {
  const r = computeBill(walkIn({ model: 'fair', courtFeeSatang: 20000, walkInFeeSatang: 0 }, ['d']));
  assert.deepEqual(amounts(r), { a: 5000, b: 5000, c: 5000, d: 5000 });
});

test('walk-in: rounding applies after the fee step', () => {
  const r = computeBill(walkIn({ model: 'fair', courtFeeSatang: 20000, roundingBaht: 10, walkInFeeSatang: 1500 }, ['d']));
  // pool 1500 / 4 = 375 each: a 4625 -> 5000; d 5000 - 375 + 1500 = 6125 -> 7000
  assert.deepEqual(amounts(r), { a: 5000, b: 5000, c: 5000, d: 7000 });
});

test('walk-in: negative fee throws', () => {
  assert.throws(() => computeBill(walkIn({ walkInFeeSatang: -100 }, ['d'])));
});

test('distributeCapped: an entry with a 0 cap is excluded from the outset', () => {
  assert.deepEqual(distributeCapped(2000, [3000, 3000, 3000, 5000, 0]), [500, 500, 500, 500, 0]);
  assert.deepEqual(distributeCapped(0, [10, 10]), [0, 0]);
});

test('distributeCapped: entries that hit their cap pass the remainder on', () => {
  // Equal shares would be [334, 333, 333]; the first two are capped at 100 and
  // the third absorbs everything they could not take.
  assert.deepEqual(distributeCapped(1000, [100, 100, 5000]), [100, 100, 800]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --experimental-strip-types --test engines/bill.test.ts`
Expected: FAIL — `distributeCapped` not exported; owner example gives 5000s.

- [ ] **Step 3: Implement**

Add to `engines/bill.ts`:

```ts
/**
 * Splits `pool` equally over the entries, never giving any entry more than
 * its cap; what a capped entry can't take is re-split over the rest.
 * Throws if the caps can't absorb the pool (the walk-in fee guarantees they
 * can: each walk-in's cap includes the fee it pays in).
 */
export function distributeCapped(pool: number, caps: number[]): number[] {
  const out = caps.map(() => 0);
  let remaining = pool;
  let open = caps.map((_, i) => i).filter((i) => caps[i] > 0);
  while (remaining > 0 && open.length > 0) {
    const shares = splitEqual(remaining, open.length);
    let given = 0;
    const next: number[] = [];
    open.forEach((idx, k) => {
      const add = Math.min(caps[idx] - out[idx], shares[k]);
      out[idx] += add;
      given += add;
      if (out[idx] < caps[idx]) next.push(idx);
    });
    remaining -= given;
    open = next;
  }
  if (remaining !== 0) throw new Error('bill: walk-in discount could not be distributed');
  return out;
}
```

In `computeBill`, replace the `rows` construction with a two-pass version: first compute `pre = base + hostFee` per participant (as now), then:

```ts
  const walkIns = new Set(input.walkInIds);
  const eligible = billed.filter((id) => !overrides.has(id));
  const eligibleWalkIns = eligible.filter((id) => walkIns.has(id));
  const fee = config.walkInFeeSatang;
  const pool = fee * eligibleWalkIns.length;
  const caps = eligible.map((id) => pre.get(id)! + (walkIns.has(id) ? fee : 0));
  const discount = new Map<string, number>();
  distributeCapped(pool, caps).forEach((d, i) => discount.set(eligible[i], d));
```

and per row: `walkIn = isBilled && !overridden && walkIns.has(id)`, `walkInFeeSatang = walkIn ? fee : 0`, `walkInDiscountSatang = discount.get(id) ?? 0`, and the non-override amount becomes `ceilTo(pre - walkInDiscountSatang + walkInFeeSatang, step)`. Set `totals.walkInCount = eligibleWalkIns.length` (this counts walk-ins who pay the fee, which is what the LINE header shows).

Concretely the row block becomes:

```ts
  const pre = new Map<string, number>();
  const baseOf = new Map<string, number>();
  for (const id of participants) {
    const g = games.get(id) ?? 0;
    const shuttleSatang = shuttle.get(id) ?? 0;
    let base = 0;
    if (config.model === 'fair') base = (court.get(id) ?? 0) + shuttleSatang;
    else if (config.model === 'perGame') {
      const raw = config.entryFeeSatang + g * config.perGameRateSatang;
      base = config.capSatang === null ? raw : Math.min(raw, config.capSatang);
    } else base = config.buffetPriceSatang + shuttleSatang;
    baseOf.set(id, base);
    pre.set(id, base + config.hostFeeSatang);
  }

  // (walk-in pool/discount block from above goes here)

  const rows: BillRow[] = participants.map((id) => {
    const isBilled = !removed.has(id);
    const overridden = isBilled && overrides.has(id);
    const isWalkIn = isBilled && !overridden && walkIns.has(id);
    const walkInFeeSatang = isWalkIn ? fee : 0;
    const walkInDiscountSatang = discount.get(id) ?? 0;
    const amountSatang = !isBilled
      ? 0
      : overridden
        ? overrides.get(id)!
        : ceilTo(pre.get(id)! - walkInDiscountSatang + walkInFeeSatang, step);
    return {
      playerId: id,
      games: games.get(id) ?? 0,
      status: isBilled ? 'billed' : 'removed',
      added: added.has(id) && !games.has(id),
      walkIn: isWalkIn,
      courtSatang: court.get(id) ?? 0,
      shuttleSatang: shuttle.get(id) ?? 0,
      baseSatang: isBilled ? baseOf.get(id)! : 0,
      hostFeeSatang: isBilled ? config.hostFeeSatang : 0,
      walkInFeeSatang,
      walkInDiscountSatang,
      overridden,
      amountSatang,
    };
  });
```

(`removed` people have `court`/`shuttle` 0 already from `costShares`; they are not in `eligible`, so discount is 0.)

- [ ] **Step 4: Run to verify pass**

Run: `node --experimental-strip-types --test engines/bill.test.ts` then `npm run test:engines`
Expected: all PASS (Task 1 tests still pass — walk-in fee is 0 in their `input()` helper).

- [ ] **Step 5: Commit**

```bash
git add engines/bill.ts engines/bill.test.ts
git commit -m "feat(engines): walk-in surcharge redistributed as group discount (C3 D7)"
```

---

### Task 3: Schema + walk-in mark (auto on C2 add, host toggle)

**Files:**
- Modify: `server/prisma/schema.prisma` (Session, SessionRoster)
- Create: `server/prisma/migrations/20260924120000_add_bill_config_and_walk_in/migration.sql`
- Create: `server/src/sessions/dto/set-roster-walk-in.dto.ts`
- Modify: `server/src/sessions/sessions.service.ts` (`addWalkInExclusively` ~`:2031`; new `setRosterWalkIn` next to `setRosterActive` ~`:1935`)
- Modify: `server/src/sessions/sessions.controller.ts` (next to `:code/roster/:playerId/active` ~`:129`)
- Test: `server/src/sessions/bill.controller.spec.ts` (create; the walk-in describe block)

**Interfaces:**
- Produces: `SessionRoster.walkIn: boolean`, `Session.billConfig: string | null` (Prisma client); `SessionsService.setRosterWalkIn(code: string, playerId: string, dto: SetRosterWalkInDto): Promise<{ playerId: string; walkIn: boolean }>`; route `POST /sessions/:code/roster/:playerId/walk-in` → 201.

- [ ] **Step 1: Schema + migration**

In `schema.prisma`, `Session` (after `shuttlePriceSatang`):

```prisma
  /// C3 bill inputs as JSON (model, rates, toggles, host/walk-in fee,
  /// rounding, added/removed/overridden people). Never the bill itself —
  /// that is recomputed on every read. Parsed and written only in
  /// server/src/sessions/bill-config.ts. Null = never saved.
  billConfig          String?
```

`SessionRoster` (after `activatedAt`):

```prisma
  /// Walk-in / late registrant tonight (C3 D7): pays the walk-in surcharge,
  /// which is handed back to the group as a discount. Set automatically when
  /// added mid-session (addWalkIn); the host can toggle it from the bill.
  walkIn    Boolean @default(false)
```

`migration.sql`:

```sql
ALTER TABLE "Session" ADD COLUMN "billConfig" TEXT;
ALTER TABLE "SessionRoster" ADD COLUMN "walkIn" BOOLEAN NOT NULL DEFAULT false;
```

Run (from `server/`): `npx prisma generate` (add `--config prisma7.config.ts` if the schema isn't found). Then `npx prisma migrate deploy` against dev.db.

- [ ] **Step 2: Write failing API tests**

Create `server/src/sessions/bill.controller.spec.ts` with the app bootstrap copied from `sessions.controller.spec.ts:10-44` (same imports, admin-caller middleware, ValidationPipe, single `listen(0)`), plus this fixture and block:

```ts
  const fixture = async (playerCount: number) => {
    const groupCode = randomUUID();
    const sessionCode = randomUUID();
    await prisma.group.create({ data: { code: groupCode, name: 'G' } });
    const players = [];
    for (let i = 0; i < playerCount; i++) {
      players.push(await prisma.player.create({ data: { groupId: groupCode, name: `P${i}`, aliases: '[]' } }));
    }
    await prisma.session.create({ data: { code: sessionCode, groupId: groupCode, courtCount: 1, rawImportText: '' } });
    for (const p of players) await prisma.sessionRoster.create({ data: { sessionId: sessionCode, playerId: p.id } });
    const finishMatch = (ids: string[], matchNumber: number) =>
      prisma.pairing.create({
        data: {
          sessionId: sessionCode, courtNumber: 1, matchNumber,
          teamA: JSON.stringify(ids.slice(0, ids.length / 2)),
          teamB: JSON.stringify(ids.slice(ids.length / 2)),
          confirmedAt: new Date(), endedAt: new Date(), winner: 'A',
        },
      });
    const cleanup = async () => {
      await prisma.pairing.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.sessionRoster.deleteMany({ where: { sessionId: sessionCode } });
      await prisma.session.deleteMany({ where: { groupId: groupCode } });
      await prisma.player.deleteMany({ where: { groupId: groupCode } });
      await prisma.group.deleteMany({ where: { code: groupCode } });
    };
    return { groupCode, sessionCode, players, finishMatch, cleanup };
  };

  describe('walk-in mark', () => {
    it('marks a player added mid-session as walk-in', async () => {
      const { sessionCode, cleanup } = await fixture(4);
      try {
        const res = await request(server).post(`/sessions/${sessionCode}/roster`).send({ name: 'Late' }).expect(201);
        const row = await prisma.sessionRoster.findUniqueOrThrow({
          where: { sessionId_playerId: { sessionId: sessionCode, playerId: res.body.playerId } },
        });
        expect(row.walkIn).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it('toggles walk-in on and off, also after the session ended', async () => {
      const { sessionCode, players, cleanup } = await fixture(4);
      try {
        await prisma.session.update({ where: { code: sessionCode }, data: { endedAt: new Date() } });
        const on = await request(server)
          .post(`/sessions/${sessionCode}/roster/${players[0].id}/walk-in`).send({ walkIn: true }).expect(201);
        expect(on.body).toEqual({ playerId: players[0].id, walkIn: true });
        const off = await request(server)
          .post(`/sessions/${sessionCode}/roster/${players[0].id}/walk-in`).send({ walkIn: false }).expect(201);
        expect(off.body.walkIn).toBe(false);
      } finally {
        await cleanup();
      }
    });

    it('404s for a player not on the roster, 400s on a bad body', async () => {
      const { sessionCode, players, cleanup } = await fixture(4);
      try {
        const res = await request(server)
          .post(`/sessions/${sessionCode}/roster/nope/walk-in`).send({ walkIn: true }).expect(404);
        expect(res.body.code).toBe('ROSTER_PLAYER_NOT_FOUND');
        await request(server)
          .post(`/sessions/${sessionCode}/roster/${players[0].id}/walk-in`).send({ walkIn: 'yes' }).expect(400);
      } finally {
        await cleanup();
      }
    });
  });
```

Run: `npx vitest run src/sessions/bill.controller.spec.ts` → FAIL (route 404 / `walkIn` false).

- [ ] **Step 3: Implement**

`dto/set-roster-walk-in.dto.ts`:

```ts
import { IsBoolean } from 'class-validator';

export class SetRosterWalkInDto {
  @IsBoolean()
  walkIn!: boolean;
}
```

In `addWalkInExclusively`, the `sessionRoster.create` data becomes `{ sessionId: sessionCode, playerId, active: true, gamesOffset, activatedAt: new Date(), walkIn: true }`.

New methods in `SessionsService` (below `setRosterActiveExclusively`):

```ts
  /**
   * Marks a roster player as a walk-in (C3 D7) or clears it. Billing only —
   * it touches no rotation state. Allowed after the session ends, because
   * the bill is settled then (same exception as setShuttleDetails).
   */
  setRosterWalkIn(sessionCode: string, playerId: string, dto: SetRosterWalkInDto) {
    return this.lock.run(sessionCode, () => this.setRosterWalkInExclusively(sessionCode, playerId, dto));
  }

  private async setRosterWalkInExclusively(sessionCode: string, playerId: string, dto: SetRosterWalkInDto) {
    const session = await this.prisma.session.findUnique({ where: { code: sessionCode } });
    if (!session) throw this.notFound('SESSION_NOT_FOUND');
    const entry = await this.prisma.sessionRoster.findUnique({
      where: { sessionId_playerId: { sessionId: sessionCode, playerId } },
    });
    if (!entry) throw this.notFound('ROSTER_PLAYER_NOT_FOUND');
    const updated = await this.prisma.sessionRoster.update({ where: { id: entry.id }, data: { walkIn: dto.walkIn } });
    return { playerId: updated.playerId, walkIn: updated.walkIn };
  }
```

Controller (after the `active` route):

```ts
  @Post(':code/roster/:playerId/walk-in')
  setRosterWalkIn(
    @Param('code') code: string,
    @Param('playerId') playerId: string,
    @Body() dto: SetRosterWalkInDto
  ) {
    return this.sessionsService.setRosterWalkIn(code, playerId, dto);
  }
```

with `import { SetRosterWalkInDto } from './dto/set-roster-walk-in.dto.js';` in both files.

- [ ] **Step 4: Run tests**

Run (from `server/`): `npx vitest run src/sessions/bill.controller.spec.ts src/auth/auth.boundary.spec.ts` → PASS (boundary spec auto-covers the new route: 401 anon, 404 other host). Then `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/prisma server/src/sessions
git commit -m "feat(server): walk-in mark on roster, auto-set for mid-session adds (C3)"
```

---

### Task 4: `bill-config.ts` — tolerant parse, serialize, prefill strip, roster sanitize

**Files:**
- Create: `server/src/sessions/bill-config.ts`
- Test: `server/src/sessions/bill-config.spec.ts`

**Interfaces:**
- Consumes: `BillConfig`, `DEFAULT_BILL_CONFIG`, `BILL_MODELS`, `SPLIT_MODES`, `ROUNDING_STEPS` from `engines/bill.ts`.
- Produces: `parseBillConfig(raw: string | null): BillConfig | null`, `serializeBillConfig(c: BillConfig): string`, `withoutPerPerson(c: BillConfig): BillConfig`, `sanitizeForRoster(c: BillConfig, rosterIds: string[]): BillConfig`.

Tolerant like `court-formats.ts`: malformed JSON or non-object → `null` (caller falls back); each field that is missing or invalid → default for that field. Never throws — a bad stored value must not break GET bill.

- [ ] **Step 1: Write failing tests**

```ts
// server/src/sessions/bill-config.spec.ts
import { DEFAULT_BILL_CONFIG } from '../../../engines/bill.ts';
import { parseBillConfig, sanitizeForRoster, serializeBillConfig, withoutPerPerson } from './bill-config.js';

describe('bill-config', () => {
  it('null and malformed read as null', () => {
    expect(parseBillConfig(null)).toBeNull();
    expect(parseBillConfig('{not json')).toBeNull();
    expect(parseBillConfig('[1,2]')).toBeNull();
  });

  it('round-trips a full config', () => {
    const c = { ...DEFAULT_BILL_CONFIG, model: 'perGame' as const, perGameRateSatang: 5000, addedIds: ['x'] };
    expect(parseBillConfig(serializeBillConfig(c))).toEqual(c);
  });

  it('fills missing and invalid fields from the defaults', () => {
    const c = parseBillConfig(JSON.stringify({ model: 'buffet', hostFeeSatang: -5, roundingBaht: 3, capSatang: 100 }));
    expect(c).toEqual({ ...DEFAULT_BILL_CONFIG, model: 'buffet', capSatang: 100 });
  });

  it('drops invalid overrides and non-string ids', () => {
    const c = parseBillConfig(
      JSON.stringify({ addedIds: ['a', 3], overrides: [{ playerId: 'a', amountSatang: 100 }, { playerId: 'b', amountSatang: -1 }] })
    );
    expect(c!.addedIds).toEqual(['a']);
    expect(c!.overrides).toEqual([{ playerId: 'a', amountSatang: 100 }]);
  });

  it('withoutPerPerson clears added, removed and overrides only', () => {
    const c = { ...DEFAULT_BILL_CONFIG, hostFeeSatang: 1000, addedIds: ['a'], removedIds: ['b'], overrides: [{ playerId: 'c', amountSatang: 0 }] };
    expect(withoutPerPerson(c)).toEqual({ ...DEFAULT_BILL_CONFIG, hostFeeSatang: 1000 });
  });

  it('sanitizeForRoster drops ids not on the roster', () => {
    const c = { ...DEFAULT_BILL_CONFIG, addedIds: ['a', 'gone'], removedIds: ['gone'], overrides: [{ playerId: 'gone', amountSatang: 1 }] };
    expect(sanitizeForRoster(c, ['a'])).toEqual({ ...DEFAULT_BILL_CONFIG, addedIds: ['a'] });
  });
});
```

Run: `npx vitest run src/sessions/bill-config.spec.ts` → FAIL (module missing).

- [ ] **Step 2: Implement**

```ts
// server/src/sessions/bill-config.ts
/**
 * The only place Session.billConfig is parsed or written. Tolerant on read:
 * a malformed column reads as null and a bad field reads as its default, so
 * a stored value can never break GET /bill (same stance as court-formats.ts).
 * Strict validation of new input happens in SetBillConfigDto and the engine.
 */
import {
  BILL_MODELS,
  DEFAULT_BILL_CONFIG,
  ROUNDING_STEPS,
  SPLIT_MODES,
  type BillConfig,
  type BillOverride,
} from '../../../engines/bill.ts';

const MAX = 2147483647;
const isMoney = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX;
const pick = <T>(v: unknown, ok: (x: unknown) => boolean, fallback: T): T => (ok(v) ? (v as T) : fallback);
const nullableMoney = (v: unknown, fallback: number | null): number | null =>
  v === null ? null : isMoney(v) ? v : fallback;
const ids = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x !== ''))] : [];

export function parseBillConfig(raw: string | null): BillConfig | null {
  if (raw === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const d = DEFAULT_BILL_CONFIG;
  const seen = new Set<string>();
  const overrides: BillOverride[] = [];
  if (Array.isArray(o['overrides'])) {
    for (const x of o['overrides']) {
      const e = x as Partial<BillOverride> | null;
      if (e && typeof e.playerId === 'string' && e.playerId !== '' && isMoney(e.amountSatang) && !seen.has(e.playerId)) {
        seen.add(e.playerId);
        overrides.push({ playerId: e.playerId, amountSatang: e.amountSatang });
      }
    }
  }
  return {
    model: pick(o['model'], (x) => (BILL_MODELS as readonly unknown[]).includes(x), d.model),
    courtFeeSatang: nullableMoney(o['courtFeeSatang'], d.courtFeeSatang),
    courtSplit: pick(o['courtSplit'], (x) => (SPLIT_MODES as readonly unknown[]).includes(x), d.courtSplit),
    shuttleSplit: pick(o['shuttleSplit'], (x) => (SPLIT_MODES as readonly unknown[]).includes(x), d.shuttleSplit),
    perGameRateSatang: pick(o['perGameRateSatang'], isMoney, d.perGameRateSatang),
    entryFeeSatang: pick(o['entryFeeSatang'], isMoney, d.entryFeeSatang),
    capSatang: nullableMoney(o['capSatang'], d.capSatang),
    buffetPriceSatang: pick(o['buffetPriceSatang'], isMoney, d.buffetPriceSatang),
    buffetShuttlesIncluded: pick(o['buffetShuttlesIncluded'], (x) => typeof x === 'boolean', d.buffetShuttlesIncluded),
    hostFeeSatang: pick(o['hostFeeSatang'], isMoney, d.hostFeeSatang),
    walkInFeeSatang: pick(o['walkInFeeSatang'], isMoney, d.walkInFeeSatang),
    roundingBaht: pick(o['roundingBaht'], (x) => (ROUNDING_STEPS as readonly unknown[]).includes(x), d.roundingBaht),
    addedIds: ids(o['addedIds']),
    removedIds: ids(o['removedIds']),
    overrides,
  };
}

export function serializeBillConfig(c: BillConfig): string {
  return JSON.stringify(c);
}

/** For prefilling a new session from the previous one: rates and toggles carry over, people don't. */
export function withoutPerPerson(c: BillConfig): BillConfig {
  return { ...c, addedIds: [], removedIds: [], overrides: [] };
}

export function sanitizeForRoster(c: BillConfig, rosterIds: string[]): BillConfig {
  const on = new Set(rosterIds);
  return {
    ...c,
    addedIds: c.addedIds.filter((id) => on.has(id)),
    removedIds: c.removedIds.filter((id) => on.has(id)),
    overrides: c.overrides.filter((o) => on.has(o.playerId)),
  };
}
```

- [ ] **Step 3: Run tests** — `npx vitest run src/sessions/bill-config.spec.ts` → PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/sessions/bill-config.ts server/src/sessions/bill-config.spec.ts
git commit -m "feat(server): tolerant billConfig parse/serialize with prefill and roster sanitize (C3)"
```

---

### Task 5: Bill API — `GET /sessions/:code/bill`, `POST /sessions/:code/bill-config`

**Files:**
- Create: `server/src/sessions/dto/set-bill-config.dto.ts`, `server/src/sessions/bill.service.ts`, `server/src/sessions/bill.controller.ts`
- Modify: `server/src/sessions/sessions.module.ts`
- Test: `server/src/sessions/bill.controller.spec.ts` (append `describe('bill')`)

**Interfaces:**
- Consumes: `computeBill`, `BillConfig`, `BillResult`, constants from `engines/bill.ts`; Task 4 helpers; `teamPlayers` from `./pairing-teams.js`; `SessionRoster.walkIn`, `Session.billConfig`.
- Produces (web Task 6 mirrors this exactly):

```ts
export interface BillResponse {
  session: { code: string; date: string | null; venue: string | null; endedAt: string | null;
             shuttleCount: number | null; shuttlePriceSatang: number | null };
  config: BillConfig;
  configSource: 'saved' | 'previous' | 'default';
  players: { playerId: string; name: string; games: number; walkIn: boolean }[]; // whole roster, games desc then name
  result: BillResult;
}
```

`POST /bill-config` body = full `BillConfig` (full replace), returns the recomputed `BillResponse` (201). 400 `BILL_PLAYER_NOT_ON_ROSTER` if any added/removed/override id isn't on the roster; 400 `BILL_CONFIG_INVALID` for duplicate override ids.

- [ ] **Step 1: Append failing tests**

```ts
  describe('bill', () => {
    const baseConfig = {
      model: 'fair', courtFeeSatang: 20000, courtSplit: 'equal', shuttleSplit: 'byGames',
      perGameRateSatang: 0, entryFeeSatang: 0, capSatang: null, buffetPriceSatang: 0,
      buffetShuttlesIncluded: true, hostFeeSatang: 0, walkInFeeSatang: 2000, roundingBaht: 1,
      addedIds: [], removedIds: [], overrides: [],
    };

    it('returns defaults and an empty bill before anyone finished a match', async () => {
      const { sessionCode, cleanup } = await fixture(4);
      try {
        const res = await request(server).get(`/sessions/${sessionCode}/bill`).expect(200);
        expect(res.body.configSource).toBe('default');
        expect(res.body.config.walkInFeeSatang).toBe(2000);
        expect(res.body.result.rows).toEqual([]);
        expect(res.body.players).toHaveLength(4);
      } finally {
        await cleanup();
      }
    });

    it('bills only confirmed + finished matches and applies the walk-in fee', async () => {
      const { sessionCode, players, finishMatch, cleanup } = await fixture(6);
      try {
        const ids = players.slice(0, 4).map((p) => p.id);
        await finishMatch(ids, 1);
        // pending (unconfirmed) and active (unfinished) must not count
        await prisma.pairing.create({ data: { sessionId: sessionCode, courtNumber: 1, matchNumber: 2,
          teamA: JSON.stringify([players[4].id]), teamB: JSON.stringify([players[5].id]) } });
        await prisma.pairing.create({ data: { sessionId: sessionCode, courtNumber: 1, matchNumber: 3,
          teamA: JSON.stringify([players[4].id]), teamB: JSON.stringify([players[5].id]), confirmedAt: new Date() } });
        await prisma.sessionRoster.update({
          where: { sessionId_playerId: { sessionId: sessionCode, playerId: ids[3] } }, data: { walkIn: true },
        });
        const res = await request(server).post(`/sessions/${sessionCode}/bill-config`).send(baseConfig).expect(201);
        expect(res.body.configSource).toBe('saved');
        const amounts = Object.fromEntries(res.body.result.rows.map((r: { playerId: string; amountSatang: number }) => [r.playerId, r.amountSatang]));
        const regular = Math.min(...Object.values(amounts) as number[]);
        expect(Object.keys(amounts).sort()).toEqual([...ids].sort());
        expect(amounts[ids[3]] - regular).toBe(2000);
        expect(res.body.result.totals.collectedSatang).toBe(20000);
        const again = await request(server).get(`/sessions/${sessionCode}/bill`).expect(200);
        expect(again.body.config.courtFeeSatang).toBe(20000);
      } finally {
        await cleanup();
      }
    });

    it('prefills from the previous session without per-person entries', async () => {
      const { groupCode, sessionCode, players, cleanup } = await fixture(4);
      try {
        await prisma.session.update({ where: { code: sessionCode }, data: {
          createdAt: new Date(Date.now() - 86400000),
          billConfig: JSON.stringify({ ...baseConfig, hostFeeSatang: 1000, addedIds: [players[0].id] }),
        } });
        const next = randomUUID();
        await prisma.session.create({ data: { code: next, groupId: groupCode, courtCount: 1, rawImportText: '' } });
        const res = await request(server).get(`/sessions/${next}/bill`).expect(200);
        expect(res.body.configSource).toBe('previous');
        expect(res.body.config.hostFeeSatang).toBe(1000);
        expect(res.body.config.addedIds).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it('works after the session ended; rejects off-roster ids and bad bodies', async () => {
      const { sessionCode, cleanup } = await fixture(4);
      try {
        await prisma.session.update({ where: { code: sessionCode }, data: { endedAt: new Date() } });
        await request(server).post(`/sessions/${sessionCode}/bill-config`).send(baseConfig).expect(201);
        const off = await request(server).post(`/sessions/${sessionCode}/bill-config`)
          .send({ ...baseConfig, addedIds: ['stranger'] }).expect(400);
        expect(off.body.code).toBe('BILL_PLAYER_NOT_ON_ROSTER');
        await request(server).post(`/sessions/${sessionCode}/bill-config`).send({ ...baseConfig, hostFeeSatang: -1 }).expect(400);
        await request(server).post(`/sessions/${sessionCode}/bill-config`).send({ ...baseConfig, model: 'free' }).expect(400);
        await request(server).post(`/sessions/${sessionCode}/bill-config`).send({ ...baseConfig, roundingBaht: 3 }).expect(400);
      } finally {
        await cleanup();
      }
    });

    it('ignores a stale saved id for a player no longer on the roster', async () => {
      const { sessionCode, cleanup } = await fixture(4);
      try {
        await prisma.session.update({ where: { code: sessionCode }, data: {
          billConfig: JSON.stringify({ ...baseConfig, addedIds: ['gone'] }),
        } });
        const res = await request(server).get(`/sessions/${sessionCode}/bill`).expect(200);
        expect(res.body.config.addedIds).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it('404s for an unknown session', async () => {
      await request(server).get(`/sessions/${randomUUID()}/bill`).expect(404);
    });
  });
```

Run: `npx vitest run src/sessions/bill.controller.spec.ts` → FAIL (routes 404).

- [ ] **Step 2: DTO**

```ts
// server/src/sessions/dto/set-bill-config.dto.ts
import { Type } from 'class-transformer';
import {
  ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsString, Max, Min, MinLength, ValidateIf, ValidateNested,
} from 'class-validator';
import {
  BILL_MODELS, ROUNDING_STEPS, SPLIT_MODES, type BillModel, type RoundingStep, type SplitMode,
} from '../../../../engines/bill.ts';

const MAX = 2147483647;

export class BillOverrideDto {
  @IsString() @MinLength(1) playerId!: string;
  @IsInt() @Min(0) @Max(MAX) amountSatang!: number;
}

/** Full replace — every field required. Nullable fields must be present as null. */
export class SetBillConfigDto {
  @IsIn(BILL_MODELS) model!: BillModel;
  @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) @Max(MAX) courtFeeSatang!: number | null;
  @IsIn(SPLIT_MODES) courtSplit!: SplitMode;
  @IsIn(SPLIT_MODES) shuttleSplit!: SplitMode;
  @IsInt() @Min(0) @Max(MAX) perGameRateSatang!: number;
  @IsInt() @Min(0) @Max(MAX) entryFeeSatang!: number;
  @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) @Max(MAX) capSatang!: number | null;
  @IsInt() @Min(0) @Max(MAX) buffetPriceSatang!: number;
  @IsBoolean() buffetShuttlesIncluded!: boolean;
  @IsInt() @Min(0) @Max(MAX) hostFeeSatang!: number;
  @IsInt() @Min(0) @Max(MAX) walkInFeeSatang!: number;
  @IsIn(ROUNDING_STEPS) roundingBaht!: RoundingStep;
  @IsArray() @ArrayUnique() @IsString({ each: true }) @MinLength(1, { each: true }) addedIds!: string[];
  @IsArray() @ArrayUnique() @IsString({ each: true }) @MinLength(1, { each: true }) removedIds!: string[];
  @IsArray() @ValidateNested({ each: true }) @Type(() => BillOverrideDto) overrides!: BillOverrideDto[];
}
```

- [ ] **Step 3: Service + controller + module**

```ts
// server/src/sessions/bill.service.ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { computeBill, DEFAULT_BILL_CONFIG, type BillConfig, type BillResult } from '../../../engines/bill.ts';
import { parseBillConfig, sanitizeForRoster, serializeBillConfig, withoutPerPerson } from './bill-config.js';
import { teamPlayers } from './pairing-teams.js';
import type { SetBillConfigDto } from './dto/set-bill-config.dto.js';

export interface BillResponse {
  session: {
    code: string; date: string | null; venue: string | null; endedAt: Date | null;
    shuttleCount: number | null; shuttlePriceSatang: number | null;
  };
  config: BillConfig;
  configSource: 'saved' | 'previous' | 'default';
  players: { playerId: string; name: string; games: number; walkIn: boolean }[];
  result: BillResult;
}

/**
 * C3 per-person bill. Stores inputs only (Session.billConfig); the bill is
 * recomputed on every read by engines/bill.ts. Owner-only by the global
 * guards; allowed after the session ends. The walk-in mark itself is written
 * by SessionsService.setRosterWalkIn (a roster fact, under the session lock).
 */
@Injectable()
export class BillService {
  constructor(private readonly prisma: PrismaService) {}

  async getBill(code: string): Promise<BillResponse> {
    const session = await this.prisma.session.findUnique({
      where: { code },
      include: { roster: { include: { player: { select: { name: true } } } } },
    });
    if (!session) throw new NotFoundException({ code: 'SESSION_NOT_FOUND' });
    const rosterIds = session.roster.map((r) => r.playerId);

    let config = parseBillConfig(session.billConfig);
    let configSource: BillResponse['configSource'] = 'saved';
    if (config === null) {
      const previous = await this.prisma.session.findFirst({
        where: { groupId: session.groupId, code: { not: code }, billConfig: { not: null }, createdAt: { lt: session.createdAt } },
        orderBy: { createdAt: 'desc' },
        select: { billConfig: true },
      });
      const prev = parseBillConfig(previous?.billConfig ?? null);
      config = prev ? withoutPerPerson(prev) : DEFAULT_BILL_CONFIG;
      configSource = prev ? 'previous' : 'default';
    }
    config = sanitizeForRoster(config, rosterIds);

    const pairings = await this.prisma.pairing.findMany({
      where: { sessionId: code, confirmedAt: { not: null }, endedAt: { not: null } },
      orderBy: [{ courtNumber: 'asc' }, { matchNumber: 'asc' }],
    });
    const matches = pairings.map((p) => ({ players: teamPlayers(p) }));
    const result = computeBill({
      config,
      matches,
      walkInIds: session.roster.filter((r) => r.walkIn).map((r) => r.playerId),
      shuttleCount: session.shuttleCount,
      shuttlePriceSatang: session.shuttlePriceSatang,
    });

    const games = new Map<string, number>();
    for (const m of matches) for (const id of m.players) games.set(id, (games.get(id) ?? 0) + 1);
    const players = session.roster
      .map((r) => ({ playerId: r.playerId, name: r.player.name, games: games.get(r.playerId) ?? 0, walkIn: r.walkIn }))
      .sort((a, b) => b.games - a.games || a.name.localeCompare(b.name, 'th'));

    return {
      session: {
        code: session.code, date: session.date, venue: session.venue, endedAt: session.endedAt,
        shuttleCount: session.shuttleCount, shuttlePriceSatang: session.shuttlePriceSatang,
      },
      config,
      configSource,
      players,
      result,
    };
  }

  async setBillConfig(code: string, dto: SetBillConfigDto): Promise<BillResponse> {
    const session = await this.prisma.session.findUnique({ where: { code }, include: { roster: { select: { playerId: true } } } });
    if (!session) throw new NotFoundException({ code: 'SESSION_NOT_FOUND' });
    const on = new Set(session.roster.map((r) => r.playerId));
    const referenced = [...dto.addedIds, ...dto.removedIds, ...dto.overrides.map((o) => o.playerId)];
    if (referenced.some((id) => !on.has(id))) throw new BadRequestException({ code: 'BILL_PLAYER_NOT_ON_ROSTER' });
    const overrideIds = dto.overrides.map((o) => o.playerId);
    if (new Set(overrideIds).size !== overrideIds.length) throw new BadRequestException({ code: 'BILL_CONFIG_INVALID' });
    const config: BillConfig = {
      ...dto,
      overrides: dto.overrides.map((o) => ({ playerId: o.playerId, amountSatang: o.amountSatang })),
    };
    await this.prisma.session.update({ where: { code }, data: { billConfig: serializeBillConfig(config) } });
    return this.getBill(code);
  }
}
```

(`setBillConfig` is a single full-replace write, so it needs no session lock — last write wins, and no other write reads `billConfig`.)

```ts
// server/src/sessions/bill.controller.ts
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { BillService } from './bill.service.js';
import { SetBillConfigDto } from './dto/set-bill-config.dto.js';

/** Owner-only (no @Public): money never reaches the display or a co-host. */
@Controller('sessions')
export class BillController {
  constructor(private readonly billService: BillService) {}

  @Get(':code/bill')
  getBill(@Param('code') code: string) {
    return this.billService.getBill(code);
  }

  @Post(':code/bill-config')
  setBillConfig(@Param('code') code: string, @Body() dto: SetBillConfigDto) {
    return this.billService.setBillConfig(code, dto);
  }
}
```

`sessions.module.ts`: `controllers: [SessionsController, BillController]`, `providers: [SessionsService, BillService]`.

- [ ] **Step 4: Run tests**

Run (from `server/`): `npx vitest run src/sessions/bill.controller.spec.ts src/auth/auth.boundary.spec.ts`, then `npm test` and `npm run lint` → all PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/sessions
git commit -m "feat(server): bill API with previous-session prefill (C3)"
```

---

### Task 6: Web — bill types + Thai LINE text builder

**Files:**
- Create: `web/src/app/core/bill.model.ts`, `web/src/app/core/bill-text.ts`
- Test: `web/src/app/core/bill-text.spec.ts`

**Interfaces:**
- Consumes: Task 5 `BillResponse` shape (JSON: `endedAt` is `string | null`).
- Produces: `bill.model.ts` exporting `BillModel`, `SplitMode`, `RoundingStep`, `BillOverride`, `BillConfig`, `BillRow`, `BillResult`, `BillResponse` (field-for-field copies of the engine/server types); `formatBaht(satang: number): string`; `buildBillText(bill: BillResponse): string`.

Template (always Thai; spec §C3). Lines, in order, each only when relevant:
1. `💰 ค่าก๊วน {date}{ — venue}` (date/venue omitted when null)
2. fair: `ค่าคอร์ท {court}฿ หารเท่า {billedCount} คน` or `ค่าคอร์ท {court}฿ ตามจำนวนเกม`
3. fair, or buffet ลูกแยก: `ค่าลูก {count} ลูก × {price}฿ หารเท่า` / `… ตามจำนวนเกม` (skipped if count or price null)
4. perGame: `เกมละ {rate}฿` + ` (+ค่าเข้า {entry}฿` if entry>0 + `, สูงสุด {cap}฿` if cap + `)`; buffet: `บุฟเฟ่ต์ {price}฿/คน (รวมลูก)` or `(ลูกแยก)`
5. `ค่าจัดก๊วน {hostFee}฿/คน (รวมในยอดแล้ว)` if hostFee>0
6. `Walk-in +{fee}฿/คน × {walkInCount} คน (หารคืนทุกคน)` if fee>0 and walkInCount>0
7. one line per billed row, in `players` order: `{name}  {games} เกม  {amount}฿` + ` (walk-in)` if row.walkIn
8. `รวม {collected}฿`

- [ ] **Step 1: Write failing tests**

```ts
// web/src/app/core/bill-text.spec.ts
import { buildBillText, formatBaht } from './bill-text';
import type { BillResponse, BillRow } from './bill.model';

const row = (playerId: string, games: number, amountSatang: number, walkIn = false): BillRow => ({
  playerId, games, status: 'billed', added: false, walkIn, courtSatang: 0, shuttleSatang: 0, baseSatang: 0,
  hostFeeSatang: 0, walkInFeeSatang: walkIn ? 2000 : 0, walkInDiscountSatang: 0, overridden: false, amountSatang,
});

function bill(overrides: Partial<BillResponse['config']> = {}): BillResponse {
  return {
    session: { code: 's', date: 'อ. 22 ก.ย.', venue: 'สนาม A', endedAt: null, shuttleCount: 18, shuttlePriceSatang: 8500 },
    config: {
      model: 'fair', courtFeeSatang: 144000, courtSplit: 'equal', shuttleSplit: 'byGames', perGameRateSatang: 0,
      entryFeeSatang: 0, capSatang: null, buffetPriceSatang: 0, buffetShuttlesIncluded: true, hostFeeSatang: 1000,
      walkInFeeSatang: 2000, roundingBaht: 1, addedIds: [], removedIds: [], overrides: [], ...overrides,
    },
    configSource: 'saved',
    players: [
      { playerId: 'p', name: 'ปอม', games: 9, walkIn: false },
      { playerId: 'b', name: 'บอย', games: 5, walkIn: true },
    ],
    result: {
      rows: [row('b', 5, 21000, true), row('p', 9, 22500)],
      totals: { collectedSatang: 43500, costSatang: null, marginSatang: null, billedCount: 2, walkInCount: 1 },
      warnings: [],
    },
  };
}

describe('formatBaht', () => {
  it('adds thousands separators and keeps satang only when non-zero', () => {
    expect(formatBaht(144000)).toBe('1,440');
    expect(formatBaht(8550)).toBe('85.50');
    expect(formatBaht(0)).toBe('0');
  });

  it('handles a negative margin', () => {
    expect(formatBaht(-1500)).toBe('-15');
  });
});

describe('buildBillText', () => {
  it('fair pay with host fee and one walk-in', () => {
    expect(buildBillText(bill())).toBe(
      [
        '💰 ค่าก๊วน อ. 22 ก.ย. — สนาม A',
        'ค่าคอร์ท 1,440฿ หารเท่า 2 คน',
        'ค่าลูก 18 ลูก × 85฿ ตามจำนวนเกม',
        'ค่าจัดก๊วน 10฿/คน (รวมในยอดแล้ว)',
        'Walk-in +20฿/คน × 1 คน (หารคืนทุกคน)',
        'ปอม  9 เกม  225฿',
        'บอย  5 เกม  210฿ (walk-in)',
        'รวม 435฿',
      ].join('\n')
    );
  });

  it('per game header with entry and cap; no shuttle line', () => {
    const text = buildBillText(bill({ model: 'perGame', perGameRateSatang: 5000, entryFeeSatang: 8000, capSatang: 30000, hostFeeSatang: 0 }));
    expect(text).toContain('เกมละ 50฿ (+ค่าเข้า 80฿, สูงสุด 300฿)');
    expect(text).not.toContain('ค่าลูก');
  });

  it('buffet included; walk-in line hidden when fee is 0', () => {
    const b = bill({ model: 'buffet', buffetPriceSatang: 18000, walkInFeeSatang: 0, hostFeeSatang: 0 });
    const text = buildBillText(b);
    expect(text).toContain('บุฟเฟ่ต์ 180฿/คน (รวมลูก)');
    expect(text).not.toContain('Walk-in');
  });

  it('omits removed rows and a missing venue', () => {
    const b = bill();
    b.session.venue = null;
    b.result.rows[0] = { ...b.result.rows[0], status: 'removed' };
    const text = buildBillText(b);
    expect(text.split('\n')[0]).toBe('💰 ค่าก๊วน อ. 22 ก.ย.');
    expect(text).not.toContain('บอย');
  });
});
```

Run (from `web/`): `npx ng test --include src/app/core/bill-text.spec.ts` (or `npm test`) → FAIL.

- [ ] **Step 2: Implement**

`bill.model.ts` — copy the `BillConfig`, `BillOverride`, `BillRow`, `BillResult` interfaces and the `BillModel`/`SplitMode`/`RoundingStep`/`BillWarning` unions verbatim from `engines/bill.ts` (types only, no constants), plus:

```ts
export interface BillResponse {
  session: { code: string; date: string | null; venue: string | null; endedAt: string | null;
             shuttleCount: number | null; shuttlePriceSatang: number | null };
  config: BillConfig;
  configSource: 'saved' | 'previous' | 'default';
  players: { playerId: string; name: string; games: number; walkIn: boolean }[];
  result: BillResult;
}
```

```ts
// web/src/app/core/bill-text.ts
import type { BillResponse } from './bill.model';

/**
 * 144000 -> "1,440"; 8550 -> "85.50"; -1500 -> "-15". Manual, so output never
 * depends on the runtime locale. Handles negatives (the margin line) correctly
 * regardless of Math.floor's toward-negative-infinity behavior.
 */
export function formatBaht(satang: number): string {
  const sign = satang < 0 ? '-' : '';
  const abs = Math.abs(satang);
  const baht = Math.floor(abs / 100);
  const rest = abs % 100;
  const whole = String(baht).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sign + (rest === 0 ? whole : `${whole}.${String(rest).padStart(2, '0')}`);
}

/** LINE group text. Always Thai regardless of UI locale (owner decision, C3). */
export function buildBillText(bill: BillResponse): string {
  const { session, config: c, result, players } = bill;
  const lines: string[] = [];
  lines.push(['💰 ค่าก๊วน', session.date, session.venue ? `— ${session.venue}` : null].filter(Boolean).join(' '));
  const shuttleLine = () => {
    if (session.shuttleCount === null || session.shuttlePriceSatang === null) return;
    const how = c.shuttleSplit === 'equal' ? 'หารเท่า' : 'ตามจำนวนเกม';
    lines.push(`ค่าลูก ${session.shuttleCount} ลูก × ${formatBaht(session.shuttlePriceSatang)}฿ ${how}`);
  };
  if (c.model === 'fair') {
    const court = formatBaht(c.courtFeeSatang ?? 0);
    lines.push(
      c.courtSplit === 'equal'
        ? `ค่าคอร์ท ${court}฿ หารเท่า ${result.totals.billedCount} คน`
        : `ค่าคอร์ท ${court}฿ ตามจำนวนเกม`
    );
    shuttleLine();
  } else if (c.model === 'perGame') {
    const extras = [
      c.entryFeeSatang > 0 ? `+ค่าเข้า ${formatBaht(c.entryFeeSatang)}฿` : null,
      c.capSatang !== null ? `สูงสุด ${formatBaht(c.capSatang)}฿` : null,
    ].filter(Boolean);
    lines.push(`เกมละ ${formatBaht(c.perGameRateSatang)}฿${extras.length ? ` (${extras.join(', ')})` : ''}`);
  } else {
    lines.push(`บุฟเฟ่ต์ ${formatBaht(c.buffetPriceSatang)}฿/คน (${c.buffetShuttlesIncluded ? 'รวมลูก' : 'ลูกแยก'})`);
    if (!c.buffetShuttlesIncluded) shuttleLine();
  }
  if (c.hostFeeSatang > 0) lines.push(`ค่าจัดก๊วน ${formatBaht(c.hostFeeSatang)}฿/คน (รวมในยอดแล้ว)`);
  if (c.walkInFeeSatang > 0 && result.totals.walkInCount > 0) {
    lines.push(`Walk-in +${formatBaht(c.walkInFeeSatang)}฿/คน × ${result.totals.walkInCount} คน (หารคืนทุกคน)`);
  }
  const byId = new Map(result.rows.filter((r) => r.status === 'billed').map((r) => [r.playerId, r]));
  for (const p of players) {
    const r = byId.get(p.playerId);
    if (!r) continue;
    lines.push(`${p.name}  ${r.games} เกม  ${formatBaht(r.amountSatang)}฿${r.walkIn ? ' (walk-in)' : ''}`);
  }
  lines.push(`รวม ${formatBaht(result.totals.collectedSatang)}฿`);
  return lines.join('\n');
}
```

- [ ] **Step 3: Run tests** → PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/app/core/bill.model.ts web/src/app/core/bill-text.ts web/src/app/core/bill-text.spec.ts
git commit -m "feat(web): bill types and Thai LINE text builder (C3)"
```

---

### Task 7: Web — bill page, route, summary link

**Files:**
- Create: `web/src/app/pages/session-bill/session-bill.ts`, `.html`, `.css`, `.spec.ts`
- Modify: `web/src/app/app.routes.ts` (before `'s/:sessionCode'`), `web/src/app/app.routes.spec.ts`
- Modify: `web/src/app/pages/session-summary/session-summary.html` (host-only block ~`:32-50`)
- Modify: `web/src/locale/messages.xlf`, `web/src/locale/messages.en.xlf`

**Interfaces:**
- Consumes: `BillResponse`, `BillConfig` (Task 6); `buildBillText` (Task 6); `copyToClipboard` from `core/share-link.ts`; `parseShuttlePriceInput`, `formatShuttlePriceInput` from `core/shuttle-money.ts` (generic baht↔satang, blank → null); `environment.apiBaseUrl`; routes `GET /sessions/:code/bill`, `POST /sessions/:code/bill-config`, `POST /sessions/:code/roster/:playerId/walk-in`.
- Produces: `SessionBill` component at `/s/:sessionCode/bill` (`adminGuard`).

Behaviour: load via GET. Every committed edit (`(change)` on text inputs = blur/enter; click on tabs/toggles/chips) POSTs `{ ...config, ...patch }` and replaces state with the returned `BillResponse`. Walk-in chip POSTs the roster route then re-GETs. Copy uses `buildBillText`; on clipboard failure show readonly textarea fallback (same pattern as `session-dashboard.ts:418-428`). Tabs use the accessible `.scope-toggle` form (`role="group"`, `aria-pressed`, as in `court-panel.html:6-11`). Chips use global `.chip` / `.selected`.

- [ ] **Step 1: Write failing component + route tests**

```ts
// web/src/app/pages/session-bill/session-bill.spec.ts
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { SessionBill } from './session-bill';
import { environment } from '../../../environments/environment';
import type { BillResponse } from '../../core/bill.model';

const B = environment.apiBaseUrl;

function response(): BillResponse {
  return {
    session: { code: 'sess1', date: null, venue: null, endedAt: null, shuttleCount: 0, shuttlePriceSatang: 0 },
    config: {
      model: 'fair', courtFeeSatang: 20000, courtSplit: 'equal', shuttleSplit: 'byGames', perGameRateSatang: 0,
      entryFeeSatang: 0, capSatang: null, buffetPriceSatang: 0, buffetShuttlesIncluded: true, hostFeeSatang: 0,
      walkInFeeSatang: 2000, roundingBaht: 1, addedIds: [], removedIds: [], overrides: [],
    },
    configSource: 'saved',
    players: [
      { playerId: 'a', name: 'Amp', games: 1, walkIn: false },
      { playerId: 'd', name: 'Dee', games: 1, walkIn: true },
      { playerId: 'z', name: 'Zed', games: 0, walkIn: false },
    ],
    result: {
      rows: [
        { playerId: 'a', games: 1, status: 'billed', added: false, walkIn: false, courtSatang: 10000, shuttleSatang: 0,
          baseSatang: 10000, hostFeeSatang: 0, walkInFeeSatang: 0, walkInDiscountSatang: 1000, overridden: false, amountSatang: 9000 },
        { playerId: 'd', games: 1, status: 'billed', added: false, walkIn: true, courtSatang: 10000, shuttleSatang: 0,
          baseSatang: 10000, hostFeeSatang: 0, walkInFeeSatang: 2000, walkInDiscountSatang: 1000, overridden: false, amountSatang: 11000 },
      ],
      totals: { collectedSatang: 20000, costSatang: 20000, marginSatang: 0, billedCount: 2, walkInCount: 1 },
      warnings: [],
    },
  };
}

describe('SessionBill', () => {
  let fixture: ComponentFixture<SessionBill>;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SessionBill],
      providers: [
        provideHttpClient(), provideHttpClientTesting(), provideRouter([]),
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ sessionCode: 'sess1' }) } } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(SessionBill);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  async function load(body = response()) {
    fixture.detectChanges();
    http.expectOne(`${B}/sessions/sess1/bill`).flush(body);
    await new Promise((r) => setTimeout(r, 0));
    fixture.detectChanges();
  }

  it('renders billed rows with amounts and the walk-in mark', async () => {
    await load();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Amp');
    expect(text).toContain('90');
    expect(text).toContain('110');
    const chip = fixture.nativeElement.querySelector('[data-walk-in="d"]') as HTMLButtonElement;
    expect(chip.getAttribute('aria-pressed')).toBe('true');
  });

  it('switching model posts the full config with the new model', async () => {
    await load();
    (fixture.nativeElement.querySelector('[data-model="buffet"]') as HTMLButtonElement).click();
    const req = http.expectOne(`${B}/sessions/sess1/bill-config`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body.model).toBe('buffet');
    expect(req.request.body.walkInFeeSatang).toBe(2000);
    req.flush(response());
  });

  it('toggling walk-in posts to the roster route then reloads the bill', async () => {
    await load();
    (fixture.nativeElement.querySelector('[data-walk-in="a"]') as HTMLButtonElement).click();
    const req = http.expectOne(`${B}/sessions/sess1/roster/a/walk-in`);
    expect(req.request.body).toEqual({ walkIn: true });
    req.flush({ playerId: 'a', walkIn: true });
    await new Promise((r) => setTimeout(r, 0));
    http.expectOne(`${B}/sessions/sess1/bill`).flush(response());
  });

  it('adding a roster player with no games posts addedIds', async () => {
    await load();
    (fixture.nativeElement.querySelector('[data-add="z"]') as HTMLButtonElement).click();
    const req = http.expectOne(`${B}/sessions/sess1/bill-config`);
    expect(req.request.body.addedIds).toEqual(['z']);
    req.flush(response());
  });

  it('rejects a malformed money entry without posting', async () => {
    await load();
    fixture.componentInstance['onMoney']('hostFeeSatang', '12.345');
    fixture.detectChanges();
    http.expectNone(`${B}/sessions/sess1/bill-config`);
    expect(fixture.nativeElement.querySelector('[role="alert"]')).not.toBeNull();
  });
});
```

Add to `app.routes.spec.ts` (signed-in block, and a signed-out redirect case mirroring the existing `/s/:sessionCode` one):

```ts
    it('/s/:sessionCode/bill resolves to SessionBill', async () => {
      const harness = await RouterTestingHarness.create();
      expect(await harness.navigateByUrl('/s/xyz789/bill', SessionBill)).toBeInstanceOf(SessionBill);
    });
```

with `import { SessionBill } from './pages/session-bill/session-bill';`. Run `npm test` (web) → FAIL.

- [ ] **Step 2: Route + summary link**

`app.routes.ts`, directly above `'s/:sessionCode'`:

```ts
  {
    // Before 's/:sessionCode' so the deeper path wins. Guarded: money is
    // host-only (the server routes are owner-only too).
    path: 's/:sessionCode/bill',
    canActivate: [adminGuard],
    loadComponent: () => import('./pages/session-bill/session-bill').then((m) => m.SessionBill),
  },
```

`session-summary.html`, inside the existing `@if (isHost())` shuttle-edit block, next to the shuttle-edit button:

```html
<a class="button ghost" [routerLink]="['/s', sessionCode, 'bill']" i18n="@@summary.billLink">คิดเงิน</a>
```

(`RouterLink` is already imported by `SessionSummary`; if the field is named differently than `sessionCode`, use that field.)

- [ ] **Step 3: Component**

```ts
// web/src/app/pages/session-bill/session-bill.ts
import { Component, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { BillConfig, BillModel, BillResponse, RoundingStep } from '../../core/bill.model';
import { buildBillText, formatBaht } from '../../core/bill-text';
import { copyToClipboard } from '../../core/share-link';
import { formatShuttlePriceInput, parseShuttlePriceInput } from '../../core/shuttle-money';

type MoneyField =
  | 'courtFeeSatang' | 'perGameRateSatang' | 'entryFeeSatang' | 'capSatang'
  | 'buffetPriceSatang' | 'hostFeeSatang' | 'walkInFeeSatang';
const NULLABLE: ReadonlySet<MoneyField> = new Set(['courtFeeSatang', 'capSatang']);

@Component({
  selector: 'app-session-bill',
  imports: [RouterLink],
  templateUrl: './session-bill.html',
  styleUrl: './session-bill.css',
})
export class SessionBill {
  private readonly http = inject(HttpClient);
  protected readonly sessionCode = inject(ActivatedRoute).snapshot.paramMap.get('sessionCode')!;
  private readonly base = `${environment.apiBaseUrl}/sessions/${this.sessionCode}`;

  protected readonly bill = signal<BillResponse | null>(null);
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly copied = signal(false);
  protected readonly clipboardFallback = signal<string | null>(null);

  protected readonly config = computed(() => this.bill()?.config ?? null);
  protected readonly names = computed(() => new Map((this.bill()?.players ?? []).map((p) => [p.playerId, p.name])));
  protected readonly walkIn = computed(() => new Map((this.bill()?.players ?? []).map((p) => [p.playerId, p.walkIn])));
  protected readonly billed = computed(() => {
    const rows = new Map((this.bill()?.result.rows ?? []).filter((r) => r.status === 'billed').map((r) => [r.playerId, r]));
    return (this.bill()?.players ?? []).filter((p) => rows.has(p.playerId)).map((p) => rows.get(p.playerId)!);
  });
  protected readonly removed = computed(() => (this.bill()?.result.rows ?? []).filter((r) => r.status === 'removed'));
  protected readonly addable = computed(() => {
    const inBill = new Set((this.bill()?.result.rows ?? []).map((r) => r.playerId));
    return (this.bill()?.players ?? []).filter((p) => !inBill.has(p.playerId));
  });
  protected readonly models: BillModel[] = ['fair', 'perGame', 'buffet'];
  protected readonly roundings: RoundingStep[] = [1, 5, 10];
  protected readonly baht = formatBaht;
  protected readonly moneyText = formatShuttlePriceInput;

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.bill.set(await firstValueFrom(this.http.get<BillResponse>(`${this.base}/bill`)));
    } catch {
      this.loadFailed.set(true);
    }
  }

  protected async save(patch: Partial<BillConfig>): Promise<void> {
    const current = this.config();
    if (!current) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      this.bill.set(
        await firstValueFrom(this.http.post<BillResponse>(`${this.base}/bill-config`, { ...current, ...patch }))
      );
    } catch {
      this.error.set($localize`:@@bill.saveFailed:บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง`);
    } finally {
      this.saving.set(false);
    }
  }

  protected onMoney(field: MoneyField, text: string): void {
    const parsed = parseShuttlePriceInput(text);
    if (!parsed.ok) {
      this.error.set($localize`:@@bill.badAmount:ใส่จำนวนเงินเป็นตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง`);
      return;
    }
    void this.save({ [field]: parsed.value ?? (NULLABLE.has(field) ? null : 0) });
  }

  protected onOverride(playerId: string, text: string): void {
    const c = this.config();
    if (!c) return;
    const rest = c.overrides.filter((o) => o.playerId !== playerId);
    if (text.trim() === '') {
      void this.save({ overrides: rest });
      return;
    }
    const parsed = parseShuttlePriceInput(text);
    if (!parsed.ok || parsed.value === null) {
      this.error.set($localize`:@@bill.badAmount:ใส่จำนวนเงินเป็นตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง`);
      return;
    }
    void this.save({ overrides: [...rest, { playerId, amountSatang: parsed.value }] });
  }

  protected overrideText(playerId: string): string {
    const o = this.config()?.overrides.find((x) => x.playerId === playerId);
    return o ? formatShuttlePriceInput(o.amountSatang) : '';
  }

  protected add(playerId: string): void {
    const c = this.config()!;
    void this.save({ addedIds: [...c.addedIds, playerId], removedIds: c.removedIds.filter((id) => id !== playerId) });
  }

  protected remove(playerId: string): void {
    const c = this.config()!;
    if (c.addedIds.includes(playerId)) void this.save({ addedIds: c.addedIds.filter((id) => id !== playerId) });
    else void this.save({ removedIds: [...c.removedIds, playerId] });
  }

  protected restore(playerId: string): void {
    const c = this.config()!;
    void this.save({ removedIds: c.removedIds.filter((id) => id !== playerId) });
  }

  protected async toggleWalkIn(playerId: string): Promise<void> {
    this.error.set(null);
    try {
      await firstValueFrom(
        this.http.post(`${this.base}/roster/${playerId}/walk-in`, { walkIn: !this.walkIn().get(playerId) })
      );
      await this.load();
    } catch {
      this.error.set($localize`:@@bill.saveFailed:บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง`);
    }
  }

  protected async copy(): Promise<void> {
    const b = this.bill();
    if (!b) return;
    const text = buildBillText(b);
    this.clipboardFallback.set(null);
    if (await copyToClipboard(text)) {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } else {
      this.error.set($localize`:@@share.failed:คัดลอกไม่ได้ ลองเลือกข้อความเอง`);
      this.clipboardFallback.set(text);
    }
  }
}
```

```html
<!-- web/src/app/pages/session-bill/session-bill.html -->
<a class="back" [routerLink]="['/s', sessionCode, 'summary']" i18n="@@bill.back">← กลับไปสรุปก๊วน</a>
<h1 i18n="@@bill.title">คิดเงิน</h1>

@if (loadFailed()) {
  <p role="alert" i18n="@@bill.loadFailed">โหลดไม่สำเร็จ ลองรีเฟรช</p>
}
@if (error(); as e) {
  <p role="alert" class="error">{{ e }}</p>
}

@if (bill(); as b) {
  @if (b.configSource === 'previous') {
    <p class="hint" i18n="@@bill.prefilled">ใช้ค่าจากก๊วนครั้งก่อน</p>
  }

  <div class="scope-toggle" role="group" i18n-aria-label="@@bill.modeGroup" aria-label="รูปแบบการคิดเงิน">
    @for (m of models; track m) {
      <button type="button" [attr.data-model]="m" [class.active]="b.config.model === m"
        [attr.aria-pressed]="b.config.model === m" [disabled]="saving()" (click)="save({ model: m })">
        @switch (m) {
          @case ('fair') { <ng-container i18n="@@bill.modelFair">หารตามจริง</ng-container> }
          @case ('perGame') { <ng-container i18n="@@bill.modelPerGame">คิดต่อเกม</ng-container> }
          @case ('buffet') { <ng-container i18n="@@bill.modelBuffet">บุฟเฟ่ต์</ng-container> }
        }
      </button>
    }
  </div>

  <section class="form-card inputs">
    <label>
      <span i18n="@@bill.courtFee">ค่าคอร์ททั้งหมด (บาท)</span>
      <input type="text" inputmode="decimal" autocomplete="off" placeholder="—"
        [value]="moneyText(b.config.courtFeeSatang)" (change)="onMoney('courtFeeSatang', $any($event.target).value)" />
    </label>
    @if (b.config.model === 'fair') {
      <div class="split-row">
        <span i18n="@@bill.courtSplit">ค่าคอร์ท</span>
        <button type="button" class="chip" [class.selected]="b.config.courtSplit === 'equal'" (click)="save({ courtSplit: 'equal' })" i18n="@@bill.splitEqual">หารเท่า</button>
        <button type="button" class="chip" [class.selected]="b.config.courtSplit === 'byGames'" (click)="save({ courtSplit: 'byGames' })" i18n="@@bill.splitByGames">ตามเกม</button>
      </div>
    }
    @if (b.config.model === 'fair' || (b.config.model === 'buffet' && !b.config.buffetShuttlesIncluded)) {
      <div class="split-row">
        <span i18n="@@bill.shuttleSplit">ค่าลูก</span>
        <button type="button" class="chip" [class.selected]="b.config.shuttleSplit === 'equal'" (click)="save({ shuttleSplit: 'equal' })" i18n="@@bill.splitEqual">หารเท่า</button>
        <button type="button" class="chip" [class.selected]="b.config.shuttleSplit === 'byGames'" (click)="save({ shuttleSplit: 'byGames' })" i18n="@@bill.splitByGames">ตามเกม</button>
      </div>
    }
    @if (b.config.model === 'perGame') {
      <label><span i18n="@@bill.perGameRate">เกมละ (บาท)</span>
        <input type="text" inputmode="decimal" [value]="moneyText(b.config.perGameRateSatang)" (change)="onMoney('perGameRateSatang', $any($event.target).value)" /></label>
      <label><span i18n="@@bill.entryFee">ค่าเข้า (บาท)</span>
        <input type="text" inputmode="decimal" [value]="moneyText(b.config.entryFeeSatang)" (change)="onMoney('entryFeeSatang', $any($event.target).value)" /></label>
      <label><span i18n="@@bill.cap">สูงสุดต่อคน (บาท, เว้นว่าง = ไม่จำกัด)</span>
        <input type="text" inputmode="decimal" placeholder="—" [value]="moneyText(b.config.capSatang)" (change)="onMoney('capSatang', $any($event.target).value)" /></label>
    }
    @if (b.config.model === 'buffet') {
      <label><span i18n="@@bill.buffetPrice">บุฟเฟ่ต์ต่อคน (บาท)</span>
        <input type="text" inputmode="decimal" [value]="moneyText(b.config.buffetPriceSatang)" (change)="onMoney('buffetPriceSatang', $any($event.target).value)" /></label>
      <div class="split-row">
        <button type="button" class="chip" [class.selected]="b.config.buffetShuttlesIncluded" (click)="save({ buffetShuttlesIncluded: true })" i18n="@@bill.shuttlesIncluded">รวมลูก</button>
        <button type="button" class="chip" [class.selected]="!b.config.buffetShuttlesIncluded" (click)="save({ buffetShuttlesIncluded: false })" i18n="@@bill.shuttlesSeparate">ลูกแยก</button>
      </div>
    }
    <label><span i18n="@@bill.hostFee">ค่าจัดก๊วนต่อคน (บาท)</span>
      <input type="text" inputmode="decimal" [value]="moneyText(b.config.hostFeeSatang)" (change)="onMoney('hostFeeSatang', $any($event.target).value)" /></label>
    <label><span i18n="@@bill.walkInFee">ค่า walk-in ต่อคน (บาท, หารคืนทุกคน)</span>
      <input type="text" inputmode="decimal" [value]="moneyText(b.config.walkInFeeSatang)" (change)="onMoney('walkInFeeSatang', $any($event.target).value)" /></label>
    <div class="split-row">
      <span i18n="@@bill.rounding">ปัดขึ้น</span>
      @for (r of roundings; track r) {
        <button type="button" class="chip" [class.selected]="b.config.roundingBaht === r" (click)="save({ roundingBaht: r })">{{ r }}฿</button>
      }
    </div>
  </section>

  @for (w of b.result.warnings; track w) {
    <p class="warning" role="status">
      @switch (w) {
        @case ('MISSING_SHUTTLE_COUNT') { <ng-container i18n="@@bill.warnShuttleCount">ยังไม่ได้ใส่จำนวนลูก</ng-container> }
        @case ('MISSING_SHUTTLE_PRICE') { <ng-container i18n="@@bill.warnShuttlePrice">ยังไม่ได้ใส่ราคาลูก</ng-container> }
        @case ('MISSING_COURT_FEE') { <ng-container i18n="@@bill.warnCourtFee">ยังไม่ได้ใส่ค่าคอร์ท</ng-container> }
      }
    </p>
  }

  <ul class="bill-rows">
    @for (r of billed(); track r.playerId) {
      <li>
        <span class="name">{{ names().get(r.playerId) }}</span>
        <span class="games" i18n="@@bill.games">{{ r.games }} เกม</span>
        <span class="amount">{{ baht(r.amountSatang) }}฿</span>
        <button type="button" class="chip" [attr.data-walk-in]="r.playerId" [class.selected]="walkIn().get(r.playerId)"
          [attr.aria-pressed]="walkIn().get(r.playerId) ?? false" (click)="toggleWalkIn(r.playerId)">walk-in</button>
        <input type="text" inputmode="decimal" class="override" i18n-placeholder="@@bill.overridePlaceholder" placeholder="แก้ยอด"
          i18n-aria-label="@@bill.overrideLabel" aria-label="แก้ยอดเอง"
          [value]="overrideText(r.playerId)" (change)="onOverride(r.playerId, $any($event.target).value)" />
        <button type="button" class="ghost" (click)="remove(r.playerId)" i18n="@@bill.remove">ไม่คิด</button>
      </li>
    }
  </ul>

  @if (removed().length > 0) {
    <h2 i18n="@@bill.removedTitle">ไม่คิดเงิน</h2>
    @for (r of removed(); track r.playerId) {
      <button type="button" class="chip" (click)="restore(r.playerId)">{{ names().get(r.playerId) }} ↺</button>
    }
  }
  @if (addable().length > 0) {
    <h2 i18n="@@bill.addTitle">เพิ่มคนที่ยังไม่ได้เล่น</h2>
    @for (p of addable(); track p.playerId) {
      <button type="button" class="chip" [attr.data-add]="p.playerId" (click)="add(p.playerId)">+ {{ p.name }}</button>
    }
  }

  <p class="total"><span i18n="@@bill.total">รวม</span> {{ baht(b.result.totals.collectedSatang) }}฿</p>
  @if (b.result.totals.marginSatang !== null) {
    <p class="margin" i18n="@@bill.margin">ต้นทุน {{ baht(b.result.totals.costSatang!) }}฿ · ส่วนต่าง {{ baht(b.result.totals.marginSatang) }}฿ (เห็นเฉพาะผู้จัด)</p>
  }

  <button type="button" class="primary" (click)="copy()">
    @if (copied()) { <ng-container i18n="@@bill.copied">คัดลอกแล้ว</ng-container> }
    @else { <ng-container i18n="@@bill.copy">คัดลอกข้อความ</ng-container> }
  </button>
  @if (clipboardFallback(); as t) {
    <textarea class="clipboard-fallback" readonly [value]="t" i18n-aria-label="@@share.fallbackLabel" aria-label="ข้อความสำหรับคัดลอก"></textarea>
  }
}
```

`session-bill.css`: rows as a grid, every button/input `min-height: 44px`; reuse tokens (`--space-*`, `--ink-soft`, `--text-xs`) as in `session-dashboard.css`; `.margin` in `--ink-soft`. No new colors.

- [ ] **Step 4: i18n**

Run (from `web/`): `npx ng extract-i18n --output-path src/locale` to refresh `messages.xlf`, then add English `<target>`s for every new `bill.*` id and `summary.billLink` in `messages.en.xlf` (e.g. `คิดเงิน` → `Bill`, `หารตามจริง` → `Actual cost`, `คิดต่อเกม` → `Per game`, `บุฟเฟ่ต์` → `Buffet`, `ค่า walk-in ต่อคน (บาท, หารคืนทุกคน)` → `Walk-in fee per person (฿, shared back to everyone)`, `ปัดขึ้น` → `Round up`, `ไม่คิด` → `Exclude`, `คัดลอกข้อความ` → `Copy text`). `npm run build` must succeed with no missing-translation warnings for the new ids.

- [ ] **Step 5: Run tests**

Run (from `web/`): `npm test` → PASS; `npm run build` → OK.

- [ ] **Step 6: Commit**

```bash
git add web/src
git commit -m "feat(web): host bill page with walk-in toggle and LINE copy (C3)"
```

---

### Task 8: End-to-end check in the running app

**Files:** none (verification only; fix-forward commits if something breaks).

- [ ] **Step 1:** Root `npm test` → engines + server + web all PASS. `npm --prefix server run lint` clean.
- [ ] **Step 2:** Start server (`cd server && npm run start:dev`) and web (`cd web && npm start`). Sign in as a host, create a session from a pasted LINE roster, confirm + finish two matches, add a walk-in via "+ เพิ่มคน".
- [ ] **Step 3:** Open summary → "คิดเงิน". Check: walk-in chip on for the added player; enter court fee 200 with four billed players and walk-in fee 20 → 45/45/45/65; switch to คิดต่อเกม and บุฟเฟ่ต์, totals change sensibly; toggle a LINE player walk-in on → fee applied, total unchanged; remove + restore a player; override one amount; margin line appears once shuttle count/price + court fee are set.
- [ ] **Step 4:** Copy → paste into a text editor; matches the template (Thai, `(walk-in)` suffix, `รวม`).
- [ ] **Step 5:** End the session; reopen bill; edit still saves. Sign in as a different host → `/s/<code>/bill` API returns 404. Switch UI to `/en/` → labels English, copied text still Thai.
- [ ] **Step 6:** Create a second session in the same group → bill opens with "ใช้ค่าจากก๊วนครั้งก่อน" and the previous rates, no added/removed/overrides.

---

### Task 9: Docs

**Files:**
- Modify: `docs/2026-09-21-feature-review-and-roadmap.md` (C3 heading → `#### - [x] C3. Per-person bill, copied out as text — done`)
- Modify: `docs/superpowers/specs/2026-09-22-roadmap-c-series-design.md` (status line: C3 built; §C3 API → `POST /bill-config`, `POST /roster/:playerId/walk-in`; `computeBill(input: BillInput)`; overrides as array; dashboard walk-in badge cut with the reason; prefill note under C10: "billConfig slice shipped with C3")
- Modify: `docs/overview.md` (end-session paragraph: drop "Nothing is calculated from them yet"; add a short "Bill (C3)" section: inputs-only storage + recompute, three models, cost parts redistribute removed shares / price parts don't, walk-in fee redistributed not host profit, always-Thai copy text, owner-only and editable after end)

- [ ] **Step 1:** Make the edits above. Do **not** archive the spec (other C-items still open).
- [ ] **Step 2:** Commit

```bash
git add docs
git commit -m "docs: mark C3 done, record bill design deviations and overview"
```

Then use superpowers:finishing-a-development-branch (merge/PR decision). Deploy is a separate step: per memory, check for undeployed migrations **before** rebuilding on the home server (this branch adds one).

---

## Self-review (done)

- Spec coverage: three models + toggles (T1), common: games rule (T5 filter), add/remove/override (T1, T7), host fee (T1), walk-in D7 (T2, T3), rounding (T1/T2), margin host-only (T1, T7 — never in text, T6), missing shuttle warning (T1), data inputs-only (T3/T4), API owner-only (T3/T5 + boundary spec), UI tabs/inputs/table/margin/copy (T7), text template (T6), prefill (T5), tests list (T1/T2/T5). Gap-free.
- Types consistent: `BillConfig`/`BillRow`/`BillResult`/`BillResponse` names and fields identical across T1, T4, T5, T6, T7; `setRosterWalkIn` / `SetRosterWalkInDto` T3 only; `teamPlayers` import verified exported from `pairing-teams.ts`.
- Review Focus lines each map to a test (T5 unfinished matches + stale id; T1 empty + singles; T2 floor/all-walk-ins).
