import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBill,
  splitEqual,
  splitByWeight,
  distributeCapped,
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
  // The pool is split in whole rounding steps (1 baht = 100 satang here), not
  // raw satang, so the discount can never be swallowed by per-person rounding.
  // Fee 2000 = 20 steps; pool 20 steps over 3 billed players (caps 100, 100,
  // 120 steps) -> 7, 7, 6 (remainder to the first ids) -> 700, 700, 600.
  const discount = Object.fromEntries(r.rows.map((x) => [x.playerId, x.walkInDiscountSatang]));
  assert.deepEqual(discount, { a: 700, b: 700, c: 600 });
  // 10000 - 700; 10000 - 700; 10000 - 600 + 2000 -- total 30000, unchanged.
  assert.deepEqual(amounts(r), { a: 9300, b: 9300, c: 11400 });
  assert.equal(r.totals.collectedSatang, 30000);
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
  // d's court share 6666 (5000 + a third of removed b's 5000) ceils to 6700
  // first; then - discount 1000 + fee 2000 = 7700. c: 6667 -> 6700 - 1000 = 5700.
  assert.equal(rows['d'].amountSatang, 7700);
  assert.equal(rows['c'].amountSatang, 5700);
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

test('walk-in: rounding happens before the fee and discount, which move in whole steps', () => {
  const r = computeBill(walkIn({ model: 'fair', courtFeeSatang: 20000, roundingBaht: 10, walkInFeeSatang: 1500 }, ['d']));
  // step 1000. Each plain share 5000 is already whole -> rounded 5000.
  // The 1500 fee rounds up to 2 steps = 2000 actually charged. Pool 2 steps
  // over caps [5, 5, 5, 7] -> splitEqual(2, 4) = [1, 1, 0, 0] -> a and b get
  // 1000 off. a 4000, b 4000, c 5000, d 5000 + 2000 = 7000; total 20000, the
  // same as with no walk-in (rounding after the discount used to give 22000).
  assert.deepEqual(amounts(r), { a: 4000, b: 4000, c: 5000, d: 7000 });
  assert.equal(r.rows.find((x) => x.playerId === 'd')!.walkInFeeSatang, 2000);
  assert.equal(r.totals.collectedSatang, 20000);
});

