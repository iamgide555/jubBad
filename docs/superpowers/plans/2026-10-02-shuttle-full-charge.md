# ตามลูกแบด Full Per-Player Charge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "แชร์ตามต้นทุน / คิดเต็มต่อคน" switch inside the ตามลูกแบด bill model (each player pays a host-set charge for every distinct shuttle they touched), and put the shuttle count and price fields on the bill page.

**Architecture:** Two new `BillConfig` fields (`shuttleCharge`, `perPlayerShuttleSatang`) stored in the existing `Session.billConfig` JSON (no migration). `engines/bill.ts` and `engines/checkout.ts` price the `full` case as a rate-based model (no cost-credit logic). The bill page saves count/price through the existing `shuttle-details` route and the switch through the existing `bill-config` route.

**Tech Stack:** TypeScript engines (node:test), NestJS + Prisma + vitest (server), Angular 22 signals + vitest (web).

**Spec:** `docs/superpowers/specs/2026-10-02-shuttle-full-charge-design.md`

## Global Constraints

- Branch `feat/shuttle-full-charge` (cut from `main`); never commit to `main`.
- `shared` behavior is byte-for-byte unchanged; every existing test must still pass without edits to its expectations (only fixtures gain the two new config fields).
- `full`: `amount = ceilTo(startingFee + touched x charge + hostFee, step) + walkInAdjustment`, where `touched` = distinct shuttle ids across the player's finished games and `charge = perPlayerShuttleSatang ?? shuttlePriceSatang`.
- Money is integer satang; the engine throws on bad input (`perPlayerShuttleSatang` negative or fractional, unknown `shuttleCharge`).
- `UNKNOWN_SHUTTLE_USE` and `MISSING_SHUTTLE_PRICE` behave as today; a missing charge+price with shuttles used is a warning, never a silent zero.
- The margin line is unchanged: collected minus (court fee + physical count x real price). The charge never enters the cost.
- No database migration. `bill-config.ts` stays tolerant on read: missing/invalid new fields read as `'shared'` / `null`.
- The bill-config DTO must declare both new fields (the ValidationPipe whitelist drops unknown keys) and keep them optional on input so an old open tab still saves.
- Thai-first UI; English added by hand to `web/src/locale/messages.en.xlf` (leave `messages.xlf` alone); translatable strings carry no interpolation.
- The LINE text never prints the margin.
- Server tests run serially (`fileParallelism: false`); do not change that.

## Review Focus

1. Bills saved before this change (no new fields) read as `shared`/`null` and their amounts do not move (Task 2, `bill-config.spec.ts`; Task 1 shared-unchanged test).
2. An old open web tab that posts a config without the new fields still saves (Task 2, route test).
3. Shuttles used but no charge and no shuttle price: warning on the bill, blocked quote at checkout, never a silent 0 (Tasks 1, 2).
4. `full` with someone already checked out: the leaver stays frozen, nobody else's amount moves, and no excess-credit/uncovered-cost warning appears (Task 1).
5. A removed player under `full` is not billed and nobody absorbs their share (Task 1); changing the switch or charge makes an open early-checkout quote stale (Task 2).

---

### Task 1: Engines (bill + early-checkout pricing)

**Files:**
- Modify: `engines/bill.ts`
- Modify: `engines/checkout.ts`
- Test: `engines/bill.test.ts`, `engines/checkout.test.ts`

**Interfaces:**
- Consumes: existing `computeBill`, `computeCheckoutPreview`, `BillMatch`.
- Produces: `SHUTTLE_CHARGES`, `ShuttleCharge`; `BillConfig.shuttleCharge`, `BillConfig.perPlayerShuttleSatang`; `distinctShuttlesFor(playerId: string, matches: BillMatch[]): number`; defaults `'shared'` / `null` in `DEFAULT_BILL_CONFIG`.

- [ ] **Step 1: Write the failing bill tests**

Append to `engines/bill.test.ts`:

```ts
// ---- perShuttle + full: each player pays the whole charge per distinct shuttle ----

const sm = (players: string[], shuttleIds: string[] | null): BillMatch => ({ players, shuttleIds });
const FULL: Partial<BillConfig> = {
  model: 'perShuttle',
  shuttleCharge: 'full',
  startingFeeSatang: 1000,
  hostFeeSatang: 500,
};
// a plays game 1 (shuttle s1) and game 2 (s3 and s4); everyone else plays one game.
const FULL_GAMES: BillMatch[] = [sm(['a', 'b', 'c', 'd'], ['s1']), sm(['a', 'e', 'f', 'g'], ['s3', 's4'])];

test('perShuttle full: pays the charge for every distinct shuttle the player touched', () => {
  const r = computeBill(input({ ...FULL, perPlayerShuttleSatang: 8000 }, { matches: FULL_GAMES, shuttlePriceSatang: 5000 }));
  const got = amounts(r);
  assert.equal(got.a, 1000 + 3 * 8000 + 500);
  assert.equal(got.b, 1000 + 8000 + 500);
  assert.equal(got.e, 1000 + 2 * 8000 + 500);
});

test('perShuttle full: a shuttle reused across a player\'s own games is charged once', () => {
  const games = [sm(['a', 'b', 'c', 'd'], ['s1']), sm(['a', 'e', 'f', 'g'], ['s1'])];
  const got = amounts(computeBill(input({ ...FULL, perPlayerShuttleSatang: 8000 }, { matches: games, shuttlePriceSatang: 5000 })));
  assert.equal(got.a, 1000 + 8000 + 500);
  assert.equal(got.b, 1000 + 8000 + 500);
});

test('perShuttle full: a blank charge follows the session shuttle price', () => {
  const got = amounts(computeBill(input({ ...FULL, perPlayerShuttleSatang: null }, { matches: FULL_GAMES, shuttlePriceSatang: 5000 })));
  assert.equal(got.b, 1000 + 5000 + 500);
  assert.equal(got.a, 1000 + 3 * 5000 + 500);
});

test('perShuttle shared: ignores the per-player charge entirely', () => {
  const extra = { matches: FULL_GAMES, shuttlePriceSatang: 5000 };
  const base = amounts(computeBill(input({ model: 'perShuttle', startingFeeSatang: 1000 }, extra)));
  const withCharge = amounts(computeBill(input({ model: 'perShuttle', startingFeeSatang: 1000, perPlayerShuttleSatang: 99900 }, extra)));
  assert.deepEqual(withCharge, base);
});

test('perShuttle full: a game with unknown shuttle use warns', () => {
  const games = [sm(['a', 'b', 'c', 'd'], ['s1']), sm(['a', 'e', 'f', 'g'], null)];
  const r = computeBill(input({ ...FULL, perPlayerShuttleSatang: 8000 }, { matches: games, shuttlePriceSatang: 5000 }));
  assert.ok(r.warnings.includes('UNKNOWN_SHUTTLE_USE'));
});

test('perShuttle full: shuttles used with no charge and no price warns and bills no shuttle money', () => {
  const r = computeBill(input({ ...FULL, perPlayerShuttleSatang: null }, { matches: FULL_GAMES, shuttlePriceSatang: null }));
  assert.ok(r.warnings.includes('MISSING_SHUTTLE_PRICE'));
  assert.equal(amounts(r).a, 1000 + 500);
});

test('perShuttle full: a settled leaver is frozen and nobody else\'s amount moves', () => {
  const cfg = { ...FULL, perPlayerShuttleSatang: 8000 };
  const extra = { matches: FULL_GAMES, shuttlePriceSatang: 5000 };
  const without = amounts(computeBill(input(cfg, extra)));
  const withSettled = computeBill(
    input(cfg, {
      ...extra,
      settled: [
        {
          id: 'r1', playerId: 'a', model: 'perShuttle', amountSatang: 25500, settledAt: '2026-10-01T10:00:00Z',
          walkInFeeSatang: 0, walkInDiscountSatang: 0, startingFeeSatang: 1000,
        },
      ],
    })
  );
  const { a: _leaver, ...others } = without;
  assert.deepEqual(amounts(withSettled), others);
  assert.equal(withSettled.totals.settledTotalSatang, 25500);
  assert.equal(withSettled.totals.excessCreditSatang, 0);
  assert.equal(withSettled.totals.uncoveredCostSatang, 0);
});

test('perShuttle full: a removed player is not billed and nobody absorbs their share', () => {
  const cfg = { ...FULL, perPlayerShuttleSatang: 8000 };
  const extra = { matches: FULL_GAMES, shuttlePriceSatang: 5000 };
  const base = amounts(computeBill(input(cfg, extra)));
  const removed = amounts(computeBill(input({ ...cfg, removedIds: ['e'] }, extra)));
  const { e: _gone, ...rest } = base;
  assert.equal(removed.e, undefined);
  assert.deepEqual(removed, rest);
});

test('perShuttle full: the margin compares collected with the real shuttle cost, not the charge', () => {
  const r = computeBill(
    input({ ...FULL, perPlayerShuttleSatang: 8000, courtFeeSatang: 10000 }, { matches: FULL_GAMES, shuttleCount: 4, shuttlePriceSatang: 5000 })
  );
  assert.equal(r.totals.costSatang, 10000 + 4 * 5000);
  assert.equal(r.totals.marginSatang, r.totals.collectedSatang - 30000);
});

test('perShuttle full: bad config values fail loudly', () => {
  assert.throws(() => computeBill(input({ ...FULL, shuttleCharge: 'bogus' as never })), /shuttleCharge/);
  assert.throws(() => computeBill(input({ ...FULL, perPlayerShuttleSatang: -1 })), /perPlayerShuttleSatang/);
  assert.throws(() => computeBill(input({ ...FULL, perPlayerShuttleSatang: 10.5 })), /perPlayerShuttleSatang/);
});
```

- [ ] **Step 2: Write the failing checkout tests**

Append to `engines/checkout.test.ts`:

```ts
// ---- perShuttle + full ----

test('perShuttle full: charges the player for every distinct shuttle they touched', () => {
  const r = computeCheckoutPreview(
    input(
      { matches: [game(['p', 'a', 'b', 'c'], ['s1']), game(['p', 'd', 'e', 'f'], ['s3', 's4'])], shuttlePriceSatang: 5000 },
      { shuttleCharge: 'full', perPlayerShuttleSatang: 8000, startingFeeSatang: 1000 }
    )
  );
  assert.equal(r.breakdown.shuttleSatang, 3 * 8000);
  assert.equal(r.amountSatang, 1000 + 24000);
});

test('perShuttle full: a shuttle reused across the player\'s games is charged once', () => {
  const r = computeCheckoutPreview(
    input(
      { matches: [game(['p', 'a', 'b', 'c'], ['s1']), game(['p', 'd', 'e', 'f'], ['s1'])], shuttlePriceSatang: 5000 },
      { shuttleCharge: 'full', perPlayerShuttleSatang: 8000 }
    )
  );
  assert.equal(r.breakdown.shuttleSatang, 8000);
});

test('perShuttle full: a blank charge follows the session shuttle price', () => {
  const r = computeCheckoutPreview(
    input(
      { matches: [game(['p', 'a', 'b', 'c'], ['s1']), game(['p', 'd', 'e', 'f'], ['s3'])], shuttlePriceSatang: 5000 },
      { shuttleCharge: 'full', perPlayerShuttleSatang: null }
    )
  );
  assert.equal(r.breakdown.shuttleSatang, 2 * 5000);
});

test('perShuttle full: still blocked by unknown use and by a missing charge+price', () => {
  assert.throws(
    () => computeCheckoutPreview(input({ matches: [game(['p', 'a', 'b', 'c'], null)] }, { shuttleCharge: 'full', perPlayerShuttleSatang: 8000 })),
    (e: unknown) => e instanceof CheckoutBlockedError && e.code === 'UNKNOWN_SHUTTLE_USE'
  );
  assert.throws(
    () =>
      computeCheckoutPreview(
        input({ matches: [game(['p', 'a', 'b', 'c'], ['s1'])], shuttlePriceSatang: null }, { shuttleCharge: 'full', perPlayerShuttleSatang: null })
      ),
    (e: unknown) => e instanceof CheckoutBlockedError && e.code === 'MISSING_SHUTTLE_PRICE'
  );
  // An explicit charge needs no session price at all.
  const ok = computeCheckoutPreview(
    input({ matches: [game(['p', 'a', 'b', 'c'], ['s1'])], shuttlePriceSatang: null }, { shuttleCharge: 'full', perPlayerShuttleSatang: 8000 })
  );
  assert.equal(ok.breakdown.shuttleSatang, 8000);
});

test('perShuttle full: what earlier leavers paid does not change this quote', () => {
  const matches = [game(['p', 'a', 'b', 'c'], ['s1']), game(['d', 'e', 'f', 'g'], ['s1'])];
  const cfg = { shuttleCharge: 'full' as const, perPlayerShuttleSatang: 8000 };
  const alone = computeCheckoutPreview(input({ matches }, cfg));
  const afterLeaver = computeCheckoutPreview(
    input({ matches, otherSettled: [{ playerId: 'a', amountSatang: 9000, walkInFeeSatang: 0, walkInDiscountSatang: 0, startingFeeSatang: 0 }] }, cfg)
  );
  assert.equal(afterLeaver.amountSatang, alone.amountSatang);
});
```

If `SettledReceipt` in `engines/checkout.ts` names its fields differently from the literal above, adjust the literal to that interface (read `SettledReceipt` at the top of the file) and keep the assertion.

- [ ] **Step 3: Run both to verify they fail**

Run: `node --experimental-strip-types --test engines/bill.test.ts engines/checkout.test.ts`
Expected: the new `perShuttle full` / `perShuttle shared: ignores` tests FAIL (full is ignored, so amounts differ; `validate` does not throw); all older tests PASS.

- [ ] **Step 4: Implement the config and helper in `engines/bill.ts`**

After `export type SplitMode = ...` add:

```ts
export const SHUTTLE_CHARGES = ['shared', 'full'] as const;
export type ShuttleCharge = (typeof SHUTTLE_CHARGES)[number];
```

In `interface BillConfig`, after the `startingFeeSatang` line add:

```ts
  /**
   * perShuttle only. 'shared' splits the recorded shuttle cost over the games
   * and players that used it; 'full' charges each player the whole charge for
   * every distinct shuttle in their finished games.
   */
  shuttleCharge: ShuttleCharge;
  /** perShuttle + full only: what one player pays per shuttle. null follows the session's shuttle price. */
  perPlayerShuttleSatang: number | null;
```

In `DEFAULT_BILL_CONFIG`, after `startingFeeSatang: 0,` add:

```ts
  shuttleCharge: 'shared',
  perPlayerShuttleSatang: null,
```

After the `BillMatch` interface add:

```ts
/** Distinct shuttle ids across the games a player was in. A game with unknown use contributes none. */
export function distinctShuttlesFor(playerId: string, matches: BillMatch[]): number {
  const ids = new Set<string>();
  for (const match of matches) {
    if (!match.players.includes(playerId)) continue;
    for (const id of match.shuttleIds ?? []) ids.add(id);
  }
  return ids.size;
}
```

In `validate`, after the `ROUNDING_STEPS` check add:

```ts
  if (!SHUTTLE_CHARGES.includes(c.shuttleCharge)) throw new Error(`bill: unknown shuttleCharge ${c.shuttleCharge}`);
  assertMoney('perPlayerShuttleSatang', c.perPlayerShuttleSatang);
```

- [ ] **Step 5: Implement `full` in `computeBill`**

Run `grep -n "perShuttle" engines/bill.ts` first and confirm the only uses after the `const perShuttle = ...` line are the ones changed below plus the settled-credit block and the `base` branch (both stay as they are).

After `const perShuttle = config.model === 'perShuttle';` add:

```ts
  const fullCharge = perShuttle && config.shuttleCharge === 'full';
  // Blank charge follows the session shuttle price.
  const chargeSatang = config.perPlayerShuttleSatang ?? shuttlePriceSatang;
```

Replace the missing-price warning line inside `if (perShuttle) { ... }`:

```ts
    if (recordedIds.length > 0 && (fullCharge ? chargeSatang : shuttlePriceSatang) === null) warnings.push('MISSING_SHUTTLE_PRICE');
```

Replace the `const shuttle = perShuttle ? ... : ...` expression with:

```ts
  const shuttle = fullCharge
    ? new Map(billed.map((id) => [id, distinctShuttlesFor(id, matches) * (chargeSatang ?? 0)]))
    : perShuttle
      ? costShares(recordedCost, 'byGames', 'shuttle', participants, billed, games, matches, true)
      : shuttlesBilled
        ? costShares(shuttleTotal, config.shuttleSplit, 'shuttle', participants, billed, games, matches, allocation === 'identities')
        : new Map<string, number>();
```

Replace `const costModel = config.model === 'fair' || perShuttle;` with:

```ts
  // `full` is rate-based like perGame/buffet: nothing is derived from a total,
  // so a settled leaver stays frozen and no cost is re-covered from the others.
  const costModel = config.model === 'fair' || (perShuttle && !fullCharge);
```

- [ ] **Step 6: Implement `full` in `computeCheckoutPreview`**

Update the import from `./bill.ts` in `engines/checkout.ts` to also bring `distinctShuttlesFor` and `SHUTTLE_CHARGES`. In the money-validation list add `['perPlayerShuttleSatang', config.perPlayerShuttleSatang],` and directly after that loop add:

```ts
  if (!SHUTTLE_CHARGES.includes(config.shuttleCharge)) throw new Error(`checkout: unknown shuttleCharge ${config.shuttleCharge}`);
```

Replace the `if (pricesShuttles) { ... }` block with:

```ts
  const fullCharge = model === 'perShuttle' && config.shuttleCharge === 'full';
  // Blank charge follows the session shuttle price.
  const chargeSatang = config.perPlayerShuttleSatang ?? input.shuttlePriceSatang;
  let shuttleSatang = 0;
  if (pricesShuttles) {
    if (own.some((m) => !Array.isArray(m.shuttleIds))) throw new CheckoutBlockedError('UNKNOWN_SHUTTLE_USE');
    if (own.some((m) => (m.shuttleIds ?? []).length > 0)) {
      if (fullCharge) {
        if (chargeSatang === null) throw new CheckoutBlockedError('MISSING_SHUTTLE_PRICE');
        shuttleSatang = distinctShuttlesFor(playerId, matches) * chargeSatang;
      } else {
        if (input.shuttlePriceSatang === null) throw new CheckoutBlockedError('MISSING_SHUTTLE_PRICE');
        shuttleSatang = shuttleShare(input, input.shuttlePriceSatang);
      }
    }
  }
```

(and delete the old `let shuttleSatang = 0;` line directly above the old block so it is declared once).

- [ ] **Step 7: Run the engine suite**

Run: `npm run test:engines`
Expected: PASS, including every older test unmodified.

- [ ] **Step 8: Commit**

```bash
git add engines
git commit -m "feat(engines): full per-player shuttle charge inside perShuttle

Claude-Session: https://claude.ai/code/session_01148QYqWg8vZoaZsf9midX4"
```

---

### Task 2: Server (config, route, quote basis)

**Files:**
- Modify: `server/src/sessions/bill-config.ts`
- Modify: `server/src/sessions/dto/set-bill-config.dto.ts`
- Modify: `server/src/sessions/bill.service.ts`
- Modify: `server/src/sessions/checkout-quote.ts`
- Test: `server/src/sessions/bill-config.spec.ts`, `server/src/sessions/bill.controller.spec.ts`, `server/src/sessions/checkout.controller.spec.ts`

**Interfaces:**
- Consumes: Task 1 `SHUTTLE_CHARGES`, `ShuttleCharge`, `BillConfig` fields, `DEFAULT_BILL_CONFIG`.
- Produces: `CheckoutQuote.shuttleCharge: ShuttleCharge` and `CheckoutQuote.chargeSatang: number | null` (carried through to the preview response); `parseBillConfig` fills both new fields.

- [ ] **Step 1: Write the failing config tests**

In `server/src/sessions/bill-config.spec.ts`, inside the `describe`, add:

```ts
  it('a legacy config with no shuttle-charge fields reads as shared and follow-the-price', () => {
    const c = parseBillConfig(JSON.stringify({ model: 'perShuttle', startingFeeSatang: 1000 }))!;
    expect(c.shuttleCharge).toBe('shared');
    expect(c.perPlayerShuttleSatang).toBeNull();
  });

  it('round-trips full with an explicit charge', () => {
    const c = { ...DEFAULT_BILL_CONFIG, model: 'perShuttle' as const, shuttleCharge: 'full' as const, perPlayerShuttleSatang: 2000 };
    expect(parseBillConfig(serializeBillConfig(c))).toEqual(c);
  });

  it('an unknown switch or an invalid charge falls back instead of breaking the read', () => {
    const c = parseBillConfig(JSON.stringify({ shuttleCharge: 'bogus', perPlayerShuttleSatang: -5 }))!;
    expect(c.shuttleCharge).toBe('shared');
    expect(c.perPlayerShuttleSatang).toBeNull();
  });
```