test('walk-in: total is invariant even when the pool does not divide evenly into the rounding step', () => {
  // a2 b1 c1; court 31000 split equally -> 10334, 10333, 10333; step 500.
  const matches = [m('a', 'b'), m('a', 'c')];
  const base: Partial<BillConfig> = { model: 'fair', courtFeeSatang: 31000, roundingBaht: 5 };
  const without = computeBill(walkIn(base, [], { matches }));
  const withW = computeBill(walkIn(base, ['c'], { matches }));
  // Without: every share ceils to 10500 -> 31500.
  assert.deepEqual(amounts(without), { a: 10500, b: 10500, c: 10500 });
  // With c: fee 2000 = 4 steps; pool 4 steps over caps [21, 21, 25] -> [2, 1, 1]
  // -> a 10500 - 1000, b 10500 - 500, c 10500 - 500 + 2000. Still 31500
  // (rounding after the discount used to give 10000, 10000, 12000 = 32000).
  assert.deepEqual(amounts(withW), { a: 9500, b: 10000, c: 12000 });
  assert.equal(withW.totals.collectedSatang, without.totals.collectedSatang);

  // The review's reproduction: buffet 100 baht, 3 players, 1 walk-in, step 10
  // baht. Used to bill 100/100/120 = 320; now fee 2 steps over caps [10, 10, 12]
  // -> [1, 1, 0] -> 90/90/120 = 300.
  const buffet = computeBill(
    walkIn({ model: 'buffet', buffetPriceSatang: 10000, roundingBaht: 10 }, ['c'], { matches })
  );
  assert.deepEqual(amounts(buffet), { a: 9000, b: 9000, c: 12000 });

  // The same property across rounding steps, fees that are not a multiple of
  // the step, and several walk-in sets.
  for (const roundingBaht of [1, 5, 10] as const) {
    for (const walkInFeeSatang of [2000, 1500, 333]) {
      for (const ids of [['a'], ['c'], ['b', 'c'], ['a', 'b', 'c']]) {
        const cfg = { ...base, roundingBaht, walkInFeeSatang };
        const plain = computeBill(walkIn(cfg, [], { matches })).totals.collectedSatang;
        const marked = computeBill(walkIn(cfg, ids, { matches })).totals.collectedSatang;
        assert.equal(marked, plain, `rounding ${roundingBaht}, fee ${walkInFeeSatang}, walk-ins ${ids}`);
      }
    }
  }
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

// ---- Reusable numbered shuttles (host feedback D): each identity's cost is shared once ----

const adv = (players: string[], shuttleIds: string[] | null): BillMatch => ({ players, shuttleIds });
/** Shuttles billed on their own: buffet with no price and shuttles not included. */
function shuttleOnly(extra: Partial<BillInput>, config: Partial<BillConfig> = {}): BillInput {
  return {
    config: { ...DEFAULT_BILL_CONFIG, walkInFeeSatang: 0, model: 'buffet', buffetPriceSatang: 0, buffetShuttlesIncluded: false, shuttleSplit: 'byGames', ...config },
    matches: [],
    walkInIds: [],
    shuttleCount: 1,
    shuttlePriceSatang: 100,
    shuttleAllocation: 'identities',
    ...extra,
  };
}
const shuttleShares = (r: ReturnType<typeof computeBill>) =>
  Object.fromEntries(r.rows.filter((x) => x.status === 'billed').map((x) => [x.playerId, x.shuttleSatang]));

test('shuttles: one shuttle used by two disjoint doubles games is paid once, half per game', () => {
  const r = computeBill(shuttleOnly({ matches: [adv(['a', 'b', 'c', 'd'], ['s1']), adv(['e', 'f', 'g', 'h'], ['s1'])] }));
  assert.deepEqual(shuttleShares(r), { a: 13, b: 13, c: 12, d: 12, e: 13, f: 13, g: 12, h: 12 });
  assert.equal(r.rows.reduce((t, x) => t + x.shuttleSatang, 0), 100);
  assert.equal(r.shuttleAllocation, 'identities');
});

test('shuttles: a corrupt duplicate id inside one game is rejected', () => {
  assert.throws(() => computeBill(shuttleOnly({ matches: [adv(['a', 'b', 'c', 'd'], ['s1', 's1'])] })), /duplicate/);
  assert.throws(() => computeBill(shuttleOnly({ matches: [adv(['a', 'b'], [''])] })), /empty id/);
});

test('shuttles: one price per unique identity across a singles and a doubles game, exact satang', () => {
  const r = computeBill(
    shuttleOnly({
      matches: [adv(['a', 'b'], ['s1', 's2']), adv(['a', 'c', 'd', 'e'], ['s1'])],
      shuttleCount: 2,
      shuttlePriceSatang: 300,
    })
  );
  // 600 over s1/s2 = 300 each. s2: 150+150 to a,b. s1: 150 per game: singles 75+75, doubles 38,38,37,37.
  assert.deepEqual(shuttleShares(r), { a: 263, b: 225, c: 38, d: 37, e: 37 });
  assert.equal(r.rows.reduce((t, x) => t + x.shuttleSatang, 0), 600);
});

test('shuttles: a physical count above the logged ids scales the money, never the ids', () => {
  const matches = [adv(['a', 'b', 'c', 'd'], ['s1']), adv(['a', 'b', 'c', 'd'], ['s2'])];
  const four = computeBill(shuttleOnly({ matches, shuttleCount: 4, shuttlePriceSatang: 100 }));
  assert.deepEqual(shuttleShares(four), { a: 100, b: 100, c: 100, d: 100 });
  const zero = computeBill(shuttleOnly({ matches, shuttleCount: 0 }));
  assert.deepEqual(shuttleShares(zero), { a: 0, b: 0, c: 0, d: 0 });
  assert.equal(zero.shuttleAllocation, 'identities');
});

test('shuttles: equal split ignores identities and says so', () => {
  const r = computeBill(
    shuttleOnly({ matches: [adv(['a', 'b', 'c', 'd'], ['s1']), adv(['e', 'f', 'g', 'h'], ['s1'])], shuttleCount: 2, shuttlePriceSatang: 400 }, { shuttleSplit: 'equal' })
  );
  assert.deepEqual(shuttleShares(r), { a: 100, b: 100, c: 100, d: 100, e: 100, f: 100, g: 100, h: 100 });
  assert.equal(r.shuttleAllocation, 'equal');
});

test('shuttles: any unknown game keeps the old equal-per-match split for the whole session', () => {
  const r = computeBill(
    shuttleOnly({ matches: [adv(['a', 'b', 'c', 'd'], ['s1']), adv(['e', 'f', 'g', 'h'], null)], shuttleCount: 2, shuttlePriceSatang: 100 })
  );
  assert.deepEqual(shuttleShares(r), { a: 25, b: 25, c: 25, d: 25, e: 25, f: 25, g: 25, h: 25 });
  assert.equal(r.shuttleAllocation, 'legacy-unknown');
});

test('shuttles: known games with no references and a positive cost fall back to equal-per-match', () => {
  const noUses = computeBill(shuttleOnly({ matches: [adv(['a', 'b', 'c', 'd'], []), adv(['e', 'f', 'g', 'h'], [])], shuttleCount: 2, shuttlePriceSatang: 100 }));
  assert.deepEqual(shuttleShares(noUses), { a: 25, b: 25, c: 25, d: 25, e: 25, f: 25, g: 25, h: 25 });
  assert.equal(noUses.shuttleAllocation, 'legacy-no-uses');
  const free = computeBill(shuttleOnly({ matches: [adv(['a', 'b', 'c', 'd'], [])], shuttleCount: 0 }));
  assert.equal(free.shuttleAllocation, 'identities');
});

test('shuttles: a removed player\'s share is redistributed so the cost stays covered', () => {
  const r = computeBill(
    shuttleOnly(
      { matches: [adv(['a', 'b', 'c', 'd'], ['s1']), adv(['e', 'f', 'g', 'h'], ['s1'])] },
      { removedIds: ['a'] }
    )
  );
  assert.equal(r.rows.filter((x) => x.status === 'billed').reduce((t, x) => t + x.shuttleSatang, 0), 100);
  assert.equal(r.rows.find((x) => x.playerId === 'a')!.shuttleSatang, 0);
});

test('shuttles: the walk-in fee still nets to zero with identity allocation', () => {
  const base = shuttleOnly({ matches: [adv(['a', 'b', 'c', 'd'], ['s1'])], shuttleCount: 1, shuttlePriceSatang: 10000 });
  const plain = computeBill(base);
  const walk = computeBill({ ...base, walkInIds: ['d'], config: { ...base.config, walkInFeeSatang: 1000 } });
  assert.equal(walk.totals.collectedSatang, plain.totals.collectedSatang);
  assert.equal(plain.totals.collectedSatang, 10000);
});

test('shuttles: ordinary input is untouched and reports the legacy path', () => {
  const r = computeBill(input({ model: 'fair', courtFeeSatang: 0, courtSplit: 'equal', shuttleSplit: 'byGames' }, { shuttleCount: 3, shuttlePriceSatang: 4000 }));
  assert.deepEqual(
    Object.fromEntries(r.rows.map((x) => [x.playerId, x.shuttleSatang])),
    { a: 3000, b: 3000, c: 2000, d: 2000, e: 2000 }
  );
  assert.equal(r.shuttleAllocation, 'legacy-basic');
});

// ---- perShuttle: the advanced fourth model (host feedback E) ----

test('perShuttle: no shuttles recorded, every billed participant pays the starting fee', () => {
  const r = computeBill(input({ model: 'perShuttle', startingFeeSatang: 5000 }));
  assert.deepEqual(amounts(r), { a: 5000, b: 5000, c: 5000, d: 5000, e: 5000 });
  assert.deepEqual(r.warnings, []);
});

test('perShuttle: a removed player is not billed and the others still pay only their own fee', () => {
  const r = computeBill(input({ model: 'perShuttle', startingFeeSatang: 5000, removedIds: ['a'] }));
  assert.deepEqual(amounts(r), { b: 5000, c: 5000, d: 5000, e: 5000 });
});

test('startingFeeSatang must be a non-negative whole number of satang', () => {
  assert.throws(() => computeBill(input({ model: 'perShuttle', startingFeeSatang: -1 })), /startingFeeSatang/);
  assert.throws(() => computeBill(input({ model: 'perShuttle', startingFeeSatang: 10.5 })), /startingFeeSatang/);
});

test('the default config carries a zero starting fee and existing models ignore it', () => {
  assert.equal(DEFAULT_BILL_CONFIG.startingFeeSatang, 0);
  const withFee = computeBill(input({ model: 'perGame', perGameRateSatang: 1000, startingFeeSatang: 9999 }));
  const without = computeBill(input({ model: 'perGame', perGameRateSatang: 1000 }));
  assert.deepEqual(amounts(withFee), amounts(without));
});

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