- [ ] **Step 2: Write the failing bill route tests**

In `server/src/sessions/bill.controller.spec.ts`, inside `describe('shuttle bill and bill ready', ...)` (it already provides `night()`, whose `cfg()` deliberately omits the new fields), add:

```ts
    it('perShuttle full: bills each player the charge for every distinct shuttle they touched', async () => {
      const n = await night({ price: 5000 });
      try {
        const s1 = await n.shuttle(1);
        const s3 = await n.shuttle(3);
        const s4 = await n.shuttle(4);
        await n.game([0, 1, 2, 3], 1, [s1]);
        await n.game([0, 4, 5, 6], 2, [s3, s4]);
        await n.saveConfig({
          model: 'perShuttle', shuttleCharge: 'full', perPlayerShuttleSatang: 8000, startingFeeSatang: 1000, hostFeeSatang: 500,
        });
        const b = await n.bill();
        const amount = (i: number) => b.result.rows.find((r: { playerId: string }) => r.playerId === n.players[i].id).amountSatang;
        expect(amount(0)).toBe(1000 + 3 * 8000 + 500);
        expect(amount(1)).toBe(1000 + 8000 + 500);
        expect(amount(4)).toBe(1000 + 2 * 8000 + 500);
        expect(b.config).toMatchObject({ shuttleCharge: 'full', perPlayerShuttleSatang: 8000 });
      } finally {
        await n.cleanup();
      }
    });

    it('perShuttle full with a blank charge follows the session shuttle price', async () => {
      const n = await night({ price: 5000 });
      try {
        const s1 = await n.shuttle(1);
        await n.game([0, 1, 2, 3], 1, [s1]);
        await n.saveConfig({ model: 'perShuttle', shuttleCharge: 'full', perPlayerShuttleSatang: null, startingFeeSatang: 0 });
        const b = await n.bill();
        expect(b.result.rows.find((r: { playerId: string }) => r.playerId === n.players[0].id).amountSatang).toBe(5000);
        expect(b.config.perPlayerShuttleSatang).toBeNull();
      } finally {
        await n.cleanup();
      }
    });

    it('an old client that omits the new fields still saves, as shared', async () => {
      const n = await night();
      try {
        const res = await n.saveConfig({ model: 'perShuttle' });
        expect(res.body.config).toMatchObject({ shuttleCharge: 'shared', perPlayerShuttleSatang: null });
      } finally {
        await n.cleanup();
      }
    });

    it('rejects an unknown switch, a negative charge and a fractional charge', async () => {
      const n = await night();
      try {
        const post = (over: Record<string, unknown>) =>
          request(server).post(`/sessions/${n.sessionCode}/bill-config`).send(cfg({ model: 'perShuttle', ...over }));
        await post({ shuttleCharge: 'bogus' }).expect(400);
        await post({ perPlayerShuttleSatang: -1 }).expect(400);
        await post({ perPlayerShuttleSatang: 10.5 }).expect(400);
      } finally {
        await n.cleanup();
      }
    });
```

- [ ] **Step 3: Write the failing quote tests**

In `server/src/sessions/checkout.controller.spec.ts`, inside `describe('checkout preview', ...)`, add (the file's `cfg(over)` already builds a `perShuttle` config with a 2000 starting fee):

```ts
    it('full: quotes the charge per distinct shuttle and reports the basis', async () => {
      const f = await fixture(7, { config: cfg({ shuttleCharge: 'full', perPlayerShuttleSatang: 3000 }) });
      try {
        const [p, a, b, c, d, e, g] = f.players.map((x) => x.id);
        await f.finish([p, a, b, c], [1]);
        await f.finish([p, d, e, g], [2, 3]);
        const res = await f.preview(p, 'perShuttle').expect(201);
        expect(res.body).toMatchObject({
          amountSatang: 2000 + 3 * 3000, shuttleCharge: 'full', chargeSatang: 3000,
          breakdown: { baseSatang: 2000, shuttleSatang: 9000 },
        });
      } finally {
        await f.cleanup();
      }
    });

    it('full with a blank charge follows the session price and says so', async () => {
      const f = await fixture(4, { config: cfg({ shuttleCharge: 'full', perPlayerShuttleSatang: null }) });
      try {
        const [p, a, b, c] = f.players.map((x) => x.id);
        await f.finish([p, a, b, c], [1]);
        const res = await f.preview(p, 'perShuttle').expect(201);
        expect(res.body).toMatchObject({ amountSatang: 2000 + 12000, shuttleCharge: 'full', chargeSatang: 12000 });
      } finally {
        await f.cleanup();
      }
    });

    it('shared reports its basis with no charge', async () => {
      const f = await fixture(4);
      try {
        const [p, a, b, c] = f.players.map((x) => x.id);
        await f.finish([p, a, b, c], [1]);
        const res = await f.preview(p, 'perShuttle').expect(201);
        expect(res.body).toMatchObject({ shuttleCharge: 'shared', chargeSatang: null });
      } finally {
        await f.cleanup();
      }
    });

    it('full: a leaver does not move another player\'s quote', async () => {
      const f = await fixture(7, { config: cfg({ shuttleCharge: 'full', perPlayerShuttleSatang: 3000 }) });
      try {
        const [p, a, b, c, d, e, g] = f.players.map((x) => x.id);
        await f.finish([p, a, b, c], [1]);
        await f.finish([d, e, g, a], [2]);
        const before = (await f.preview(e, 'perShuttle').expect(201)).body.amountSatang;
        expect((await f.settle(p, 'perShuttle')).status).toBe(201);
        const after = (await f.preview(e, 'perShuttle').expect(201)).body.amountSatang;
        expect(after).toBe(before);
      } finally {
        await f.cleanup();
      }
    });

    it('changing the charge makes an open quote stale', async () => {
      const f = await fixture(4, { config: cfg({ shuttleCharge: 'full', perPlayerShuttleSatang: 3000 }) });
      try {
        const [p, a, b, c] = f.players.map((x) => x.id);
        await f.finish([p, a, b, c], [1]);
        const pv = await f.preview(p, 'perShuttle').expect(201);
        await prisma.session.update({
          where: { code: f.sessionCode },
          data: { billConfig: cfg({ shuttleCharge: 'full', perPlayerShuttleSatang: 4000 }) },
        });
        const res = await f.confirm(p, { model: 'perShuttle', snapshotHash: pv.body.snapshotHash, idempotencyKey: randomUUID() });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('CHECKOUT_STALE');
      } finally {
        await f.cleanup();
      }
    });
```

- [ ] **Step 4: Run them to verify they fail**

Run: `cd server && npx vitest run src/sessions/bill-config.spec.ts src/sessions/bill.controller.spec.ts src/sessions/checkout.controller.spec.ts`
Expected: FAIL (the config fields are dropped by the parser/DTO and the quote has no basis); the older tests PASS.

- [ ] **Step 5: Implement config parsing**

In `server/src/sessions/bill-config.ts` add `SHUTTLE_CHARGES` to the import from `../../../engines/bill.ts`, and in the object returned by `parseBillConfig`, after the `startingFeeSatang` line, add:

```ts
    shuttleCharge: pick(o['shuttleCharge'], (x) => (SHUTTLE_CHARGES as readonly unknown[]).includes(x), d.shuttleCharge),
    perPlayerShuttleSatang: nullableMoney(o['perPlayerShuttleSatang'], d.perPlayerShuttleSatang),
```

- [ ] **Step 6: Implement the DTO and service**

In `server/src/sessions/dto/set-bill-config.dto.ts`: add `IsOptional` to the class-validator import, add `SHUTTLE_CHARGES, type ShuttleCharge` to the engines import, and after the `startingFeeSatang` line add:

```ts
  // Optional on input so an old open tab that predates these fields still saves; absent means shared / follow-the-price.
  @IsOptional() @IsIn(SHUTTLE_CHARGES) shuttleCharge?: ShuttleCharge;
  @IsOptional() @IsInt() @Min(0) @Max(MAX) perPlayerShuttleSatang?: number | null;
```

In `server/src/sessions/bill.service.ts`, replace the `const config: BillConfig = { ...dto, overrides: ... };` literal with:

```ts
    const config: BillConfig = {
      ...dto,
      shuttleCharge: dto.shuttleCharge ?? 'shared',
      perPlayerShuttleSatang: dto.perPlayerShuttleSatang ?? null,
      overrides: dto.overrides.map((o) => ({ playerId: o.playerId, amountSatang: o.amountSatang })),
    };
```

- [ ] **Step 7: Implement the quote basis**

In `server/src/sessions/checkout-quote.ts`: add `type ShuttleCharge` to the import from `../../../engines/bill.ts`; extend `interface CheckoutQuote` with

```ts
  /** Which basis priced a perShuttle quote; 'shared' for every other model. */
  shuttleCharge: ShuttleCharge;
  /** The resolved charge per player per shuttle under 'full', else null. */
  chargeSatang: number | null;
```

and change the final `return { ...preview, ... }` so it also includes:

```ts
    shuttleCharge: model === 'perShuttle' ? config.shuttleCharge : 'shared',
    chargeSatang:
      model === 'perShuttle' && config.shuttleCharge === 'full' ? (config.perPlayerShuttleSatang ?? session.shuttlePriceSatang) : null,
```

If the preview route does not already return the quote object as is, make `checkout.service.ts`'s preview response include these two fields (Step 8 tells you).

- [ ] **Step 8: Run the server suite**

Run: `cd server && npx vitest run src/sessions/bill-config.spec.ts src/sessions/bill.controller.spec.ts src/sessions/checkout.controller.spec.ts`
Expected: PASS. If the new quote tests fail only because `shuttleCharge`/`chargeSatang` are missing from the response body, read how `CheckoutService.preview` shapes its return value and pass the two fields through.

Then run: `cd server && npm test && npm run lint`
Expected: PASS and clean. Fix any existing spec that builds a literal `BillConfig` without the two fields by adding `shuttleCharge: 'shared', perPlayerShuttleSatang: null` to that literal (no expectation changes).

- [ ] **Step 9: Commit**

```bash
git add server/src
git commit -m "feat(server): shuttle charge switch in bill config and checkout quote

Claude-Session: https://claude.ai/code/session_01148QYqWg8vZoaZsf9midX4"
```

---

### Task 3: Web (bill page, LINE text, checkout dialog)

**Files:**
- Modify: `web/src/app/core/bill.model.ts`
- Modify: `web/src/app/core/checkout.model.ts`
- Modify: `web/src/app/core/bill-text.ts`
- Modify: `web/src/app/pages/session-bill/session-bill.ts`
- Modify: `web/src/app/pages/session-bill/session-bill.html`
- Modify: `web/src/app/pages/session-dashboard/early-checkout-dialog/early-checkout-dialog.html`
- Modify: `web/src/locale/messages.en.xlf`
- Test: `web/src/app/core/bill-text.spec.ts`, `web/src/app/pages/session-bill/session-bill.spec.ts`, `web/src/app/pages/session-dashboard/early-checkout-dialog/early-checkout-dialog.spec.ts`

**Interfaces:**
- Consumes: Task 2 responses — `BillResponse.config.shuttleCharge`, `.perPlayerShuttleSatang`; `CheckoutPreview.shuttleCharge`, `.chargeSatang`; the existing `POST /sessions/:code/shuttle-details` (`{ shuttleCount?, shuttlePriceSatang? }`); `parseShuttleCountInput`, `parseShuttlePriceInput`, `formatShuttleCountInput`, `formatShuttlePriceInput` from `core/shuttle-money.ts`.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Types and fixtures**

In `web/src/app/core/bill.model.ts` add to `interface BillConfig`, after `startingFeeSatang`:

```ts
  /** perShuttle only: 'shared' splits the recorded shuttle cost; 'full' charges each player per distinct shuttle. */
  shuttleCharge: 'shared' | 'full';
  /** perShuttle + full only: charge per player per shuttle; null follows the session shuttle price. */
  perPlayerShuttleSatang: number | null;
```

In `web/src/app/core/checkout.model.ts` add to `interface CheckoutPreview`:

```ts
  /** Which basis priced a perShuttle quote (absent on older servers). */
  shuttleCharge?: 'shared' | 'full';
  /** The resolved charge per player per shuttle under 'full', else null. */
  chargeSatang?: number | null;
```

Then add `shuttleCharge: 'shared', perPlayerShuttleSatang: null,` right after `startingFeeSatang: 0,` (or the fixture's startingFee value) in the config literals of `web/src/app/pages/session-bill/session-bill.spec.ts` (`response()`) and `web/src/app/core/bill-text.spec.ts` (`bill()`); run `grep -rn "startingFeeSatang:" web/src --include=*.spec.ts` and fix any other literal the same way.

- [ ] **Step 2: Write the failing LINE text tests**

Append inside the final `describe` of `web/src/app/core/bill-text.spec.ts`:

```ts
  it('describes the full per-shuttle charge with an explicit charge', () => {
    const text = buildBillText(bill({ model: 'perShuttle', startingFeeSatang: 3000, shuttleCharge: 'full', perPlayerShuttleSatang: 2000 }));
    expect(text).toContain('ค่าเริ่มต้น 30฿/คน + ค่าลูก 20฿ ต่อลูกที่เล่น');
    expect(text).not.toContain('ตามที่ใช้จริง');
  });

  it('a blank full charge follows the shuttle price in the text', () => {
    const text = buildBillText(bill({ model: 'perShuttle', startingFeeSatang: 3000, shuttleCharge: 'full', perPlayerShuttleSatang: null }));
    expect(text).toContain('ค่าเริ่มต้น 30฿/คน + ค่าลูก 85฿ ต่อลูกที่เล่น');
  });
```

- [ ] **Step 3: Write the failing bill page tests**

In `web/src/app/pages/session-bill/session-bill.spec.ts`, inside `describe('early checkouts and the fourth model', ...)`:

1. Replace the test titled `perShuttle shows the starting fee input and points to the summary for the shuttle price` with:

```ts
    it('perShuttle shows the starting fee input and the switch, with no detour to the summary page', async () => {
      const b = advanced();
      b.config.model = 'perShuttle';
      await load(b);
      expect(el().querySelector('[data-starting-fee]')).toBeTruthy();
      expect(el().querySelector('[data-charge-mode="shared"]')).toBeTruthy();
      expect(el().querySelector('[data-charge-mode="full"]')).toBeTruthy();
      expect(el().querySelector('[data-per-shuttle-hint] a')).toBeNull();
    });
```

2. Add:

```ts
    it('the per-player charge field appears only under full, with the shuttle price as its placeholder', async () => {
      const b = advanced();
      b.config.model = 'perShuttle';
      b.session.shuttlePriceSatang = 8500;
      await load(b);
      expect(el().querySelector('[data-charge-input]')).toBeNull();

      const full = advanced();
      full.config.model = 'perShuttle';
      full.config.shuttleCharge = 'full';
      full.session.shuttlePriceSatang = 8500;
      fixture = TestBed.createComponent(SessionBill);
      await load(full);
      const input = el().querySelector('[data-charge-input]') as HTMLInputElement;
      expect(input.placeholder).toBe('85');
      expect(input.value).toBe('');
    });

    it('tapping the full switch posts the whole config with shuttleCharge full', async () => {
      const b = advanced();
      b.config.model = 'perShuttle';
      await load(b);
      (el().querySelector('[data-charge-mode="full"]') as HTMLButtonElement).click();
      const req = http.expectOne(`${B}/sessions/sess1/bill-config`);
      expect(req.request.body).toMatchObject({ model: 'perShuttle', shuttleCharge: 'full' });
      req.flush(b);
      await new Promise((r) => setTimeout(r, 0));
    });

    it('typing a charge posts it; clearing it posts null', async () => {
      const b = advanced();
      b.config.model = 'perShuttle';
      b.config.shuttleCharge = 'full';
      await load(b);
      const input = el().querySelector('[data-charge-input]') as HTMLInputElement;
      input.value = '20';
      input.dispatchEvent(new Event('change'));
      const set = http.expectOne(`${B}/sessions/sess1/bill-config`);
      expect(set.request.body).toMatchObject({ perPlayerShuttleSatang: 2000 });
      set.flush(b);
      await new Promise((r) => setTimeout(r, 0));

      input.value = '';
      input.dispatchEvent(new Event('change'));
      const cleared = http.expectOne(`${B}/sessions/sess1/bill-config`);
      expect(cleared.request.body.perPlayerShuttleSatang).toBeNull();
      cleared.flush(b);
      await new Promise((r) => setTimeout(r, 0));
    });

    it('the shuttle price and count fields save through shuttle-details, then re-read the bill', async () => {
      await load();
      const price = el().querySelector('[data-shuttle-price]') as HTMLInputElement;
      price.value = '85';
      price.dispatchEvent(new Event('change'));
      const post = http.expectOne(`${B}/sessions/sess1/shuttle-details`);
      expect(post.request.body).toEqual({ shuttlePriceSatang: 8500 });
      post.flush({});
      await new Promise((r) => setTimeout(r, 0));
      http.expectOne(`${B}/sessions/sess1/bill`).flush(response());
      await new Promise((r) => setTimeout(r, 0));

      const count = el().querySelector('[data-shuttle-count]') as HTMLInputElement;
      count.value = '12';
      count.dispatchEvent(new Event('change'));
      const countPost = http.expectOne(`${B}/sessions/sess1/shuttle-details`);
      expect(countPost.request.body).toEqual({ shuttleCount: 12 });
      countPost.flush({});
      await new Promise((r) => setTimeout(r, 0));
      http.expectOne(`${B}/sessions/sess1/bill`).flush(response());
      await new Promise((r) => setTimeout(r, 0));
    });
```

- [ ] **Step 4: Write the failing dialog test**

In `web/src/app/pages/session-dashboard/early-checkout-dialog/early-checkout-dialog.spec.ts`, add after the `switching the model re-quotes under that model` test:

```ts
  it('under the full basis the quote says so and shows the charge', async () => {
    live.previewCheckout.mockResolvedValue(quote({ model: 'perShuttle', shuttleCharge: 'full', chargeSatang: 2000 }));
    await openAndPick();
    const basis = el().querySelector('[data-charge-basis]');
    expect(basis).toBeTruthy();
    expect(basis!.textContent).toContain('20');
  });

  it('a shared-basis quote shows no basis label', async () => {
    live.previewCheckout.mockResolvedValue(quote({ model: 'perShuttle', shuttleCharge: 'shared', chargeSatang: null }));
    await openAndPick();
    expect(el().querySelector('[data-charge-basis]')).toBeNull();
  });
```

- [ ] **Step 5: Run the web tests to verify they fail**

Run: `cd web && npx ng test --watch=false --include='src/app/core/bill-text.spec.ts' --include='src/app/pages/session-bill/session-bill.spec.ts' --include='src/app/pages/session-dashboard/early-checkout-dialog/early-checkout-dialog.spec.ts'`
Expected: the new tests FAIL; no type errors (Step 1 added the fields).

- [ ] **Step 6: LINE text**

In `web/src/app/core/bill-text.ts` replace the `perShuttle` branch with:

```ts
  } else if (c.model === 'perShuttle') {
    if (c.shuttleCharge === 'full') {
      const charge = c.perPlayerShuttleSatang ?? session.shuttlePriceSatang;
      lines.push(`ค่าเริ่มต้น ${formatBaht(c.startingFeeSatang)}฿/คน + ค่าลูก${charge !== null ? ` ${formatBaht(charge)}฿` : ''} ต่อลูกที่เล่น`);
    } else {
      lines.push(`ค่าเริ่มต้น ${formatBaht(c.startingFeeSatang)}฿/คน + ค่าลูกตามที่ใช้จริง${session.shuttlePriceSatang !== null ? ` (${formatBaht(session.shuttlePriceSatang)}฿/ลูก)` : ''}`);
    }
  } else {
```

(keeping the existing `else { ...buffet... }` body that follows.)

- [ ] **Step 7: Bill page logic**

In `web/src/app/pages/session-bill/session-bill.ts`:

- Extend the imports: `import { formatShuttleCountInput, formatShuttlePriceInput, parseShuttleCountInput, parseShuttlePriceInput } from '../../core/shuttle-money';`
- Add `'perPlayerShuttleSatang'` to the `MoneyField` union and to the `NULLABLE` set.
- Add next to `moneyText`:

```ts
  protected readonly countText = formatShuttleCountInput;
```

- Add these members to the class:

```ts
  /** Placeholder for the count: the count the bill is using when none was typed (derived from the games). */
  protected readonly countPlaceholder = computed(() => {
    const n = this.bill()?.accounting.effectiveCount;
    return n === null || n === undefined ? '—' : String(n);
  });
  /** Placeholder for the per-player charge: blank follows the session shuttle price. */
  protected readonly chargePlaceholder = computed(() => {
    const p = this.bill()?.session.shuttlePriceSatang;
    return p === null || p === undefined ? '—' : formatShuttlePriceInput(p);
  });

  /** Count and price are session fields shared with the summary page; each edit sends only what changed. */
  private async saveShuttleDetails(patch: { shuttleCount?: number | null; shuttlePriceSatang?: number | null }): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    try {
      await firstValueFrom(this.http.post(`${this.base}/shuttle-details`, patch));
      await this.load();
    } catch {
      this.error.set($localize`:@@bill.shuttleDetailsFailed:บันทึกข้อมูลลูกแบดไม่สำเร็จ ลองใหม่อีกครั้ง`);
    } finally {
      this.saving.set(false);
    }
  }

  protected onShuttlePrice(text: string): void {
    const parsed = parseShuttlePriceInput(text);
    if (!parsed.ok) {
      this.error.set($localize`:@@bill.badAmount:ใส่จำนวนเงินเป็นตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง`);
      return;
    }
    void this.saveShuttleDetails({ shuttlePriceSatang: parsed.value });
  }

  protected onShuttleCount(text: string): void {
    const parsed = parseShuttleCountInput(text);
    if (!parsed.ok) {
      this.error.set($localize`:@@bill.badCount:ใส่จำนวนลูกเป็นเลขจำนวนเต็ม`);
      return;
    }
    void this.saveShuttleDetails({ shuttleCount: parsed.value });
  }
```

(`parseShuttleCountInput` returns the same `{ ok, value }` shape as `parseShuttlePriceInput`; confirm in `core/shuttle-money.ts` and adjust the field access if it differs.)

- [ ] **Step 8: Bill page template**

In `web/src/app/pages/session-bill/session-bill.html`:

1. Directly after the court-fee `setting-row` (before `@if (b.config.model === 'fair')`) add:

```html
      <div class="setting-row">
        <span class="setting-label" i18n="@@bill.shuttleCount">ลูกแบดที่นับจริง (ลูก)</span>
        <label class="money-field">
          <input type="text" inputmode="numeric" autocomplete="off" data-shuttle-count
            [placeholder]="countPlaceholder()" [value]="countText(b.session.shuttleCount)"
            (change)="onShuttleCount($any($event.target).value)" />
        </label>
      </div>
      <div class="setting-row">
        <span class="setting-label" i18n="@@bill.shuttlePrice">ราคาต่อลูก (บาท)</span>
        <label class="money-field">
          <input type="text" inputmode="decimal" autocomplete="off" placeholder="—" data-shuttle-price
            [value]="moneyText(b.session.shuttlePriceSatang)" (change)="onShuttlePrice($any($event.target).value)" />
          <span class="money-suffix">฿</span>
        </label>
      </div>
```

2. In the `@if (b.config.model === 'perShuttle') { ... }` block, replace the `<p class="hint" data-per-shuttle-hint>...</p>` element (the one holding the link to the summary) with:

```html
        <div class="setting-row">
          <span class="setting-label" i18n="@@bill.chargeMode">วิธีคิดค่าลูก</span>
          <div class="scope-toggle setting-toggle">
            <button type="button" data-charge-mode="shared" [class.active]="b.config.shuttleCharge === 'shared'"
              [attr.aria-pressed]="b.config.shuttleCharge === 'shared'" [disabled]="saving()"
              (click)="save({ shuttleCharge: 'shared' })" i18n="@@bill.chargeShared">แชร์ตามต้นทุน</button>
            <button type="button" data-charge-mode="full" [class.active]="b.config.shuttleCharge === 'full'"
              [attr.aria-pressed]="b.config.shuttleCharge === 'full'" [disabled]="saving()"
              (click)="save({ shuttleCharge: 'full' })" i18n="@@bill.chargeFull">คิดเต็มต่อคน</button>
          </div>
        </div>
        @if (b.config.shuttleCharge === 'full') {
          <div class="setting-row">
            <span class="setting-label" i18n="@@bill.chargePerPlayer">ค่าลูกต่อคนต่อลูก (บาท)</span>
            <label class="money-field">
              <input type="text" inputmode="decimal" data-charge-input [placeholder]="chargePlaceholder()"
                [value]="moneyText(b.config.perPlayerShuttleSatang)"
                (change)="onMoney('perPlayerShuttleSatang', $any($event.target).value)" />
              <span class="money-suffix">฿</span>
            </label>
          </div>
          <p class="hint" data-per-shuttle-hint i18n="@@bill.perShuttleFullHint">ผู้เล่นแต่ละคนจ่ายเต็มจำนวนต่อลูกที่ตัวเองได้เล่น ลูกเดิมที่ใช้ซ้ำนับครั้งเดียว เว้นว่าง = ใช้ราคาต่อลูกด้านบน</p>
        } @else {
          <p class="hint" data-per-shuttle-hint i18n="@@bill.perShuttleHint">คิดเฉพาะลูกแบดที่บันทึกไว้ในแมตช์ ตามราคาต่อลูก ไม่ขึ้นกับจำนวนลูกที่นับจริง</p>
        }
```

(The old `bill.perShuttleSetPrice` link message is no longer used; leave its xlf entry in place.)

- [ ] **Step 9: Checkout dialog label**

In `web/src/app/pages/session-dashboard/early-checkout-dialog/early-checkout-dialog.html`, directly above `<dl class="breakdown" data-breakdown>` add:

```html
          @if (!receipt() && preview()?.model === 'perShuttle' && preview()?.shuttleCharge === 'full') {
            <p class="muted" data-charge-basis>
              <ng-container i18n="@@checkout.fullBasis">คิดเต็มต่อคน</ng-container>
              @if (preview()?.chargeSatang != null) {
                · {{ baht(preview()!.chargeSatang!) }}฿ <ng-container i18n="@@checkout.perShuttleUnit">ต่อลูก</ng-container>
              }
            </p>
          }
```

- [ ] **Step 10: English translations**

Append to `web/src/locale/messages.en.xlf` before `</body>`:

```xml
      <trans-unit id="bill.shuttleCount" datatype="html">
        <source>ลูกแบดที่นับจริง (ลูก)</source>
        <target>Shuttles counted (pcs)</target>
      </trans-unit>
      <trans-unit id="bill.shuttlePrice" datatype="html">
        <source>ราคาต่อลูก (บาท)</source>
        <target>Price per shuttle (baht)</target>
      </trans-unit>
      <trans-unit id="bill.chargeMode" datatype="html">
        <source>วิธีคิดค่าลูก</source>
        <target>How shuttles are billed</target>
      </trans-unit>
      <trans-unit id="bill.chargeShared" datatype="html">
        <source>แชร์ตามต้นทุน</source>
        <target>Share the cost</target>
      </trans-unit>
      <trans-unit id="bill.chargeFull" datatype="html">
        <source>คิดเต็มต่อคน</source>
        <target>Full price per player</target>
      </trans-unit>
      <trans-unit id="bill.chargePerPlayer" datatype="html">
        <source>ค่าลูกต่อคนต่อลูก (บาท)</source>
        <target>Charge per player per shuttle (baht)</target>
      </trans-unit>
      <trans-unit id="bill.perShuttleFullHint" datatype="html">
        <source>ผู้เล่นแต่ละคนจ่ายเต็มจำนวนต่อลูกที่ตัวเองได้เล่น ลูกเดิมที่ใช้ซ้ำนับครั้งเดียว เว้นว่าง = ใช้ราคาต่อลูกด้านบน</source>
        <target>Each player pays the full amount for every shuttle they played with. A reused shuttle counts once. Leave blank to use the price per shuttle above.</target>
      </trans-unit>
      <trans-unit id="bill.shuttleDetailsFailed" datatype="html">
        <source>บันทึกข้อมูลลูกแบดไม่สำเร็จ ลองใหม่อีกครั้ง</source>
        <target>Couldn't save the shuttle details. Try again.</target>
      </trans-unit>
      <trans-unit id="bill.badCount" datatype="html">
        <source>ใส่จำนวนลูกเป็นเลขจำนวนเต็ม</source>
        <target>Enter the shuttle count as a whole number</target>
      </trans-unit>
      <trans-unit id="checkout.fullBasis" datatype="html">
        <source>คิดเต็มต่อคน</source>
        <target>Full price per player</target>
      </trans-unit>
      <trans-unit id="checkout.perShuttleUnit" datatype="html">
        <source>ต่อลูก</source>
        <target>per shuttle</target>
      </trans-unit>
```

(`bill.badAmount` and `bill.perShuttleHint` already exist; do not duplicate them. Run `grep -c 'id="bill.badAmount"' web/src/locale/messages.en.xlf` to confirm before saving.)

- [ ] **Step 11: Run the web suite and build**

Run: `cd web && npm test && npx ng build`
Expected: all PASS; the build emits no "No translation found" warning for any id added in Step 10.

- [ ] **Step 12: Commit**

```bash
git add web/src
git commit -m "feat(web): shuttle count/price and the full-charge switch on the bill page

Claude-Session: https://claude.ai/code/session_01148QYqWg8vZoaZsf9midX4"
```

---

### Task 4: Docs and the 50-player end-to-end run

**Files:**
- Modify: `docs/overview.md`
- Create: `server/test/shuttle-full-charge.e2e-spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing further.

- [ ] **Step 1: Docs**

In `docs/overview.md`, in the `### Bill (C3)` section, after the paragraph that begins "Three models, chosen per session", add:

```markdown
**ตามลูกแบด has a switch (advanced sessions only).** "แชร์ตามต้นทุน" (the
default) splits the recorded shuttle cost over the games and players that used
it. "คิดเต็มต่อคน" charges every player a host-set amount for each *distinct*
shuttle in their finished games: `startingFee + touched x charge + hostFee`,
rounded up to the step. The charge is deliberately a **separate number from the
real shuttle price**: in doubles every player in a game pays the whole charge,
so one shared number would make the host-only margin meaningless. The real
price (and the physical count) stay the cost side of the margin; a blank charge
follows the real price. `full` is rate-based like per-game and buffet, so an
early checkout freezes only the leaver and never changes anyone else's amount.
The settings live in `Session.billConfig` (no migration; older bills read as
shared). The bill page edits the count and price directly, through the same
session fields the summary page edits.
```

Also change the sentence "Three models, chosen per session" is left as is (the switch is not a fourth model). Do not edit the Early checkout section.

- [ ] **Step 2: Write the 50-player e2e**

Create `server/test/shuttle-full-charge.e2e-spec.ts`. It boots the real app exactly as `server/test/app.e2e-spec.ts` does (same `SESSION_SECRET` / `AuthBootstrapService` overrides, a user seeded through `UsersService`, `cookieParser`, `ValidationPipe`), then:

1. Logs in, turns the group's shuttle tools on (`POST /groups/:code/shuttle-tools` with `{ enabled: true }`) *before* creating the session, parses a 50-name roster (`POST /groups/:code/parse`, names `ผู้เล่น01`..`ผู้เล่น50`) and creates one session with 6 courts from the parse result (`decision: 'accept'` for every row), as the dashboard e2e does.
2. Plays 8 rounds: `POST /sessions/:code/courts/fill`, `GET /sessions/:code`, confirm each pending court with `{ expectedRevision, shuttle }` where `shuttle` is `{ kind: 'new' }` in rounds 1-4, and in rounds 5-8 `{ kind: 'existing', shuttleId }` using that court's entry from `GET /sessions/:code/shuttles` (`lastShuttleByCourt`) when it exists, else `{ kind: 'new' }`; then finish every active court with `{ winner: 'A', expectedRevision }`. This mixes new and reused shuttles.
3. Saves the bill config through the route: `model: 'perShuttle'`, `shuttleCharge: 'full'`, `perPlayerShuttleSatang: 2000`, `startingFeeSatang: 1000`, `hostFeeSatang: 0`, `roundingBaht: 1`, `courtFeeSatang: 60000`, other fields as the `bill.controller.spec.ts` `cfg()` helper, and sets the real price with `POST /sessions/:code/shuttle-details` `{ shuttlePriceSatang: 8000 }`.
4. Computes the oracle **from the database only**: read every `Pairing` (finished) with its `PairingShuttleUse` rows for the session; for each player the expected amount is `1000 + (distinct shuttleIds across their pairings) x 2000`. Assert `GET /sessions/:code/bill` returns exactly that amount for each of the 50 players, that every player appears, and that at least one player has a reused shuttle (a distinct-shuttle count lower than their game count) so the dedupe is really exercised.
5. Margin: `totals.costSatang === 60000 + physicalOrEffectiveCount x 8000`, `totals.marginSatang === totals.collectedSatang - totals.costSatang`, and `totals.collectedSatang` equals the sum of the 50 amounts.
6. Flips `shuttleCharge` to `shared` through the route and asserts the 50 amounts change but still sum to at least the recorded shuttle cost; flips back and asserts the original amounts return.
7. Early checkout: quote one player via `POST /sessions/:code/checkouts/:playerId/preview` `{ model: 'perShuttle' }`; assert `shuttleCharge === 'full'`, `chargeSatang === 2000`, and `amountSatang` equals that player's oracle amount. Settle them, then re-read the bill and assert the other 49 players' amounts are unchanged.
8. Cleans up the rows it created in `afterAll` in dependency order (`pairingShuttleUse`, `pairing`, `sessionShuttle`, `sessionCheckout`, `sessionRoster`, `waitlist`, `sessionCreation`, `session`, `player`, `group`, `user`).

Time limits: 180 s for the playing test, 60 s for the others.

- [ ] **Step 3: Run it**

Run: `cd server && npx vitest run --config ./vitest.config.e2e.ts test/shuttle-full-charge.e2e-spec.ts`
Expected: PASS. If a request shape differs from the sketch above (for example the confirm body or the `shuttles` read), fix the e2e to the real shape from `sessions.controller.ts` / `shuttle.model.ts`; do not change production code to fit the test.

- [ ] **Step 4: Full verification**

Run: `npm test` (repo root), then `cd server && npm run lint && npm run test:e2e`, then `cd web && npx ng build`.
Expected: all suites PASS, lint clean, both locales build.

- [ ] **Step 5: Commit**

```bash
git add docs server/test
git commit -m "docs+test: document the shuttle charge switch and run it with 50 players

Claude-Session: https://claude.ai/code/session_01148QYqWg8vZoaZsf9midX4"
```
